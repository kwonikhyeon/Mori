package hc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func openFake(t *testing.T) (*Conn, *fakeCore) {
	t.Helper()
	f := newFakeCore(t)
	go f.handshake()
	c, err := Open(context.Background(), f.client)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c, f
}

func TestCallResultAndError(t *testing.T) {
	c, f := openFake(t)
	if h := c.Hello(); h.Core.Name != "fake" || h.Generation != 1 || !h.Framed {
		t.Fatalf("hello %+v", h)
	}
	go func() {
		id, m, params := f.readCall()
		if m != "terminal.get" || string(params) != `{"terminal":"t1"}` {
			t.Errorf("call %s %s", m, params)
		}
		f.send(reply(id, `{"address":"t1","state":"live","title":"hi","pid":42}`))
		id, _, _ = f.readCall()
		f.send(replyError(id, -32000, "not_found", "no t9"))
		id, _, _ = f.readCall()
		f.send(Frame{Kind: KindData, Payload: []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"error":{"code":-32602,"message":"bad"}}`, id))})
	}()
	var term Terminal
	if err := c.Call(context.Background(), "terminal.get", map[string]any{"terminal": "t1"}, &term); err != nil {
		t.Fatal(err)
	}
	if term.Address != "t1" || term.Title != "hi" || term.Pid == nil || *term.Pid != 42 || term.ExitCode != nil {
		t.Fatalf("%+v", term)
	}
	err := c.Call(context.Background(), "terminal.get", map[string]any{"terminal": "t9"}, nil)
	if KindOf(err) != "not_found" || HintOf(err) != "hc ls" {
		t.Fatal(err)
	}
	if err := c.Call(context.Background(), "x", nil, nil); KindOf(err) != "invalid_params" {
		t.Fatal(err)
	}
}

func TestCallsRunSideBySide(t *testing.T) {
	c, f := openFake(t)
	go func() { // take both calls, then answer them in reverse order
		a, _, _ := f.readCall()
		b, _, _ := f.readCall()
		f.send(reply(b, `"second"`), reply(a, `"first"`))
	}()
	var wg sync.WaitGroup
	got := make([]string, 2)
	for i := range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); c.Call(context.Background(), "x", nil, &got[i]) }()
		time.Sleep(20 * time.Millisecond) // fix the order the calls go out
	}
	wg.Wait()
	if got[0] != "first" || got[1] != "second" {
		t.Fatal(got)
	}
}

func TestConnClosedFailsPendingCalls(t *testing.T) {
	c, f := openFake(t)
	go func() { f.readCall(); f.w.Close() }()
	err := c.Call(context.Background(), "x", nil, nil)
	if !errors.Is(err, ErrClosed) || KindOf(err) != "core_unavailable" {
		t.Fatal(err)
	}
	<-c.Done()
	if err := c.Call(context.Background(), "x", nil, nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("call after close: %v", err)
	}
}

func TestCallContextCancel(t *testing.T) {
	c, f := openFake(t)
	go f.readCall()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := c.Call(ctx, "x", nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}

func TestOpenFailsOnHelloError(t *testing.T) {
	f := newFakeCore(t)
	go func() {
		f.r.ReadBytes('\n')
		fmt.Fprintln(f.w, `{"jsonrpc":"2.0","id":0,"error":{"code":-32000,"message":"generation 1 not spoken","data":{"kind":"unsupported"}}}`)
	}()
	_, err := Open(context.Background(), f.client)
	if KindOf(err) != "unsupported" {
		t.Fatal(err)
	}
}

func TestOpenHonorsContext(t *testing.T) {
	f := newFakeCore(t) // never answers
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := Open(ctx, f.client); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}

type nopSink struct{}

func (nopSink) data([]byte)          {}
func (nopSink) resize(int, int)      {}
func (nopSink) closed([]byte, error) {}

// A caller that gives up on an attach must not leave the channel open.
func TestAbandonedOpenClosesLateChannel(t *testing.T) {
	c, f := openFake(t)
	ids := make(chan int64, 1)
	go func() { id, _, _ := f.readCall(); ids <- id }()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()
	_, err := c.call(ctx, "terminal.attach", nil, func(uint32) sink { return nopSink{} })
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	f.send(reply(<-ids, `{"channel":9}`))
	if fr := f.readFrame(); fr.Channel != 9 || fr.Kind != KindClose {
		t.Fatalf("%+v", fr)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.sinks) != 0 || len(c.pending) != 0 {
		t.Fatalf("leaked sinks %v pending %v", c.sinks, c.pending)
	}
}

func TestErrorDataTolerated(t *testing.T) {
	var m message
	if err := json.Unmarshal([]byte(`{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"x","data":"text"}}`), &m); err != nil {
		t.Fatal(err)
	}
	if m.Error == nil || m.Error.Data.Kind != "" || KindOf(m.Error) != "internal" {
		t.Fatalf("%+v", m.Error)
	}
}
