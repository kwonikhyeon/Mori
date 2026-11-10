package server

import (
	"bytes"
	"cmp"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/peer"
	"github.com/kwonikhyeon/mori/internal/push"
	"github.com/kwonikhyeon/mori/internal/store"
)

// relaySender sends for real with webpush-go, as a host's notifier does,
// over client: a hub's relay endpoint plays the push service.
type relaySender struct {
	client *http.Client
	store  *store.Store // the sending host's, for its VAPID keys
}

func (r *relaySender) Send(ctx context.Context, sub store.PushSub, payload []byte) (int, error) {
	v := r.store.Get().VAPID
	res, err := webpush.SendNotificationWithContext(ctx, payload,
		&webpush.Subscription{Endpoint: sub.Endpoint, Keys: webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth}},
		&webpush.Options{HTTPClient: r.client, Subscriber: "https://github.com/kwonikhyeon/Mori", TTL: 60,
			Urgency: webpush.UrgencyHigh, VAPIDPublicKey: v.Public, VAPIDPrivateKey: v.Private})
	if err != nil {
		return 0, err
	}
	res.Body.Close()
	return res.StatusCode, nil
}

// logBuffer collects a server's log; slog may write from any goroutine.
type logBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *logBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// withLog makes the server log into l. It goes before the options that
// hand the logger on.
func withLog(l *logBuffer) func(*Deps) {
	return func(d *Deps) { d.Logger = slog.New(slog.NewTextHandler(l, nil)) }
}

// relayKeys are what a hub keeps for one host's relay subscription.
type relayKeys struct {
	secret     string
	key        *ecdh.PrivateKey
	authSecret []byte
}

func newRelayKeys(t *testing.T) relayKeys {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	a := make([]byte, 16)
	rand.Read(a)
	return relayKeys{secret: rand.Text(), key: k, authSecret: a}
}

// relayTo gives the linked host id a relay subscription, as SetupRelay
// leaves it, and returns its keys.
func (e *testEnv) relayTo(id string) relayKeys {
	e.t.Helper()
	k := newRelayKeys(e.t)
	enc := base64.RawURLEncoding.EncodeToString
	if err := e.store.Update(func(st *store.State) error {
		for i := range st.Hosts {
			if st.Hosts[i].ID == id {
				st.Hosts[i].Link.Relay = store.Relay{Secret: k.secret, Key: enc(k.key.Bytes()), Auth: enc(k.authSecret),
					Base: "https://macmini.example.ts.net", OK: true}
				return nil
			}
		}
		return fmt.Errorf("no host %s", id)
	}); err != nil {
		e.t.Fatal(err)
	}
	return k
}

// captureClient keeps the request webpush-go would send instead of sending it.
type captureClient struct {
	req  *http.Request
	body []byte
}

func (c *captureClient) Do(req *http.Request) (*http.Response, error) {
	b, err := io.ReadAll(req.Body)
	c.req, c.body = req, b
	return &http.Response{StatusCode: http.StatusCreated, Body: http.NoBody}, err
}

// sealed is p encrypted to k, as a host's notifier sends it to the hub.
func sealed(t *testing.T, k relayKeys, p any) []byte {
	t.Helper()
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.RawURLEncoding.EncodeToString
	var c captureClient
	res, err := webpush.SendNotification(b, &webpush.Subscription{Endpoint: "https://macmini.example.ts.net/api/relay/" + k.secret,
		Keys: webpush.Keys{P256dh: enc(k.key.PublicKey().Bytes()), Auth: enc(k.authSecret)}},
		&webpush.Options{HTTPClient: &c, Subscriber: "https://github.com/kwonikhyeon/Mori", TTL: 60, VAPIDPublicKey: pub, VAPIDPrivateKey: priv})
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if got := c.req.Header.Get("Content-Encoding"); got != "aes128gcm" {
		t.Fatal("content encoding", got)
	}
	return c.body
}

// postRelay posts body to the relay endpoint as a push service does: no
// cookie, no Origin.
func (e *testEnv) postRelay(secret, encoding string, body []byte) *http.Response {
	e.t.Helper()
	req, err := http.NewRequest("POST", e.srv.URL+"/api/relay/"+secret, bytes.NewReader(body))
	if err != nil {
		e.t.Fatal(err)
	}
	if encoding != "" {
		req.Header.Set("Content-Encoding", encoding)
	}
	res, err := cmp.Or(e.httpClient, http.DefaultClient).Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { res.Body.Close() })
	return res
}

// TestHubRelaysHostNotifications runs two real servers: the hub links desk
// through its API, and a phone paired only with the hub opens desk's
// terminals and gets desk's approval request (spec §3 #158, #165~#167).
func TestHubRelaysHostNotifications(t *testing.T) {
	phone := &recordSender{}
	hubLog := &logBuffer{}
	hubSrv := httptest.NewUnstartedServer(nil)
	addr := hubSrv.Listener.Addr().String()
	hub := startTestEnv(t, hubSrv, true, withLog(hubLog), withPush(t, phone), func(d *Deps) {
		d.PublicURL = func() string { return "https://" + addr }
		d.Links = peer.New(peer.Options{Store: d.Store, PublicURL: d.PublicURL, Listen: addr,
			HostName: d.HostName, Version: d.Version, Logger: d.Logger})
	})
	hub.pair()
	hub.json("POST", "/api/push/subscriptions", map[string]any{
		"subscription": browserSubscription(t, "https://push.example.com/phone"), "kinds": []string{"blocked"}}, 201, nil)

	relay := &relaySender{client: hub.httpClient}
	desk := newTestEnv(t, func(d *Deps) { d.HostName = "desk"; relay.store = d.Store }, withPush(t, relay))

	pc := desk.auth.NewCode("")
	var v peer.View
	hub.json("POST", "/api/hosts", map[string]string{"url": desk.srv.URL, "code": pc.Code}, 201, &v)
	if !v.Linked || !v.Relay || v.RelayError != "" || v.Name != "desk" {
		t.Fatalf("%+v", v)
	}
	hub.s.d.Push.Wait()
	if phone.count() != 0 {
		t.Fatal("desk's test notification must stop at the hub")
	}

	// Through the hub, the phone works on desk.
	var hello struct {
		App, Host string
		Paired    bool
	}
	hub.json("GET", "/h/"+v.ID+"/api/hello", nil, 200, &hello)
	if hello.App != "mori" || hello.Host != "desk" || !hello.Paired {
		t.Fatalf("%+v", hello)
	}
	c := hub.dialWS("/h/" + v.ID + "/ws/events")
	ctx, cancel := context.WithTimeout(context.Background(), wsWait)
	defer cancel()
	_, b, err := c.Read(ctx)
	var snap struct{ Type string }
	if err != nil || json.Unmarshal(b, &snap) != nil || snap.Type != "snapshot" {
		t.Fatalf("%s %v", b, err)
	}

	// desk's terminal waits for approval: the phone hears it from the hub.
	desk.s.d.Push.OnChange(core.Change{Address: "t1",
		Old:   &hc.Terminal{Address: "t1", State: "live", Argv: []string{"claude"}, Status: &hc.Status{State: "working"}},
		New:   &hc.Terminal{Address: "t1", State: "live", Argv: []string{"claude"}, Status: &hc.Status{State: "blocked", Msg: "Allow Bash?"}},
		Event: &hc.Event{Type: "status", Terminal: "t1", Data: json.RawMessage(`{}`)}})
	desk.s.d.Push.Wait() // desk's delivery ends once the hub has taken it
	hub.s.d.Push.Wait()
	ask := core.AskID(hc.Terminal{State: "live", Turn: 1, Status: &hc.Status{State: "blocked", Msg: "Allow Bash?"}})
	want := []push.Payload{{Title: "desk · 승인 대기", Body: "claude — Allow Bash?", Tag: v.ID + "/t1", URL: "/#/h/" + v.ID + "/t/t1", Kind: "blocked", Ask: ask}}
	if got := phone.payloads(t); !slices.Equal(got, want) {
		t.Fatalf("%+v", got)
	}

	// desk revokes the hub: the phone sees desk unlinked, not itself logged out.
	secret := hub.store.Get().Hosts[0].Link.Relay.Secret
	ds := desk.auth.Devices()
	i := slices.IndexFunc(ds, func(d store.Device) bool { return d.Name == "testhost 허브" })
	if i < 0 {
		t.Fatalf("no hub device on desk: %+v", ds)
	}
	if err := desk.auth.Revoke(ds[i].ID); err != nil {
		t.Fatal(err)
	}
	if code := readUntilClosed(t, c); code != closeUnauthorized {
		t.Fatalf("close %d: desk's 4401 passes through", code)
	}
	if eb := hub.expectError("GET", "/h/"+v.ID+"/api/overview", nil, 409); eb.Error.Kind != "host_unlinked" {
		t.Fatal(eb)
	}
	var hosts []peer.View
	hub.json("GET", "/api/hosts", nil, 200, &hosts)
	if len(hosts) != 1 || hosts[0].Linked || hosts[0].Relay {
		t.Fatalf("%+v", hosts)
	}
	hub.json("GET", "/api/hello", nil, 200, &hello)
	if !hello.Paired {
		t.Fatal("the phone stays paired with the hub")
	}
	if n := len(desk.store.Get().PushSubs); n != 0 {
		t.Fatalf("%d subscriptions left on desk", n)
	}
	if res := hub.postRelay(secret, "aes128gcm", []byte("x")); res.StatusCode != 410 {
		t.Fatal(res.StatusCode)
	}
	if strings.Contains(hubLog.String(), secret) {
		t.Fatal("the relay secret is in the hub's log")
	}
}

// TestRelayEndpoint covers what a host's push may bring (spec §3 #166).
func TestRelayEndpoint(t *testing.T) {
	logs := &logBuffer{}
	phone := &recordSender{}
	e := newTestEnv(t, withLog(logs), withPush(t, phone), withLinks(nil))
	e.pair()
	e.json("POST", "/api/push/subscriptions", map[string]any{
		"subscription": browserSubscription(t, "https://push.example.com/phone"), "kinds": []string{"blocked", "exited"}}, 201, nil)
	id := e.linkHost("https://desk.example.ts.net")
	k := e.relayTo(id)
	terminal := push.Payload{Title: "desk · 종료", Body: "claude", Tag: "machine/t7", URL: "/#/t/machine%2Ft7", Kind: "exited"}

	for _, tc := range []struct {
		name, secret, encoding string
		body                   []byte
		status                 int
		kind                   string
	}{
		{"unknown secret", "unknown-relay-secret", "aes128gcm", sealed(t, k, terminal), 410, "not_found"},
		{"no encoding", k.secret, "", sealed(t, k, terminal), 400, "invalid_params"},
		{"old encoding", k.secret, "aesgcm", sealed(t, k, terminal), 400, "invalid_params"},
		{"too large", k.secret, "aes128gcm", bytes.Repeat([]byte{1}, maxRelayPush+1), 413, "too_large"},
		{"other keys", k.secret, "aes128gcm", sealed(t, newRelayKeys(t), terminal), 400, "invalid_params"},
		{"garbage", k.secret, "aes128gcm", bytes.Repeat([]byte{7}, 200), 400, "invalid_params"},
		{"test notification", k.secret, "aes128gcm",
			sealed(t, k, push.Payload{Title: "desk · 시험 알림", Body: "이 기기로 알림이 옵니다.", Tag: "mori-test", URL: "/"}), 201, ""},
		{"unknown kind", k.secret, "aes128gcm",
			sealed(t, k, push.Payload{Title: "desk · 파티", Tag: "t7", URL: "/#/t/t7", Kind: "party"}), 201, ""},
		{"kind the phone left off", k.secret, "aes128gcm",
			sealed(t, k, push.Payload{Title: "desk · 오류", Tag: "t7", URL: "/#/t/t7", Kind: "error"}), 201, ""},
	} {
		res := e.postRelay(tc.secret, tc.encoding, tc.body)
		if res.StatusCode != tc.status {
			t.Errorf("%s: %d, want %d", tc.name, res.StatusCode, tc.status)
			continue
		}
		if tc.kind != "" {
			if eb := decode[errorBody](t, res); eb.Error.Kind != tc.kind {
				t.Errorf("%s: %+v", tc.name, eb)
			}
		}
	}
	e.s.d.Push.Wait()
	if n := phone.count(); n != 0 {
		t.Fatalf("%d sent: none of these goes on", n)
	}

	if res := e.postRelay(k.secret, "aes128gcm", sealed(t, k, terminal)); res.StatusCode != 201 {
		t.Fatal(res.StatusCode)
	}
	e.s.d.Push.Wait()
	want := []push.Payload{{Title: "desk · 종료", Body: "claude", Tag: id + "/machine/t7", URL: "/#/h/" + id + "/t/machine%2Ft7", Kind: "exited"}}
	if got := phone.payloads(t); !slices.Equal(got, want) {
		t.Fatalf("%+v", got)
	}
	out := logs.String()
	if !strings.Contains(out, "relayed notification unreadable") || strings.Contains(out, k.secret) || strings.Contains(out, "unknown-relay-secret") {
		t.Fatal(out)
	}
}

// TestRelayEndpointWithout checks a server that links no hosts and one that
// sends no notifications. Only POST goes around requireDevice.
func TestRelayEndpointWithout(t *testing.T) {
	bare := newTestEnv(t)
	if res := bare.postRelay("anything", "aes128gcm", []byte("x")); res.StatusCode != 410 {
		t.Fatal(res.StatusCode)
	}
	if res := bare.do("GET", "/api/relay/anything", nil); res.StatusCode != 401 {
		t.Fatal(res.StatusCode)
	}
	e := newTestEnv(t, withLinks(nil))
	k := e.relayTo(e.linkHost("https://desk.example.ts.net"))
	res := e.postRelay(k.secret, "aes128gcm", sealed(t, k, push.Payload{Title: "desk · 승인 대기", Tag: "t1", URL: "/#/t/t1", Kind: "blocked"}))
	if res.StatusCode != 503 || decode[errorBody](t, res).Error.Kind != "unavailable" {
		t.Fatal(res.StatusCode)
	}
}
