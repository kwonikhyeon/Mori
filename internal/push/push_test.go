package push_test

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/push"
	"github.com/kwonikhyeon/mori/internal/store"
)

// fakeSender records what it is asked to send and answers 201, or the
// status set for the endpoint.
type fakeSender struct {
	mu     sync.Mutex
	sent   []sentMsg
	status map[string]int
}

type sentMsg struct {
	Endpoint string
	Payload  push.Payload
}

func (f *fakeSender) Send(ctx context.Context, sub store.PushSub, payload []byte) (int, error) {
	var p push.Payload
	if err := json.Unmarshal(payload, &p); err != nil {
		return 0, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, sentMsg{sub.Endpoint, p})
	if s, ok := f.status[sub.Endpoint]; ok {
		return s, nil
	}
	return 201, nil
}

func (f *fakeSender) setStatus(endpoint string, status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.status == nil {
		f.status = map[string]int{}
	}
	f.status[endpoint] = status
}

// all returns what was sent since the last take, in the order sent.
func (f *fakeSender) all() []sentMsg {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.sent)
}

// take returns what was sent since the last take, by endpoint.
func (f *fakeSender) take() []sentMsg {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.sent
	f.sent = nil
	slices.SortFunc(out, func(a, b sentMsg) int { return strings.Compare(a.Endpoint, b.Endpoint) })
	return out
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type env struct {
	n       *push.Notifier
	st      *store.Store
	sender  *fakeSender
	clock   *clock
	focused map[string]bool
	mu      sync.Mutex
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Update(func(s *store.State) error {
		for _, id := range []string{"d1", "d2", "d3", "d4"} {
			s.Devices = append(s.Devices, store.Device{ID: id, Name: id})
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	e := &env{st: st, sender: &fakeSender{}, clock: &clock{t: time.UnixMilli(1_700_000_000_000)}, focused: map[string]bool{}}
	e.n = push.New(push.Options{Store: st, Sender: e.sender, Host: "macmini", Now: e.clock.Now,
		Focused: func(addr string) bool { e.mu.Lock(); defer e.mu.Unlock(); return e.focused[addr] },
		Logger:  slog.New(slog.DiscardHandler)})
	return e
}

func (e *env) focus(addr string, on bool) {
	e.mu.Lock()
	e.focused[addr] = on
	e.mu.Unlock()
}

// change hands c to the notifier and waits until it has sent what it sends.
func (e *env) change(c core.Change) []sentMsg {
	e.n.OnChange(c)
	e.n.Wait()
	return e.sender.take()
}

// browserSub is a subscription as a browser makes one: an endpoint and
// the keys of a fresh P-256 pair and auth secret.
func browserSub(t *testing.T, endpoint string) push.Subscription {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, 16)
	rand.Read(secret)
	return push.Subscription{Endpoint: endpoint, Keys: push.Keys{
		P256dh: base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes()),
		Auth:   base64.RawURLEncoding.EncodeToString(secret),
	}}
}

func (e *env) subscribe(t *testing.T, device, endpoint string, kinds ...push.Kind) store.PushSub {
	t.Helper()
	s, err := e.n.Subscribe(device, browserSub(t, endpoint), kinds)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func blockedChange(addr, msg string) core.Change {
	n := term(addr, "blocked", 1, "")
	n.Status.Msg = msg
	return core.Change{Address: addr, Old: term(addr, "working", 0, ""), New: n, Event: event("status", `{}`)}
}

func endpoints(ms []sentMsg) []string {
	var out []string
	for _, m := range ms {
		out = append(out, m.Endpoint)
	}
	return out
}

func TestNotifierSendsPayload(t *testing.T) {
	e := newEnv(t)
	e.subscribe(t, "d1", "https://push.example.com/a")
	e.subscribe(t, "d2", "https://push.example.com/b")
	got := e.change(blockedChange("t1", "Allow Bash?"))
	if !slices.Equal(endpoints(got), []string{"https://push.example.com/a", "https://push.example.com/b"}) {
		t.Fatalf("sent to %v", endpoints(got))
	}
	want := push.Payload{Title: "macmini · 승인 대기", Body: "claude — Allow Bash?", Tag: "t1", URL: "/#/t/t1"}
	if got[0].Payload != want {
		t.Errorf("payload %+v, want %+v", got[0].Payload, want)
	}
	// Without a message the body is the terminal's title alone.
	w := core.Change{Address: "t2", Old: term("t2", "working", 0, ""), New: term("t2", "done", 1, ""), Event: event("turn", `{"state":"done","turn":1}`)}
	got = e.change(w)
	if len(got) != 2 || got[0].Payload.Title != "macmini · 입력 대기" || got[0].Payload.Body != "claude" {
		t.Errorf("waiting: %+v", got)
	}
}

func TestNotifierDedupeFocusAndGone(t *testing.T) {
	e := newEnv(t)
	e.subscribe(t, "d1", "https://push.example.com/a")
	e.subscribe(t, "d2", "https://push.example.com/b")

	if got := e.change(blockedChange("t1", "")); len(got) != 2 {
		t.Fatalf("first: sent %d, want 2", len(got))
	}
	e.clock.Add(5 * time.Second)
	if got := e.change(blockedChange("t1", "")); len(got) != 0 {
		t.Errorf("same kind 5 s later: sent %d, want 0", len(got))
	}
	errChange := core.Change{Address: "t1", Old: term("t1", "working", 1, ""), New: term("t1", "error", 1, ""), Event: event("status", `{}`)}
	if got := e.change(errChange); len(got) != 2 {
		t.Errorf("another kind: sent %d, want 2", len(got))
	}
	if got := e.change(blockedChange("t2", "")); len(got) != 2 {
		t.Errorf("another terminal: sent %d, want 2", len(got))
	}
	e.clock.Add(6 * time.Second)
	if got := e.change(blockedChange("t1", "")); len(got) != 2 {
		t.Errorf("same kind 11 s later: sent %d, want 2", len(got))
	}

	e.focus("t3", true)
	if got := e.change(blockedChange("t3", "")); len(got) != 0 {
		t.Errorf("focused: sent %d, want 0", len(got))
	}
	e.focus("t3", false)
	if got := e.change(blockedChange("t3", "")); len(got) != 2 {
		t.Errorf("focus left: sent %d, want 2 (a focused terminal is not counted as sent)", len(got))
	}

	e.sender.setStatus("https://push.example.com/b", 410)
	e.change(blockedChange("t4", ""))
	e.sender.setStatus("https://push.example.com/a", 404)
	e.change(blockedChange("t5", ""))
	if subs := e.st.Get().PushSubs; len(subs) != 0 {
		t.Errorf("subscriptions after 410 and 404: %+v, want none", subs)
	}
}

func TestNotifierServerErrorKeepsSubscription(t *testing.T) {
	e := newEnv(t)
	e.subscribe(t, "d1", "https://push.example.com/a")
	e.sender.setStatus("https://push.example.com/a", 500)
	e.change(blockedChange("t1", ""))
	if subs := e.st.Get().PushSubs; len(subs) != 1 {
		t.Errorf("subscriptions after 500: %d, want 1", len(subs))
	}
}

func TestKindsFilter(t *testing.T) {
	e := newEnv(t)
	e.subscribe(t, "d1", "https://push.example.com/a", push.KindExited)
	s := e.subscribe(t, "d2", "https://push.example.com/b")
	if !slices.Equal(s.Kinds, []string{"blocked", "waiting", "error"}) {
		t.Errorf("default kinds %v", s.Kinds)
	}
	exit := core.Change{Address: "t1", Old: term("t1", "idle", 0, ""), New: finished(term("t1", "idle", 0, ""), 3), Event: event("finished", `{}`)}
	got := e.change(exit)
	if !slices.Equal(endpoints(got), []string{"https://push.example.com/a"}) {
		t.Fatalf("exited sent to %v", endpoints(got))
	}
	if p := got[0].Payload; p.Title != "macmini · 종료" || p.Body != "claude — 종료 코드 3" {
		t.Errorf("exited payload %+v", p)
	}
	if got := e.change(blockedChange("t1", "")); !slices.Equal(endpoints(got), []string{"https://push.example.com/b"}) {
		t.Errorf("blocked sent to %v", endpoints(got))
	}
	if _, err := e.n.Subscribe("d3", browserSub(t, "https://push.example.com/c"), []push.Kind{"blocked", "nope"}); !errors.As(err, new(*push.InvalidError)) {
		t.Errorf("unknown kind: err %v, want InvalidError", err)
	}
}

func TestChildSetting(t *testing.T) {
	e := newEnv(t)
	e.subscribe(t, "d1", "https://push.example.com/a")
	child := core.Change{Address: "t2", Old: term("t2", "working", 0, "t1"), New: term("t2", "blocked", 0, "t1"), Event: event("status", `{}`)}
	if got := e.change(child); len(got) != 0 {
		t.Errorf("child by default: sent %d", len(got))
	}
	if err := e.st.Update(func(s *store.State) error { s.Notify.Children = true; return nil }); err != nil {
		t.Fatal(err)
	}
	if got := e.change(child); len(got) != 1 {
		t.Errorf("child with the setting on: sent %d, want 1", len(got))
	}
}

func TestSubscribe(t *testing.T) {
	e := newEnv(t)
	a := e.subscribe(t, "d1", "https://push.example.com/a")
	if !strings.HasPrefix(a.ID, "p_") || a.DeviceID != "d1" || a.CreatedMs != e.clock.Now().UnixMilli() {
		t.Errorf("subscription %+v", a)
	}
	// The same endpoint again updates it in place.
	e.clock.Add(time.Minute)
	again := e.subscribe(t, "d1", "https://push.example.com/a", push.KindBlocked)
	if again.ID != a.ID || again.CreatedMs != a.CreatedMs || !slices.Equal(again.Kinds, []string{"blocked"}) {
		t.Errorf("resubscribed %+v, was %+v", again, a)
	}
	// A device has one subscription: a new endpoint replaces the old one.
	b := e.subscribe(t, "d1", "https://push.example.com/b")
	if subs := e.st.Get().PushSubs; len(subs) != 1 || subs[0].ID != b.ID {
		t.Errorf("after a new endpoint: %+v", subs)
	}
	// An endpoint another device had moves to the one subscribing now.
	e.subscribe(t, "d2", "https://push.example.com/b")
	if subs := e.st.Get().PushSubs; len(subs) != 1 || subs[0].DeviceID != "d2" {
		t.Errorf("after d2 took the endpoint: %+v", subs)
	}
	if got := e.n.Subscriptions("d2"); len(got) != 1 || got[0].Endpoint != "https://push.example.com/b" {
		t.Errorf("Subscriptions(d2) = %+v", got)
	}
	if got := e.n.Subscriptions("d1"); len(got) != 0 {
		t.Errorf("Subscriptions(d1) = %+v", got)
	}

	bad := []struct {
		name string
		sub  push.Subscription
	}{
		{"http endpoint", browserSub(t, "http://push.example.com/a")},
		{"no endpoint", browserSub(t, "")},
		{"relative endpoint", browserSub(t, "/push")},
		{"long endpoint", browserSub(t, "https://push.example.com/"+strings.Repeat("a", 2048))},
		{"short p256dh", func() push.Subscription {
			s := browserSub(t, "https://push.example.com/c")
			s.Keys.P256dh = base64.RawURLEncoding.EncodeToString(make([]byte, 33))
			return s
		}()},
		{"p256dh off the curve", func() push.Subscription {
			s := browserSub(t, "https://push.example.com/c")
			p := make([]byte, 65)
			p[0] = 4
			s.Keys.P256dh = base64.RawURLEncoding.EncodeToString(p)
			return s
		}()},
		{"short auth", func() push.Subscription {
			s := browserSub(t, "https://push.example.com/c")
			s.Keys.Auth = base64.RawURLEncoding.EncodeToString(make([]byte, 8))
			return s
		}()},
		{"auth not base64", func() push.Subscription {
			s := browserSub(t, "https://push.example.com/c")
			s.Keys.Auth = "**"
			return s
		}()},
	}
	if _, err := e.n.Subscribe("nobody", browserSub(t, "https://push.example.com/z"), nil); !errors.Is(err, push.ErrUnknownDevice) {
		t.Errorf("a device that is not paired: err %v, want ErrUnknownDevice", err)
	}
	for _, b := range bad {
		if _, err := e.n.Subscribe("d3", b.sub, nil); !errors.As(err, new(*push.InvalidError)) {
			t.Errorf("%s: err %v, want InvalidError", b.name, err)
		}
	}
	// Browsers may hand the keys padded or in the standard alphabet.
	s := browserSub(t, "https://push.example.com/d")
	raw, _ := base64.RawURLEncoding.DecodeString(s.Keys.P256dh)
	s.Keys.P256dh = base64.StdEncoding.EncodeToString(raw)
	if _, err := e.n.Subscribe("d4", s, nil); err != nil {
		t.Errorf("standard base64 keys: %v", err)
	}

	if err := e.n.Unsubscribe("d2", "https://push.example.com/nope"); err != nil {
		t.Errorf("unsubscribe unknown endpoint: %v", err)
	}
	if err := e.n.Unsubscribe("d1", "https://push.example.com/b"); err != nil || len(e.n.Subscriptions("d2")) != 1 {
		t.Errorf("another device's endpoint was removed: %v", err)
	}
	if err := e.n.Unsubscribe("d2", ""); err != nil || len(e.n.Subscriptions("d2")) != 0 {
		t.Errorf("unsubscribe all of d2: %v, left %+v", err, e.n.Subscriptions("d2"))
	}
}

func TestTestNotification(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.n.Test(ctx, "d1"); !errors.Is(err, push.ErrNoSubscription) {
		t.Errorf("no subscription: err %v", err)
	}
	e.subscribe(t, "d1", "https://push.example.com/a")
	e.subscribe(t, "d2", "https://push.example.com/b")
	n, err := e.n.Test(ctx, "d1")
	if err != nil || n != 1 {
		t.Fatalf("Test = %d, %v", n, err)
	}
	got := e.sender.take()
	if len(got) != 1 || got[0].Endpoint != "https://push.example.com/a" || got[0].Payload.Title != "macmini · 시험 알림" {
		t.Errorf("sent %+v", got)
	}
	e.sender.setStatus("https://push.example.com/a", 410)
	if n, err := e.n.Test(ctx, "d1"); n != 0 || err == nil || !strings.Contains(err.Error(), "410") {
		t.Errorf("Test on a gone subscription = %d, %v", n, err)
	}
	if subs := e.n.Subscriptions("d1"); len(subs) != 0 {
		t.Errorf("the gone subscription stayed: %+v", subs)
	}
}

func TestEnsureVAPIDStable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	st, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	a, err := push.EnsureVAPID(st)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := base64.RawURLEncoding.DecodeString(a.Public)
	if err != nil || len(pub) != 65 || pub[0] != 4 {
		t.Fatalf("public key %q: %d bytes, %v; want 65, uncompressed", a.Public, len(pub), err)
	}
	priv, err := base64.RawURLEncoding.DecodeString(a.Private)
	if err != nil {
		t.Fatal(err)
	}
	k, err := ecdh.P256().NewPrivateKey(priv)
	if err != nil || string(k.PublicKey().Bytes()) != string(pub) {
		t.Fatalf("the private key does not match the public one: %v", err)
	}
	b, err := push.EnsureVAPID(st)
	if err != nil || b != a {
		t.Errorf("second call: %+v, %v; want the same keys", b, err)
	}
	st2, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if c, err := push.EnsureVAPID(st2); err != nil || c != a {
		t.Errorf("after reopening: %+v, %v; want the same keys", c, err)
	}
}
