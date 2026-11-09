package server

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/kwonikhyeon/mori/internal/push"
	"github.com/kwonikhyeon/mori/internal/store"
)

// recordSender takes every message, or answers status when it is set.
type recordSender struct {
	mu     sync.Mutex
	sent   []string // endpoints
	bodies [][]byte // what was sent, before encryption
	status int
}

func (r *recordSender) Send(ctx context.Context, sub store.PushSub, payload []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, sub.Endpoint)
	r.bodies = append(r.bodies, payload)
	if r.status != 0 {
		return r.status, nil
	}
	return 201, nil
}

// payloads are the notifications sent so far, decoded.
func (r *recordSender) payloads(t *testing.T) []push.Payload {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	var ps []push.Payload
	for _, b := range r.bodies {
		var p push.Payload
		if err := json.Unmarshal(b, &p); err != nil {
			t.Fatal(err)
		}
		ps = append(ps, p)
	}
	return ps
}

func (r *recordSender) answer(status int) {
	r.mu.Lock()
	r.status = status
	r.mu.Unlock()
}

func (r *recordSender) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sent)
}

// withPush gives the server a notifier over its store that sends with s.
func withPush(t *testing.T, s push.Sender) func(*Deps) {
	return func(d *Deps) {
		if _, err := push.EnsureVAPID(d.Store); err != nil {
			t.Fatal(err)
		}
		d.Push = push.New(push.Options{Store: d.Store, Sender: s, Host: d.HostName, Logger: d.Logger})
	}
}

// browserSubscription is a PushSubscription as a browser's toJSON gives it.
func browserSubscription(t *testing.T, endpoint string) map[string]any {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, 16)
	rand.Read(secret)
	return map[string]any{"endpoint": endpoint, "expirationTime": nil, "keys": map[string]string{
		"p256dh": base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes()),
		"auth":   base64.RawURLEncoding.EncodeToString(secret),
	}}
}

func TestPushAPI(t *testing.T) {
	sender := &recordSender{}
	e := newTestEnv(t, withPush(t, sender))
	e.expectError("GET", "/api/push/key", nil, 401)
	e.pair()

	var key struct{ Key string }
	e.json("GET", "/api/push/key", nil, 200, &key)
	if key.Key == "" || key.Key != e.store.Get().VAPID.Public {
		t.Errorf("key %q, want the stored public key", key.Key)
	}
	var subs []pushSubJSON
	e.json("GET", "/api/push/subscriptions", nil, 200, &subs)
	if subs == nil || len(subs) != 0 {
		t.Errorf("no subscriptions yet: %+v", subs)
	}
	if eb := e.expectError("POST", "/api/push/test", nil, 409); eb.Error.Kind != "conflict" {
		t.Errorf("test without a subscription: %+v", eb)
	}

	const endpoint = "https://push.example.com/abc"
	var sub pushSubJSON
	e.json("POST", "/api/push/subscriptions", map[string]any{"subscription": browserSubscription(t, endpoint), "kinds": []string{"exited", "blocked"}}, 201, &sub)
	if sub.ID == "" || sub.Endpoint != endpoint || !slices.Equal(sub.Kinds, []string{"blocked", "exited"}) {
		t.Errorf("subscribed %+v", sub)
	}
	res := e.do("GET", "/api/push/subscriptions", nil)
	b, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(b), sub.ID) || strings.Contains(string(b), "p256dh") || strings.Contains(string(b), "auth") {
		t.Errorf("list %s: want the subscription without its keys", b)
	}
	var sent struct{ Sent int }
	e.json("POST", "/api/push/test", nil, 200, &sent)
	if sent.Sent != 1 || sender.count() != 1 {
		t.Errorf("test sent %d, the sender heard %d", sent.Sent, sender.count())
	}

	for name, body := range map[string]any{
		"no subscription": map[string]any{},
		"http endpoint":   map[string]any{"subscription": browserSubscription(t, "http://push.example.com/abc")},
		"unknown kind":    map[string]any{"subscription": browserSubscription(t, endpoint), "kinds": []string{"everything"}},
		"no keys":         map[string]any{"subscription": map[string]any{"endpoint": endpoint}},
	} {
		if eb := e.expectError("POST", "/api/push/subscriptions", body, 400); eb.Error.Kind != "invalid_params" {
			t.Errorf("%s: %+v", name, eb)
		}
	}

	var n store.Notify
	e.json("GET", "/api/push/settings", nil, 200, &n)
	if n.Children {
		t.Error("children is off by default")
	}
	e.json("PUT", "/api/push/settings", map[string]bool{"children": true}, 200, &n)
	if !n.Children || !e.store.Get().Notify.Children {
		t.Errorf("settings after PUT: %+v", e.store.Get().Notify)
	}

	// A subscription the push service has forgotten is forgotten here too.
	sender.answer(410)
	if eb := e.expectError("POST", "/api/push/test", nil, 502); eb.Error.Kind != "push_failed" || !strings.Contains(eb.Error.Message, "410") {
		t.Errorf("test on a gone subscription: %+v", eb)
	}
	e.json("GET", "/api/push/subscriptions", nil, 200, &subs)
	if len(subs) != 0 {
		t.Errorf("the gone subscription stayed: %+v", subs)
	}
	sender.answer(0)

	e.json("POST", "/api/push/subscriptions", map[string]any{"subscription": browserSubscription(t, endpoint)}, 201, &sub)
	if !slices.Equal(sub.Kinds, []string{"blocked", "waiting", "error"}) {
		t.Errorf("default kinds %v", sub.Kinds)
	}
	e.json("DELETE", "/api/push/subscriptions", map[string]string{"endpoint": endpoint}, 204, nil)
	e.json("GET", "/api/push/subscriptions", nil, 200, &subs)
	if len(subs) != 0 {
		t.Errorf("after unsubscribing: %+v", subs)
	}

	// Logging out takes the device's subscription with it.
	e.json("POST", "/api/push/subscriptions", map[string]any{"subscription": browserSubscription(t, endpoint)}, 201, nil)
	e.json("POST", "/api/logout", nil, 204, nil)
	if got := e.store.Get().PushSubs; len(got) != 0 {
		t.Errorf("subscriptions after logout: %+v", got)
	}
}

func TestPushAPIOff(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	for _, r := range []struct{ method, path string }{
		{"GET", "/api/push/key"}, {"GET", "/api/push/subscriptions"}, {"POST", "/api/push/subscriptions"},
		{"DELETE", "/api/push/subscriptions"}, {"POST", "/api/push/test"}, {"GET", "/api/push/settings"}, {"PUT", "/api/push/settings"},
	} {
		if eb := e.expectError(r.method, r.path, nil, 503); eb.Error.Kind != "unavailable" {
			t.Errorf("%s %s: %+v", r.method, r.path, eb)
		}
	}
}
