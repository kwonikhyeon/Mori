package hc

import (
	"context"
	"encoding/binary"
	"errors"
	"testing"
	"time"
)

// subscribeFake subscribes and has the fake core put the reply and then in
// one write.
func subscribeFake(t *testing.T, c *Conn, f *fakeCore, then ...Frame) (*Events, Snapshot) {
	t.Helper()
	go func() {
		id, m, params := f.readCall()
		if m != "events.subscribe" || string(params) != `{}` {
			t.Errorf("call %s %s", m, params)
		}
		f.send(append([]Frame{reply(id, `{"seq":3,"terminals":[{"address":"t1","state":"live"}],"channel":1}`)}, then...)...)
	}()
	ev, snap, err := c.Subscribe(context.Background(), SubscribeParams{})
	if err != nil {
		t.Fatal(err)
	}
	return ev, snap
}

// credits reads frames until the CREDIT on channel 1 adds up to want.
func credits(t *testing.T, f *fakeCore, want int) {
	t.Helper()
	got := make(chan int, 1)
	go func() {
		n := 0
		for n < want {
			fr := f.readFrame()
			if fr.Channel != 1 || fr.Kind != KindCredit || len(fr.Payload) != 4 {
				t.Errorf("%+v", fr)
				break
			}
			n += int(binary.LittleEndian.Uint32(fr.Payload))
		}
		got <- n
	}()
	select {
	case n := <-got:
		if n != want {
			t.Fatalf("credited %d, want %d", n, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("credit short of %d", want)
	}
}

func TestEventsSplitAcrossFramesAndCredited(t *testing.T) {
	c, f := openFake(t)
	a := `{"jsonrpc":"2.0","method":"event","params":{"seq":4,"type":"title","terminal":"t1","data":{"ti`
	b := `tle":"hi"}}}` + "\n" + `{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":4}}` + "\n"
	ev, snap := subscribeFake(t, c, f, Frame{1, KindData, []byte(a)}, Frame{1, KindData, []byte(b)})
	if snap.Seq != 3 || len(snap.Terminals) != 1 || snap.Terminals[0].Address != "t1" {
		t.Fatalf("%+v", snap)
	}
	n1, err := ev.Recv(context.Background())
	if err != nil || n1.Method != "event" || n1.Seq != 4 || n1.Event.Type != "title" || n1.Event.Terminal != "t1" ||
		string(n1.Event.Data) != `{"title":"hi"}` {
		t.Fatalf("%+v %v", n1, err)
	}
	n2, err := ev.Recv(context.Background())
	if err != nil || n2.Method != "heartbeat" || n2.Seq != 4 || n2.Event != nil {
		t.Fatalf("%+v %v", n2, err)
	}
	credits(t, f, len(a)+len(b)) // every byte read is credited back
}

func TestEventsPartialLineCredited(t *testing.T) {
	c, f := openFake(t)
	ev, _ := subscribeFake(t, c, f)
	got := make(chan Notification, 1)
	go func() {
		n, err := ev.Recv(context.Background())
		if err != nil {
			t.Error(err)
		}
		got <- n
	}()
	head := `{"jsonrpc":"2.0","method":"heart`
	f.send(Frame{1, KindData, []byte(head)})
	credits(t, f, len(head)) // a message larger than the window must still get through
	tail := `beat","params":{"seq":9}}` + "\n"
	f.send(Frame{1, KindData, []byte(tail)})
	if n := <-got; n.Method != "heartbeat" || n.Seq != 9 {
		t.Fatalf("%+v", n)
	}
	credits(t, f, len(tail))
}

func TestMissedCarriesSnapshot(t *testing.T) {
	c, f := openFake(t)
	ev, _ := subscribeFake(t, c, f, Frame{1, KindData, []byte(
		`{"jsonrpc":"2.0","method":"missed","params":{"seq":57,"terminals":[{"address":"t2","state":"finished"}]}}` + "\n" +
			"\n" + // blank lines are skipped
			`{"jsonrpc":"2.0","method":"later","params":{}}` + "\n")})
	n, err := ev.Recv(context.Background())
	if err != nil || n.Method != "missed" || n.Seq != 57 || n.Snapshot == nil || n.Snapshot.Seq != 57 ||
		len(n.Snapshot.Terminals) != 1 || n.Snapshot.Terminals[0].Address != "t2" || n.Snapshot.Terminals[0].State != "finished" {
		t.Fatalf("%+v %v", n, err)
	}
	if n, err := ev.Recv(context.Background()); err != nil || n.Method != "later" || n.Event != nil || n.Snapshot != nil {
		t.Fatalf("unknown methods pass through: %+v %v", n, err)
	}
}

func TestEventsBadLineEndsSubscription(t *testing.T) {
	c, f := openFake(t)
	ev, _ := subscribeFake(t, c, f, Frame{1, KindData, []byte("not json\n" + `{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":5}}` + "\n")})
	if _, err := ev.Recv(context.Background()); err == nil {
		t.Fatal("bad line accepted")
	}
	if _, err := ev.Recv(context.Background()); err == nil {
		t.Fatal("lines after a bad one must not be delivered")
	}
	for { // credit for the bad line may come first
		fr := f.readFrame()
		if fr.Kind == KindClose && fr.Channel == 1 {
			break
		}
		if fr.Kind != KindCredit {
			t.Fatalf("%+v", fr)
		}
	}
}

func TestEventsCloseAndConnLoss(t *testing.T) {
	c, f := openFake(t)
	ev, _ := subscribeFake(t, c, f)
	go func() {
		if fr := f.readFrame(); fr.Channel != 1 || fr.Kind != KindClose {
			t.Errorf("%+v", fr)
		}
		f.send(Frame{1, KindClose, nil})
	}()
	ev.Close()
	if _, err := ev.Recv(context.Background()); !errors.Is(err, ErrDetached) {
		t.Fatal(err)
	}

	c, f = openFake(t)
	ev, _ = subscribeFake(t, c, f, Frame{1, KindData, []byte(`{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":1}}` + "\n")})
	f.w.Close()
	if n, err := ev.Recv(context.Background()); err != nil || n.Seq != 1 {
		t.Fatal("received lines come first:", n, err)
	}
	if _, err := ev.Recv(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatal(err)
	}
}

func TestSubscribeParams(t *testing.T) {
	c, f := openFake(t)
	go func() {
		id, _, params := f.readCall()
		if string(params) != `{"labels":{"mori":"1"}}` {
			t.Errorf("params %s", params)
		}
		f.send(reply(id, `{"seq":0,"terminals":null,"channel":2}`))
	}()
	ev, snap, err := c.Subscribe(context.Background(), SubscribeParams{Labels: map[string]string{"mori": "1"}})
	if err != nil || ev.Channel() != 2 || snap.Terminals == nil || len(snap.Terminals) != 0 {
		t.Fatal(err, snap)
	}
}
