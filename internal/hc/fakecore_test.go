package hc

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"testing"
)

// bufPipe is an in-memory pipe whose writes never block, so a test can
// write several frames before the other side reads.
type bufPipe struct {
	mu     sync.Mutex
	cond   *sync.Cond
	buf    bytes.Buffer
	closed bool
}

func newBufPipe() *bufPipe {
	p := &bufPipe{}
	p.cond = sync.NewCond(&p.mu)
	return p
}

func (p *bufPipe) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return 0, io.ErrClosedPipe
	}
	p.buf.Write(b)
	p.cond.Broadcast()
	return len(b), nil
}

func (p *bufPipe) Read(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for p.buf.Len() == 0 && !p.closed {
		p.cond.Wait()
	}
	if p.buf.Len() == 0 {
		return 0, io.EOF
	}
	return p.buf.Read(b)
}

func (p *bufPipe) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	p.cond.Broadcast()
	return nil
}

type closerFunc func() error

func (f closerFunc) Close() error { return f() }

// fakeCore plays the core's side of a connection.
type fakeCore struct {
	t      *testing.T
	client io.ReadWriteCloser // what Open gets
	r      *bufio.Reader      // what the client wrote
	w      io.WriteCloser     // to the client
	wmu    sync.Mutex
}

func newFakeCore(t *testing.T) *fakeCore {
	toClient, toCore := newBufPipe(), newBufPipe()
	f := &fakeCore{t: t, r: bufio.NewReader(toCore), w: toClient}
	f.client = struct {
		io.Reader
		io.Writer
		io.Closer
	}{toClient, toCore, closerFunc(func() error { toCore.Close(); toClient.Close(); return nil })}
	t.Cleanup(func() { toClient.Close(); toCore.Close() })
	return f
}

// handshake answers the plain-mode hello and switches to frames.
func (f *fakeCore) handshake() {
	line, err := f.r.ReadBytes('\n')
	if err != nil {
		f.t.Error(err)
		return
	}
	var req struct {
		ID     int64
		Method string
		Params map[string]any
	}
	json.Unmarshal(line, &req)
	if req.Method != "hello" || req.Params["framed"] != true || req.Params["generation"] != float64(1) {
		f.t.Errorf("hello %s", line)
	}
	fmt.Fprintf(f.w, `{"jsonrpc":"2.0","id":%d,"result":{"version":"0.1.19","generation":1,"framed":true,"features":["framed","attach","events"],"methods":[],"core":{"id":"c1","name":"fake"}}}`+"\n", req.ID)
}

// readFrame reads the next frame the client sent. It is safe to call from
// any goroutine: failures are reported with Errorf.
func (f *fakeCore) readFrame() Frame {
	fr, err := ReadFrame(f.r)
	if err != nil {
		f.t.Errorf("readFrame: %v", err)
	}
	return fr
}

// readCall reads frames until a JSON-RPC request arrives on channel 0.
func (f *fakeCore) readCall() (id int64, method string, params json.RawMessage) {
	for {
		fr, err := ReadFrame(f.r)
		if err != nil {
			f.t.Errorf("readCall: %v", err)
			return
		}
		if fr.Channel != 0 || fr.Kind != KindData {
			continue
		}
		var m struct {
			ID     *int64
			Method string
			Params json.RawMessage
		}
		if err := json.Unmarshal(fr.Payload, &m); err != nil {
			f.t.Errorf("readCall: %v in %s", err, fr.Payload)
			return
		}
		if m.ID != nil && m.Method != "" {
			return *m.ID, m.Method, m.Params
		}
	}
}

// send writes all frames with one Write, the way the core puts a reply and
// the first stream frame in the same buffer.
func (f *fakeCore) send(frames ...Frame) {
	f.wmu.Lock()
	defer f.wmu.Unlock()
	var b []byte
	for _, fr := range frames {
		b = AppendFrame(b, fr)
	}
	f.w.Write(b)
}

func reply(id int64, result string) Frame {
	return Frame{Kind: KindData, Payload: []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":%s}`, id, result))}
}

func replyError(id int64, code int, kind, msg string) Frame {
	return Frame{Kind: KindData, Payload: []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","id":%d,"error":{"code":%d,"message":%q,"data":{"kind":%q,"hint":"hc ls"}}}`, id, code, msg, kind))}
}
