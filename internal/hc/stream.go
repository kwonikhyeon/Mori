package hc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"
)

// ErrDetached is what a stream reports after its own Close.
var ErrDetached = errors.New("hc: stream detached")

// ClosedError reports that the core ended a stream: the program finished,
// or the terminal was lost or removed. Reason says which.
type ClosedError struct{ CloseReason }

func (e *ClosedError) Error() string {
	s := "hc: stream closed by core"
	if e.Reason != "" {
		s += ": " + e.Reason
	}
	if e.ExitCode != nil {
		s += fmt.Sprintf(" (exit code %d)", *e.ExitCode)
	}
	if e.Signal != nil {
		s += fmt.Sprintf(" (signal %d)", *e.Signal)
	}
	return s
}

const (
	maxWrite   = 1 << 20         // input goes out in DATA frames of at most this size
	coalesce   = 64 << 10        // queued output is joined into chunks up to this size
	maxBacklog = 32 << 20        // more unread than this means the core ignores credit
	closeWait  = 2 * time.Second // how long Close waits for the core's CLOSE
)

// endpoint is what Stream and Events share: a channel on a Conn whose end
// is recorded once and reported after what was queued before it.
type endpoint struct {
	c       *Conn
	ch      uint32
	drop    func() // lets go of what is queued; runs with mu held
	mu      sync.Mutex
	signal  chan struct{} // cap 1: new input, or the end
	done    chan struct{}
	err     error // why the channel ended; set once
	closing bool  // we sent CLOSE
}

func (e *endpoint) init(c *Conn, ch uint32, drop func()) {
	e.c, e.ch, e.drop = c, ch, drop
	e.signal = make(chan struct{}, 1)
	e.done = make(chan struct{})
}

// Channel is the frame channel the core assigned.
func (e *endpoint) Channel() uint32 { return e.ch }

// Done is closed when the channel has ended.
func (e *endpoint) Done() <-chan struct{} { return e.done }

func (e *endpoint) wake() {
	select {
	case e.signal <- struct{}{}:
	default:
	}
}

// endLocked records the end; the first reason wins. e.mu must be held.
func (e *endpoint) endLocked(err error) {
	if e.err == nil {
		e.err = err
		close(e.done)
	}
}

// closed is the read loop telling us the core sent CLOSE (reason) or the
// connection is gone (err).
func (e *endpoint) closed(reason []byte, err error) {
	e.mu.Lock()
	switch {
	case err != nil:
	case e.closing:
		err = ErrDetached
	default:
		ce := &ClosedError{}
		if len(reason) > 0 {
			json.Unmarshal(reason, &ce.CloseReason) // an unreadable reason still ends the stream
		}
		err = ce
	}
	e.endLocked(err)
	e.mu.Unlock()
	e.wake()
}

// abort ends the channel from our side without waiting: drop what is
// queued, forget the channel and ask the core to close it. Safe to call
// from the read loop.
func (e *endpoint) abort(err error) {
	e.mu.Lock()
	e.drop()
	open := e.err == nil && !e.closing
	e.endLocked(err)
	e.mu.Unlock()
	e.wake()
	if open {
		e.c.unregister(e.ch)
		go e.c.writeFrame(Frame{Channel: e.ch, Kind: KindClose})
	}
}

// send writes one frame on the channel while it is open.
func (e *endpoint) send(kind byte, payload []byte) error {
	e.mu.Lock()
	err := e.err
	if e.closing {
		err = ErrDetached
	}
	e.mu.Unlock()
	if err != nil {
		return err
	}
	return e.c.writeFrame(Frame{Channel: e.ch, Kind: kind, Payload: payload})
}

func (e *endpoint) credit(n int) error {
	if n <= 0 {
		return nil
	}
	v := uint32(math.MaxUint32)
	if uint64(n) < math.MaxUint32 {
		v = uint32(n)
	}
	return e.send(KindCredit, u32(v))
}

// detach drops what is queued, sends CLOSE and waits for the core's
// answer, at most closeWait.
func (e *endpoint) detach() {
	e.mu.Lock()
	e.drop()
	if e.err != nil || e.closing {
		e.mu.Unlock()
		return
	}
	e.closing = true
	e.mu.Unlock()
	e.wake()
	if e.c.writeFrame(Frame{Channel: e.ch, Kind: KindClose}) == nil {
		select {
		case <-e.done:
			return
		case <-time.After(closeWait):
		}
	}
	e.c.unregister(e.ch)
	e.closed(nil, ErrDetached)
}

// AttachParams are terminal.attach's parameters.
type AttachParams struct {
	Terminal            string   `json:"terminal"`
	Cols                int      `json:"cols"`
	Rows                int      `json:"rows"`
	History             int      `json:"history,omitempty"` // scrollback lines to paint first
	Observe             bool     `json:"observe,omitempty"` // watch only: never type or resize
	Resumed             bool     `json:"resumed,omitempty"` // back after a dropped line
	ResizeNotifications bool     `json:"resize_notifications,omitempty"`
	Display             *Display `json:"display,omitempty"`
}

// AttachResult is terminal.attach's reply.
type AttachResult struct {
	Channel             uint32   `json:"channel"`
	Terminal            Terminal `json:"terminal"`
	ResizeNotifications bool     `json:"resize_notifications"`
	AutomaticInput      bool     `json:"automatic_input"`
}

// StreamMsg is one piece of an attached terminal's output: bytes, or (with
// resize_notifications) the new size that comes before a repaint.
type StreamMsg struct {
	Data []byte
	Size *Size
}

// Stream is an attached terminal: the first paint, then live output. The
// core sends InitialCredit bytes, then only as much as Credit allows. Recv
// is for one reader; the other methods can be called from anywhere.
type Stream struct {
	endpoint
	q      []StreamMsg
	queued int // bytes in q
}

// Attach opens a stream on a terminal. Output that follows the reply
// straight away, such as the first paint, is never lost.
func (c *Conn) Attach(ctx context.Context, p AttachParams) (*Stream, AttachResult, error) {
	var s *Stream
	m, err := c.call(ctx, "terminal.attach", p, func(ch uint32) sink {
		s = &Stream{}
		s.init(c, ch, func() { s.q, s.queued = nil, 0 })
		return s
	})
	if err != nil {
		return nil, AttachResult{}, err
	}
	var res AttachResult
	if err := json.Unmarshal(m.Result, &res); err != nil || s == nil {
		if s != nil {
			s.Close()
		}
		if err == nil {
			err = errors.New("no channel in reply")
		}
		return nil, AttachResult{}, fmt.Errorf("hc: terminal.attach: %w", err)
	}
	return s, res, nil
}

func (s *Stream) data(p []byte) {
	s.mu.Lock()
	if s.err != nil || s.closing {
		s.mu.Unlock()
		return
	}
	if n := len(s.q); n > 0 && s.q[n-1].Size == nil && len(s.q[n-1].Data) < coalesce {
		s.q[n-1].Data = append(s.q[n-1].Data, p...)
	} else {
		s.q = append(s.q, StreamMsg{Data: p})
	}
	s.queued += len(p)
	over := s.queued > maxBacklog
	s.mu.Unlock()
	if over {
		s.abort(errors.New("hc: stream backlog exceeded"))
		return
	}
	s.wake()
}

func (s *Stream) resize(cols, rows int) {
	s.mu.Lock()
	if s.err == nil && !s.closing {
		size := &Size{Cols: cols, Rows: rows}
		if n := len(s.q); n > 0 && s.q[n-1].Size != nil {
			s.q[n-1].Size = size // only the size before the repaint matters
		} else {
			s.q = append(s.q, StreamMsg{Size: size})
		}
	}
	s.mu.Unlock()
	s.wake()
}

// Recv returns the next output. Once the stream has ended it first returns
// what was queued, then why: *ClosedError, an error wrapping ErrClosed, or
// ErrDetached.
func (s *Stream) Recv(ctx context.Context) (StreamMsg, error) {
	for {
		s.mu.Lock()
		if s.closing {
			s.mu.Unlock()
			return StreamMsg{}, ErrDetached
		}
		if len(s.q) > 0 {
			m := s.q[0]
			s.q[0] = StreamMsg{}
			s.q = s.q[1:]
			s.queued -= len(m.Data)
			s.mu.Unlock()
			return m, nil
		}
		err := s.err
		s.mu.Unlock()
		if err != nil {
			return StreamMsg{}, err
		}
		select {
		case <-s.signal:
		case <-ctx.Done():
			return StreamMsg{}, ctx.Err()
		}
	}
}

// Credit lets the core send n more bytes. Call it as output is consumed.
func (s *Stream) Credit(n int) error { return s.credit(n) }

// Write types p into the terminal.
func (s *Stream) Write(p []byte) (int, error) { return s.write(KindData, p) }

// WriteAutomatic passes p, which the viewer's terminal typed by itself (a
// reply to a query, a focus or mouse-motion report), as AUTOMATIC_INPUT:
// the program gets it, and the core does not count it as a person typing,
// so terminal.send and terminal.keys need not wait for it to stop. Only
// where AttachResult.AutomaticInput says the path takes it.
func (s *Stream) WriteAutomatic(p []byte) (int, error) { return s.write(KindAutomaticInput, p) }

func (s *Stream) write(kind byte, p []byte) (int, error) {
	n := 0
	for len(p) > 0 {
		k := min(len(p), maxWrite)
		if err := s.send(kind, p[:k]); err != nil {
			return n, err
		}
		n += k
		p = p[k:]
	}
	return n, nil
}

// Resize reports the viewer's size in cells.
func (s *Stream) Resize(cols, rows int) error {
	if cols < 1 || rows < 1 || cols > math.MaxUint16 || rows > math.MaxUint16 {
		return fmt.Errorf("hc: size %dx%d out of range", cols, rows)
	}
	return s.send(KindResize, sizePayload(cols, rows))
}

// Focus reports whether the viewer has focus.
func (s *Stream) Focus(focused bool) error {
	b := byte(0)
	if focused {
		b = 1
	}
	return s.send(KindFocus, []byte{b})
}

// Facts reports the viewer's colors and cell size, which the core uses to
// answer the program's display queries.
func (s *Stream) Facts(d Display) error {
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	return s.send(KindFacts, b)
}

// Close detaches; the terminal keeps running. It waits up to two seconds
// for the core to confirm and drops output not yet read.
func (s *Stream) Close() error {
	s.detach()
	return nil
}
