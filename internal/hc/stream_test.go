package hc

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

// attachFake attaches to t1 and has the fake core put the reply and first
// in one write, the way the core sends the first paint right after it.
func attachFake(t *testing.T, c *Conn, f *fakeCore, ch uint32, first ...Frame) *Stream {
	t.Helper()
	go func() {
		id, m, _ := f.readCall()
		if m != "terminal.attach" {
			t.Errorf("method %s", m)
		}
		res := fmt.Sprintf(`{"channel":%d,"terminal":{"address":"t1","state":"live","cols":80,"rows":24},"resize_notifications":false,"automatic_input":false}`, ch)
		f.send(append([]Frame{reply(id, res)}, first...)...)
	}()
	s, res, err := c.Attach(context.Background(), AttachParams{Terminal: "t1", Cols: 80, Rows: 24})
	if err != nil || res.Channel != ch || res.Terminal.Address != "t1" {
		t.Fatal(err, res)
	}
	return s
}

func recvData(t *testing.T, s *Stream) string {
	t.Helper()
	m, err := s.Recv(context.Background())
	if err != nil || m.Size != nil {
		t.Fatalf("%+v %v", m, err)
	}
	return string(m.Data)
}

func TestAttachFirstPaintNotLost(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5, Frame{5, KindData, []byte("PAINT")})
	if got := recvData(t, s); got != "PAINT" {
		t.Fatal(got)
	}
}

func TestStreamInputCreditResizeClose(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5)
	s.Write([]byte("ls\r"))
	s.Credit(0) // sends nothing
	s.Credit(1234)
	s.Resize(100, 30)
	s.Focus(true)
	s.Facts(Display{FG: "#ffffff"})
	want := []Frame{{5, KindData, []byte("ls\r")}, {5, KindCredit, []byte{0xd2, 0x04, 0, 0}},
		{5, KindResize, []byte{100, 0, 30, 0}}, {5, KindFocus, []byte{1}}, {5, KindFacts, []byte(`{"fg":"#ffffff"}`)}}
	for _, w := range want {
		got := f.readFrame()
		if got.Channel != w.Channel || got.Kind != w.Kind || !bytes.Equal(got.Payload, w.Payload) {
			t.Fatalf("got %+v want %+v", got, w)
		}
	}
	if err := s.Resize(0, 24); err == nil {
		t.Fatal("0 columns accepted")
	}
	f.send(Frame{5, KindData, []byte("bye")}, Frame{5, KindClose, []byte(`{"reason":"exited","exit_code":0,"signal":null}`)})
	if got := recvData(t, s); got != "bye" {
		t.Fatal("data before close must drain first:", got)
	}
	_, err := s.Recv(context.Background())
	var ce *ClosedError
	if !errors.As(err, &ce) || ce.Reason != "exited" || ce.ExitCode == nil || *ce.ExitCode != 0 || ce.Signal != nil {
		t.Fatal(err)
	}
	select {
	case <-s.Done():
	default:
		t.Fatal("Done not closed")
	}
	if _, err := s.Write([]byte("x")); !errors.As(err, &ce) {
		t.Fatal("write after close:", err)
	}
}

func TestStreamResizeNotification(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5)
	f.send(Frame{5, KindData, []byte("a")}, Frame{5, KindResize, sizePayload(100, 30)},
		Frame{5, KindResize, sizePayload(120, 40)}, Frame{5, KindData, []byte("b")},
		Frame{5, KindClose, []byte(`{"reason":"lost"}`)})
	<-s.Done() // all queued: sizes join only while both wait in the queue
	if got := recvData(t, s); got != "a" {
		t.Fatal(got)
	}
	m, err := s.Recv(context.Background())
	if err != nil || m.Size == nil || *m.Size != (Size{120, 40}) || m.Data != nil {
		t.Fatalf("%+v %v", m, err) // back-to-back sizes: only the last one
	}
	if got := recvData(t, s); got != "b" {
		t.Fatal(got)
	}
	var ce *ClosedError
	if _, err := s.Recv(context.Background()); !errors.As(err, &ce) || ce.Reason != "lost" || ce.ExitCode != nil {
		t.Fatal(err)
	}
}

func TestStreamJoinsSmallChunks(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5, Frame{5, KindData, []byte("a")}, Frame{5, KindData, []byte("b")}, Frame{5, KindData, []byte("c")},
		Frame{5, KindClose, []byte(`{"reason":"removed"}`)})
	<-s.Done() // all three are queued
	if got := recvData(t, s); got != "abc" {
		t.Fatal(got)
	}
}

func TestStalledStreamDoesNotBlockOthers(t *testing.T) { // Review Focus 1
	c, f := openFake(t)
	attachFake(t, c, f, 5) // nobody reads this one
	f.send(Frame{5, KindData, bytes.Repeat([]byte("x"), 200<<10)})
	s2 := attachFake(t, c, f, 6, Frame{6, KindData, []byte("ok")})
	if got := recvData(t, s2); got != "ok" {
		t.Fatal(got)
	}
	go func() { id, _, _ := f.readCall(); f.send(reply(id, `1`)) }()
	var n int
	if err := c.Call(context.Background(), "x", nil, &n); err != nil || n != 1 {
		t.Fatal(err)
	}
}

func TestStreamBacklogLimit(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5)
	mib := make([]byte, 1<<20)
	for range maxBacklog>>20 + 1 { // what the read loop would do for a core ignoring credit
		s.data(mib)
	}
	if _, err := s.Recv(context.Background()); err == nil || !strings.Contains(err.Error(), "backlog") {
		t.Fatal(err)
	}
	if fr := f.readFrame(); fr.Channel != 5 || fr.Kind != KindClose {
		t.Fatalf("%+v", fr)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.sinks) != 0 {
		t.Fatal("sink kept")
	}
}

func TestDetach(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5, Frame{5, KindData, []byte("unread")})
	go func() {
		if fr := f.readFrame(); fr.Channel != 5 || fr.Kind != KindClose {
			t.Errorf("%+v", fr)
		}
		f.send(Frame{5, KindClose, nil})
	}()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Recv(context.Background()); !errors.Is(err, ErrDetached) {
		t.Fatal(err) // and not the unread output
	}
	if _, err := s.Write([]byte("x")); !errors.Is(err, ErrDetached) {
		t.Fatal(err)
	}
	s.Close() // twice is fine
}

func TestDetachWithoutAnswer(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5)
	start := time.Now()
	s.Close() // the core never confirms
	if d := time.Since(start); d < closeWait || d > closeWait+time.Second {
		t.Fatal(d)
	}
	if fr := f.readFrame(); fr.Kind != KindClose {
		t.Fatalf("%+v", fr)
	}
	f.send(Frame{5, KindData, []byte("late")}, Frame{5, KindClose, nil}) // ignored now
	if _, err := s.Recv(context.Background()); !errors.Is(err, ErrDetached) {
		t.Fatal(err)
	}
}

func TestRecvHonorsContext(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := s.Recv(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}

func TestWriteSplitsLargeInput(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5)
	in := bytes.Repeat([]byte("y"), maxWrite*2+10)
	if n, err := s.Write(in); n != len(in) || err != nil {
		t.Fatal(n, err)
	}
	for _, want := range []int{maxWrite, maxWrite, 10} {
		if fr := f.readFrame(); fr.Kind != KindData || len(fr.Payload) != want {
			t.Fatal(fr.Kind, len(fr.Payload))
		}
	}
}

func TestConnLossEndsStreams(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5, Frame{5, KindData, []byte("last")})
	f.w.Close()
	if got := recvData(t, s); got != "last" {
		t.Fatal(got)
	}
	if _, err := s.Recv(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatal(err)
	}
}

func TestAttachError(t *testing.T) {
	c, f := openFake(t)
	go func() { id, _, _ := f.readCall(); f.send(replyError(id, -32000, "not_found", "no t9")) }()
	s, _, err := c.Attach(context.Background(), AttachParams{Terminal: "t9", Cols: 80, Rows: 24})
	if s != nil || KindOf(err) != "not_found" {
		t.Fatal(s, err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.sinks) != 0 {
		t.Fatal("sink kept")
	}
}

func TestClosedErrorText(t *testing.T) {
	code, sig := 3, 9
	for _, tc := range []struct {
		e    ClosedError
		want string
	}{
		{ClosedError{}, "hc: stream closed by core"},
		{ClosedError{CloseReason{Reason: "exited", ExitCode: &code}}, "hc: stream closed by core: exited (exit code 3)"},
		{ClosedError{CloseReason{Reason: "exited", Signal: &sig}}, "hc: stream closed by core: exited (signal 9)"},
	} {
		if got := tc.e.Error(); got != tc.want {
			t.Errorf("got %q want %q", got, tc.want)
		}
	}
}
