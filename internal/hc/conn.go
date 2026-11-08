package hc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// sink receives the frames of one open channel. The read loop calls it and
// must never block on it.
type sink interface {
	data(p []byte)
	resize(cols, rows int)
	closed(reason []byte, err error) // reason: the core's CLOSE payload; err: the connection failed
}

// pending is a call waiting for its reply.
type pending struct {
	ch        chan *message             // buffered 1
	open      func(channel uint32) sink // set for calls that open a channel; runs with Conn.mu held
	abandoned bool                      // the caller gave up; close what the reply opens
}

// Conn is one framed connection to a core. Calls run side by side.
type Conn struct {
	rw     io.ReadWriteCloser
	br     *bufio.Reader
	hello  HelloResult
	nextID atomic.Int64

	wmu sync.Mutex // one frame per Write

	mu      sync.Mutex
	pending map[int64]*pending
	sinks   map[uint32]sink
	err     error

	done     chan struct{} // closed once the connection has failed or been closed
	loopDone chan struct{}
}

// Open says hello in plain mode, asks for framed mode, and starts reading
// frames. When ctx ends before the reply, rw is closed.
func Open(ctx context.Context, rw io.ReadWriteCloser) (*Conn, error) {
	c := &Conn{
		rw:       rw,
		br:       bufio.NewReaderSize(rw, 64<<10),
		pending:  map[int64]*pending{},
		sinks:    map[uint32]sink{},
		done:     make(chan struct{}),
		loopDone: make(chan struct{}),
	}
	stop := context.AfterFunc(ctx, func() { rw.Close() })
	hello, err := c.handshake()
	if !stop() {
		rw.Close()
		return nil, ctx.Err()
	}
	if err != nil {
		rw.Close()
		return nil, err
	}
	c.hello = hello
	go c.readLoop()
	return c, nil
}

func (c *Conn) handshake() (HelloResult, error) {
	const req = `{"jsonrpc":"2.0","id":0,"method":"hello","params":{"generation":1,"framed":true}}` + "\n"
	if _, err := io.WriteString(c.rw, req); err != nil {
		return HelloResult{}, fmt.Errorf("hc: hello: %w", err)
	}
	for {
		line, err := c.br.ReadBytes('\n')
		if err != nil {
			return HelloResult{}, fmt.Errorf("hc: hello: %w", err)
		}
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var m message
		if err := json.Unmarshal(line, &m); err != nil {
			return HelloResult{}, fmt.Errorf("hc: hello: unexpected reply %.200q", line)
		}
		if m.ID == nil || *m.ID != 0 {
			continue // a notification ahead of the reply
		}
		if m.Error != nil {
			return HelloResult{}, m.Error
		}
		var h HelloResult
		if err := json.Unmarshal(m.Result, &h); err != nil {
			return HelloResult{}, fmt.Errorf("hc: hello: %w", err)
		}
		if !h.Framed {
			return HelloResult{}, errors.New("hc: hello: the core did not switch to framed mode")
		}
		return h, nil
	}
}

// Hello is the core's reply to hello.
func (c *Conn) Hello() HelloResult { return c.hello }

// Done is closed when the connection is gone.
func (c *Conn) Done() <-chan struct{} { return c.done }

// Err is why the connection is gone, wrapping ErrClosed, or nil while it is up.
func (c *Conn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// Close ends the connection and every open stream.
func (c *Conn) Close() error {
	c.fail(errors.New("closed by client"))
	select {
	case <-c.loopDone:
	case <-time.After(3 * time.Second):
	}
	return nil
}

// Call invokes method and decodes its result into result (when not nil).
// Errors from the core are *Error.
func (c *Conn) Call(ctx context.Context, method string, params, result any) error {
	m, err := c.call(ctx, method, params, nil)
	if err != nil {
		return err
	}
	if result != nil && len(m.Result) > 0 {
		if err := json.Unmarshal(m.Result, result); err != nil {
			return fmt.Errorf("hc: %s: decode result: %w", method, err)
		}
	}
	return nil
}

// call sends a request and waits for its reply. For calls that open a
// channel, open builds the sink; the read loop registers it before the
// reply is handed over, so frames right behind the reply are not lost.
func (c *Conn) call(ctx context.Context, method string, params any, open func(uint32) sink) (*message, error) {
	if params == nil {
		params = struct{}{}
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("hc: %s: encode params: %w", method, err)
	}
	id := c.nextID.Add(1)
	req, err := json.Marshal(message{JSONRPC: "2.0", ID: &id, Method: method, Params: raw})
	if err != nil {
		return nil, err
	}
	p := &pending{ch: make(chan *message, 1), open: open}
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return nil, err
	}
	c.pending[id] = p
	c.mu.Unlock()

	if err := c.writeFrame(Frame{Kind: KindData, Payload: req}); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}
	select {
	case m := <-p.ch:
		return replyOf(m)
	case <-c.done:
		select {
		case m := <-p.ch: // answered just before the connection went: the call happened
			return replyOf(m)
		default:
		}
		return nil, c.Err()
	case <-ctx.Done():
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case m := <-p.ch: // the reply won the race; use it
		return replyOf(m)
	default:
	}
	p.abandoned = true
	if open == nil {
		delete(c.pending, id)
	} // else keep it: the read loop closes the channel a late reply opens
	return nil, ctx.Err()
}

func replyOf(m *message) (*message, error) {
	if m.Error != nil {
		return nil, m.Error
	}
	return m, nil
}

// writeFrame writes f with a single Write so frames never interleave.
func (c *Conn) writeFrame(f Frame) error {
	buf := AppendFrame(make([]byte, 0, headerLen+len(f.Payload)), f)
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if err := c.Err(); err != nil {
		return err
	}
	if _, err := c.rw.Write(buf); err != nil {
		c.fail(fmt.Errorf("write: %w", err))
		return c.Err()
	}
	return nil
}

func (c *Conn) readLoop() {
	defer close(c.loopDone)
	for {
		f, err := ReadFrame(c.br)
		if err != nil {
			c.fail(err)
			return
		}
		c.dispatch(f)
	}
}

func (c *Conn) dispatch(f Frame) {
	if f.Channel == 0 {
		if f.Kind == KindData {
			c.handleReply(f.Payload)
		}
		return
	}
	c.mu.Lock()
	s := c.sinks[f.Channel]
	if s != nil && f.Kind == KindClose {
		delete(c.sinks, f.Channel)
	}
	c.mu.Unlock()
	if s == nil {
		return // a channel we closed or never opened
	}
	switch f.Kind {
	case KindData:
		s.data(f.Payload)
	case KindClose:
		s.closed(f.Payload, nil)
	case KindResize:
		if len(f.Payload) >= 4 {
			s.resize(int(binary.LittleEndian.Uint16(f.Payload)), int(binary.LittleEndian.Uint16(f.Payload[2:])))
		}
	}
	// The core's CREDIT frames are ignored: Mori's writes need none.
}

func (c *Conn) handleReply(b []byte) {
	var m message
	if json.Unmarshal(b, &m) != nil || m.ID == nil {
		return // framed mode sends no notifications on channel 0
	}
	var orphan uint32
	c.mu.Lock()
	p := c.pending[*m.ID]
	if p == nil {
		c.mu.Unlock()
		return
	}
	delete(c.pending, *m.ID)
	if p.open != nil && m.Error == nil {
		var r struct {
			Channel *uint32 `json:"channel"`
		}
		if json.Unmarshal(m.Result, &r) == nil && r.Channel != nil && *r.Channel != 0 {
			if p.abandoned {
				orphan = *r.Channel
			} else {
				c.sinks[*r.Channel] = p.open(*r.Channel)
			}
		}
	}
	if !p.abandoned {
		p.ch <- &m
	}
	c.mu.Unlock()
	if orphan != 0 {
		go c.writeFrame(Frame{Channel: orphan, Kind: KindClose})
	}
}

// fail ends the connection once: every waiting call and open stream gets
// an error wrapping ErrClosed.
func (c *Conn) fail(cause error) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return
	}
	c.err = fmt.Errorf("%w (%v)", ErrClosed, cause)
	sinks := c.sinks
	c.sinks = map[uint32]sink{}
	close(c.done)
	err := c.err
	c.mu.Unlock()
	for _, s := range sinks {
		s.closed(nil, err)
	}
	c.rw.Close()
}
