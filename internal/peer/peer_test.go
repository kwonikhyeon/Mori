package peer_test

import (
	"bytes"
	"cmp"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/peer"
	"github.com/kwonikhyeon/mori/internal/store"
)

// fakeHost is another host's Mori as far as the hub sees it. Change its
// fields with with, so the race detector sees the handlers' reads ordered.
type fakeHost struct {
	srv  *httptest.Server
	code string

	mu        sync.Mutex
	reqs      []*http.Request
	tokens    int
	loggedOut []string
	pairedAs  string
	sub       map[string]any // the last push subscription asked for
	push      *http.Client   // what the host sends its test notification with; nil: it sends none
	hello     string
	subStatus int                   // the answer to POST /api/push/subscriptions; 0: 201
	onSub     func(endpoint string) // runs before a push subscription replaces the last; nil: none
}

func newFakeHost(t *testing.T, code string) *fakeHost {
	t.Helper()
	f := &fakeHost{code: code, hello: `{"app":"mori","version":"9.9.9","host":"desk","paired":false}`}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/hello", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		f.mu.Lock()
		defer f.mu.Unlock()
		io.WriteString(w, f.hello)
	})
	mux.HandleFunc("POST /api/pair", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		var body struct{ Code, Name string }
		json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		defer f.mu.Unlock()
		if body.Code != f.code {
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":{"kind":"invalid_params","message":"코드가 맞지 않거나 만료되었습니다"}}`)
			return
		}
		f.tokens++
		f.pairedAs = body.Name
		http.SetCookie(w, &http.Cookie{Name: auth.CookieName, Value: fmt.Sprintf("tok-%d", f.tokens), Path: "/", Secure: true, HttpOnly: true})
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/logout", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		c, err := r.Cookie(auth.CookieName)
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		f.with(func() { f.loggedOut = append(f.loggedOut, c.Value) })
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/push/subscriptions", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		var onSub func(string)
		f.with(func() { onSub = f.onSub })
		if onSub != nil {
			s, _ := body["subscription"].(map[string]any)
			endpoint, _ := s["endpoint"].(string)
			onSub(endpoint)
		}
		f.mu.Lock()
		f.sub = body
		status := cmp.Or(f.subStatus, http.StatusCreated)
		f.mu.Unlock()
		w.WriteHeader(status)
		if status != http.StatusCreated {
			io.WriteString(w, `{"error":{"kind":"unavailable","message":"알림이 꺼져 있습니다"}}`)
			return
		}
		io.WriteString(w, `{}`)
	})
	mux.HandleFunc("POST /api/push/test", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		f.mu.Lock()
		sub, client := f.sub, f.push
		f.mu.Unlock()
		sent := 0
		if s, ok := sub["subscription"].(map[string]any); ok && client != nil {
			endpoint, _ := s["endpoint"].(string)
			if res, err := client.Post(endpoint, "application/octet-stream", strings.NewReader("ciphertext")); err == nil {
				res.Body.Close()
				if res.StatusCode == http.StatusCreated {
					sent = 1
				}
			}
		}
		fmt.Fprintf(w, `{"sent":%d}`, sent)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeHost) record(r *http.Request) { f.with(func() { f.reqs = append(f.reqs, r) }) }

// with changes or reads the fake under its lock.
func (f *fakeHost) with(fn func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn()
}

func (f *fakeHost) requests() (out []*http.Request) {
	f.with(func() { out = slices.Clone(f.reqs) })
	return out
}

func (f *fakeHost) loggedOutTokens() (out []string) {
	f.with(func() { out = slices.Clone(f.loggedOut) })
	return out
}

func newManager(t *testing.T, o peer.Options) (*peer.Manager, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	o.Store = st
	if o.PublicURL == nil {
		o.PublicURL = func() string { return "http://hub.invalid" }
	}
	o.Listen = cmp.Or(o.Listen, "127.0.0.1:1") // a port httptest never gets
	o.HostName = cmp.Or(o.HostName, "macmini")
	o.Version = cmp.Or(o.Version, "test")
	o.Logger = slog.New(slog.DiscardHandler)
	return peer.New(o), st
}

func addHosts(t *testing.T, st *store.Store, hs ...store.Host) {
	t.Helper()
	if err := st.Update(func(s *store.State) error { s.Hosts = append(s.Hosts, hs...); return nil }); err != nil {
		t.Fatal(err)
	}
}

func kindOf(err error) string {
	var pe *peer.Error
	if errors.As(err, &pe) {
		return pe.Kind
	}
	return ""
}

func TestParseTarget(t *testing.T) {
	for _, tc := range []struct {
		in, origin, code string
		ok               bool
	}{
		{"https://desk.example.ts.net", "https://desk.example.ts.net", "", true},
		{"  https://Desk.Example.ts.net/  ", "https://desk.example.ts.net", "", true},
		{"HTTPS://desk.example.ts.net:443", "https://desk.example.ts.net", "", true},
		{"http://127.0.0.1:80", "http://127.0.0.1", "", true},
		{"http://127.0.0.1:7761", "http://127.0.0.1:7761", "", true},
		{"https://[::1]:443/", "https://[::1]", "", true},
		{"https://desk.example.ts.net/#/t/t1", "https://desk.example.ts.net", "", true}, // copied from the address bar
		{"https://desk.example.ts.net/pair#code=ABCD-EFGH", "https://desk.example.ts.net", "ABCD-EFGH", true},
		{"https://desk.example.ts.net/pair", "", "", false},
		{"https://desk.example.ts.net/api", "", "", false},
		{"https://desk.example.ts.net/?a=1", "", "", false},
		{"https://desk.example.ts.net?", "", "", false},
		{"https://user@desk.example.ts.net", "", "", false},
		{"ftp://desk.example.ts.net", "", "", false},
		{"desk.example.ts.net", "", "", false},
		{"https://", "", "", false},
		{"https://:443", "", "", false},
		{"", "", "", false},
	} {
		origin, code, err := peer.ParseTarget(tc.in)
		if (err == nil) != tc.ok || origin != tc.origin || code != tc.code {
			t.Errorf("ParseTarget(%q) = %q, %q, %v; want %q, %q, ok %v", tc.in, origin, code, err, tc.origin, tc.code, tc.ok)
		}
		if err != nil && kindOf(err) != "invalid_params" {
			t.Errorf("ParseTarget(%q): kind %q", tc.in, kindOf(err))
		}
	}
}

func TestLink(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	m, st := newManager(t, peer.Options{})
	v, created, err := m.Link(context.Background(), f.srv.URL, "ABCD-EFGH", "")
	if err != nil || !created {
		t.Fatalf("Link = %+v, %v, %v", v, created, err)
	}
	if !strings.HasPrefix(v.ID, "h_") || v.Name != "desk" || v.URL != f.srv.URL || !v.Linked || v.Version != "9.9.9" || v.LinkedMs == 0 {
		t.Fatalf("view %+v", v)
	}
	if v.Relay || !strings.Contains(v.RelayError, "https") { // the hub here is http://hub.invalid
		t.Fatalf("relay %v %q", v.Relay, v.RelayError)
	}
	if hs := st.Hosts(); len(hs) != 1 || hs[0].ID != v.ID || hs[0].Link.Token != "tok-1" {
		t.Fatalf("stored %+v", hs)
	}
	reqs := f.requests()
	if len(reqs) != 2 || reqs[0].URL.Path != "/api/hello" || reqs[1].URL.Path != "/api/pair" {
		t.Fatalf("%d requests", len(reqs))
	}
	for _, r := range reqs {
		if r.Header.Get("Origin") != f.srv.URL || r.UserAgent() != "mori-hub/test" || r.Header.Get("Cookie") != "" {
			t.Errorf("%s %s: Origin %q, User-Agent %q, Cookie %q", r.Method, r.URL.Path, r.Header.Get("Origin"), r.UserAgent(), r.Header.Get("Cookie"))
		}
	}
	f.with(func() {
		if f.pairedAs != "macmini 허브" {
			t.Errorf("paired as %q", f.pairedAs)
		}
	})
	// A pairing link carries its code; a name given wins over the host's.
	f2 := newFakeHost(t, "WXYZ-WXYZ")
	v2, created, err := m.Link(context.Background(), f2.srv.URL+"/pair#code=WXYZ-WXYZ", "", " 연구실 ")
	if err != nil || !created || v2.Name != "연구실" || v2.ID == v.ID {
		t.Fatalf("Link with a pairing link = %+v, %v, %v", v2, created, err)
	}
}

func TestLinkErrors(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	m, st := newManager(t, peer.Options{PublicURL: func() string { return "https://macmini.example.ts.net" }})
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	notMori := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"app":"other"}`) }))
	t.Cleanup(notMori.Close)
	noHello := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(noHello.Close)
	limited := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/hello" {
			io.WriteString(w, `{"app":"mori","version":"9.9.9","host":"desk"}`)
			return
		}
		w.WriteHeader(http.StatusTooManyRequests)
		io.WriteString(w, `{"error":{"kind":"rate_limited","message":"실패가 너무 많습니다. 10분 뒤에 다시 시도하세요"}}`)
	}))
	t.Cleanup(limited.Close)
	for _, tc := range []struct{ name, url, code, as, kind, msg string }{
		{"wrong code", f.srv.URL, "WXYZ-WXYZ", "", "invalid_params", "코드가 맞지 않거나"},
		{"no code", f.srv.URL, "", "", "invalid_params", "mori pair"},
		{"a long name", f.srv.URL, "ABCD-EFGH", strings.Repeat("가", 101), "invalid_params", "1~100자"},
		{"not Mori", notMori.URL, "ABCD-EFGH", "", "invalid_params", "Mori가 아닙니다"},
		{"no hello", noHello.URL, "ABCD-EFGH", "", "invalid_params", "Mori가 아닙니다"},
		{"unreachable", closed.URL, "ABCD-EFGH", "", "host_unreachable", "닿지 못했습니다"},
		{"too many tries", limited.URL, "ABCD-EFGH", "", "rate_limited", "10분 뒤에"},
		{"its listen address", "http://127.0.0.1:1", "ABCD-EFGH", "", "invalid_params", "자신"},
		{"localhost", "http://localhost:1", "ABCD-EFGH", "", "invalid_params", "자신"},
		{"its public URL", "https://MACMINI.example.ts.net:443/", "ABCD-EFGH", "", "invalid_params", "자신"},
		{"a path", f.srv.URL + "/api", "ABCD-EFGH", "", "invalid_params", "https://호스트"},
	} {
		_, _, err := m.Link(context.Background(), tc.url, tc.code, tc.as)
		if kindOf(err) != tc.kind || !strings.Contains(fmt.Sprint(err), tc.msg) {
			t.Errorf("%s: %v (kind %q), want %s with %q", tc.name, err, kindOf(err), tc.kind, tc.msg)
		}
	}
	if hs := st.Hosts(); len(hs) != 0 {
		t.Fatalf("a failed link was kept: %+v", hs)
	}
	if n := len(f.requests()); n != 2 { // the wrong code's hello and pair; the rest stop before asking
		t.Errorf("the host got %d requests", n)
	}
}

func TestRelink(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	m, st := newManager(t, peer.Options{})
	ctx := context.Background()
	first, _, err := m.Link(ctx, f.srv.URL, "ABCD-EFGH", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Rename(first.ID, "책상"); err != nil {
		t.Fatal(err)
	}
	again, created, err := m.Link(ctx, strings.ToUpper(f.srv.URL)+"/", "ABCD-EFGH", "")
	if err != nil || created || again.ID != first.ID || again.Name != "책상" {
		t.Fatalf("relink = %+v, created %v, %v", again, created, err)
	}
	if hs := st.Hosts(); len(hs) != 1 || hs[0].Link.Token != "tok-2" || hs[0].URL != f.srv.URL {
		t.Fatalf("stored %+v", hs)
	}
	if lo := f.loggedOutTokens(); !slices.Equal(lo, []string{"tok-1"}) {
		t.Fatalf("logged out %v, want the old token", lo)
	}
	third, created, err := m.Link(ctx, f.srv.URL, "ABCD-EFGH", "새 이름")
	if err != nil || created || third.ID != first.ID || third.Name != "새 이름" {
		t.Fatalf("relink with a name = %+v, %v, %v", third, created, err)
	}
}

func TestUnlink(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	m, st := newManager(t, peer.Options{})
	ctx := context.Background()
	v, _, err := m.Link(ctx, f.srv.URL, "ABCD-EFGH", "")
	if err != nil {
		t.Fatal(err)
	}
	gone, err := m.Unlink(ctx, v.ID)
	if err != nil || gone.ID != v.ID || gone.Name != "desk" {
		t.Fatalf("Unlink = %+v, %v", gone, err)
	}
	if len(st.Hosts()) != 0 || !slices.Equal(f.loggedOutTokens(), []string{"tok-1"}) {
		t.Fatalf("hosts %+v, logged out %v", st.Hosts(), f.loggedOutTokens())
	}
	if _, err := m.Unlink(ctx, v.ID); kindOf(err) != "not_found" {
		t.Errorf("Unlink again: %v", err)
	}
	// A host that cannot be reached is forgotten all the same.
	v2, _, err := m.Link(ctx, f.srv.URL, "ABCD-EFGH", "")
	if err != nil {
		t.Fatal(err)
	}
	f.srv.Close()
	if _, err := m.Unlink(ctx, v2.ID); err != nil || len(st.Hosts()) != 0 {
		t.Fatalf("Unlink of an unreachable host: %v, %+v", err, st.Hosts())
	}
}

func TestRename(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	m, _ := newManager(t, peer.Options{})
	v, _, err := m.Link(context.Background(), f.srv.URL, "ABCD-EFGH", "")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := m.Rename(v.ID, "  책상\t컴퓨터\n"); err != nil || got.Name != "책상 컴퓨터" || got.ID != v.ID || !got.Linked {
		t.Fatalf("Rename = %+v, %v", got, err)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("가", 101)} {
		if _, err := m.Rename(v.ID, bad); kindOf(err) != "invalid_params" {
			t.Errorf("Rename(%q): %v", bad, err)
		}
	}
	if _, err := m.Rename("h_nope0000", "x"); kindOf(err) != "not_found" {
		t.Errorf("Rename of no host: %v", err)
	}
	if got := m.Views(); len(got) != 1 || got[0].Name != "책상 컴퓨터" {
		t.Fatalf("Views %+v", got)
	}
}

func TestSetupRelay(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	// The hub's public side, started after the manager exists.
	receiver := httptest.NewUnstartedServer(nil)
	pub := "https://" + receiver.Listener.Addr().String()
	m, st := newManager(t, peer.Options{PublicURL: func() string { return pub }})
	var mu sync.Mutex
	var hits []string // host IDs the host's test notifications found
	receiver.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secret, _ := strings.CutPrefix(r.URL.Path, "/api/relay/")
		id, key, authSecret, ok := m.Relay(secret)
		if !ok {
			w.WriteHeader(http.StatusGone)
			return
		}
		var keys map[string]any
		f.with(func() { keys, _ = f.sub["subscription"].(map[string]any)["keys"].(map[string]any) })
		enc := base64.RawURLEncoding
		if keys["p256dh"] != enc.EncodeToString(key.PublicKey().Bytes()) || keys["auth"] != enc.EncodeToString(authSecret) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		hits = append(hits, id)
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	})
	receiver.StartTLS()
	t.Cleanup(receiver.Close)
	f.with(func() { f.push = receiver.Client() })

	ctx := context.Background()
	v, _, err := m.Link(ctx, f.srv.URL, "ABCD-EFGH", "")
	if err != nil || !v.Relay || v.RelayError != "" {
		t.Fatalf("Link = %+v, %v", v, err)
	}
	mu.Lock()
	if !slices.Equal(hits, []string{v.ID}) {
		t.Fatalf("test notifications reached %v", hits)
	}
	mu.Unlock()
	var sub map[string]any
	f.with(func() { sub = f.sub })
	endpoint, _ := sub["subscription"].(map[string]any)["endpoint"].(string)
	secret, ok := strings.CutPrefix(endpoint, pub+"/api/relay/")
	if !ok || len(secret) != 43 { // 32 random bytes, base64url
		t.Fatalf("endpoint %q", endpoint)
	}
	if got := fmt.Sprint(sub["kinds"]); got != "[blocked waiting error exited]" {
		t.Errorf("kinds %s", got)
	}
	r := st.Hosts()[0].Link.Relay
	if !r.OK || r.Secret != secret || r.Base != pub || r.Error != "" {
		t.Fatalf("stored relay %+v", r)
	}
	for _, req := range f.requests()[2:] { // subscribe and test go with the hub's token
		if c, err := req.Cookie(auth.CookieName); err != nil || c.Value != "tok-1" || req.Header.Get("Origin") != f.srv.URL {
			t.Errorf("%s %s without the hub's token or Origin", req.Method, req.URL.Path)
		}
	}
	// Setting it up again makes a new key and secret; the old secret finds nothing.
	again, err := m.SetupRelay(ctx, v.ID)
	if err != nil || !again.Relay {
		t.Fatalf("SetupRelay = %+v, %v", again, err)
	}
	if r2 := st.Hosts()[0].Link.Relay; r2.Secret == r.Secret || r2.Key == r.Key || r2.Auth == r.Auth {
		t.Fatalf("SetupRelay kept the old keys")
	}
	if _, _, _, ok := m.Relay(r.Secret); ok {
		t.Error("the old secret still finds the host")
	}
	if _, err := m.SetupRelay(ctx, "h_nope0000"); kindOf(err) != "not_found" {
		t.Errorf("SetupRelay of no host: %v", err)
	}
}

// Two relay setups of one host at once, or a link and a relay setup, must
// not leave the hub saying the relay is on while the host sends to a secret
// the hub no longer holds.
func TestRelaySetupsAtOnce(t *testing.T) {
	for _, tc := range []struct {
		name  string
		other func(m *peer.Manager, f *fakeHost) // runs beside a relay setup
	}{
		{"two relay setups", func(m *peer.Manager, _ *fakeHost) { m.SetupRelay(context.Background(), "h_desk0001") }},
		{"a link and a relay setup", func(m *peer.Manager, f *fakeHost) { m.Link(context.Background(), f.srv.URL, "ABCD-EFGH", "") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeHost(t, "ABCD-EFGH")
			receiver := httptest.NewUnstartedServer(nil)
			pub := "https://" + receiver.Listener.Addr().String()
			m, st := newManager(t, peer.Options{PublicURL: func() string { return pub }})
			addHosts(t, st, store.Host{ID: "h_desk0001", Name: "desk", URL: f.srv.URL, Link: store.HostLink{Token: "tok-0", Version: "9.9.9"}})
			tested := make(chan struct{}) // a test notification found the secret the hub holds
			var once sync.Once
			receiver.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if _, _, _, ok := m.Relay(strings.TrimPrefix(r.URL.Path, "/api/relay/")); !ok {
					w.WriteHeader(http.StatusGone)
					return
				}
				once.Do(func() { close(tested) })
				w.WriteHeader(http.StatusCreated)
			})
			receiver.StartTLS()
			t.Cleanup(receiver.Close)
			// When the two meet at the host, the one whose secret the hub
			// holds subscribes first, and the other then replaces it.
			met := make(chan struct{})
			var arrived atomic.Int32
			f.with(func() {
				f.push = receiver.Client()
				f.onSub = func(endpoint string) {
					if arrived.Add(1) == 2 {
						close(met)
					}
					select {
					case <-met:
					case <-time.After(500 * time.Millisecond): // alone: nothing to order
						return
					}
					if _, _, _, ok := m.Relay(strings.TrimPrefix(endpoint, pub+"/api/relay/")); !ok {
						select {
						case <-tested:
						case <-time.After(5 * time.Second):
						}
					}
				}
			})
			var wg sync.WaitGroup
			wg.Go(func() { tc.other(m, f) })
			wg.Go(func() { m.SetupRelay(context.Background(), "h_desk0001") })
			wg.Wait()
			r := st.Hosts()[0].Link.Relay
			var endpoint string
			f.with(func() { endpoint, _ = f.sub["subscription"].(map[string]any)["endpoint"].(string) })
			if same := endpoint == pub+"/api/relay/"+r.Secret; !r.OK || !same {
				t.Fatalf("relay ok %v, the host sends to the secret the hub holds: %v", r.OK, same)
			}
			if v := m.Views()[0]; !v.Relay {
				t.Fatalf("%+v", v)
			}
		})
	}
}

func TestRelayFailureKept(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	f.with(func() { f.subStatus = http.StatusServiceUnavailable })
	m, st := newManager(t, peer.Options{PublicURL: func() string { return "https://macmini.example.ts.net" }})
	ctx := context.Background()
	v, created, err := m.Link(ctx, f.srv.URL, "ABCD-EFGH", "")
	if err != nil || !created || !v.Linked || v.Relay || !strings.Contains(v.RelayError, "알림 중계를 받지 않았습니다: 알림이 꺼져 있습니다") {
		t.Fatalf("Link = %+v, %v", v, err)
	}
	if r := st.Hosts()[0].Link.Relay; r.OK || r.Secret == "" || r.Error == "" {
		t.Fatalf("stored relay %+v", r)
	}
	// The host takes the subscription, but its test notification never comes back.
	f.with(func() { f.subStatus = 0 })
	v, err = m.SetupRelay(ctx, v.ID)
	if err != nil || v.Relay || !strings.Contains(v.RelayError, "시험 알림이 허브에 오지 않았습니다") {
		t.Fatalf("SetupRelay = %+v, %v", v, err)
	}
}

func TestRelayBaseChanged(t *testing.T) {
	var mu sync.Mutex
	pub := "https://macmini.example.ts.net"
	now := time.UnixMilli(1_700_000_000_000)
	m, st := newManager(t, peer.Options{
		PublicURL: func() string { mu.Lock(); defer mu.Unlock(); return pub },
		Now:       func() time.Time { mu.Lock(); defer mu.Unlock(); return now },
	})
	addHosts(t, st, store.Host{ID: "h_desk0001", Name: "desk", URL: "https://desk.example.ts.net", Link: store.HostLink{Token: "tok", Version: "9.9.9",
		Relay: store.Relay{Secret: "s", Key: "k", Auth: "a", Base: "https://macmini.example.ts.net", OK: true}}})
	if v := m.Views()[0]; !v.Relay || v.RelayError != "" {
		t.Fatalf("%+v", v)
	}
	mu.Lock()
	pub = "https://mini.example.ts.net/"
	mu.Unlock()
	if v := m.Views()[0]; !v.Relay {
		t.Fatalf("read the public URL again within a minute: %+v", v)
	}
	mu.Lock()
	now = now.Add(time.Minute + time.Second)
	mu.Unlock()
	if v := m.Views()[0]; v.Relay || !strings.Contains(v.RelayError, "허브 주소가 바뀌었습니다") {
		t.Fatalf("%+v", v)
	}
}

func TestViewsHideSecrets(t *testing.T) {
	hs := []store.Host{
		{ID: "h_1", Name: "desk", URL: "https://desk.example.ts.net", Link: store.HostLink{Token: "tok-secret", Version: "9.9.9", LinkedMs: 5,
			Relay: store.Relay{Secret: "relay-secret", Key: "relay-key", Auth: "relay-auth", Base: "https://macmini.example.ts.net", OK: true}}},
		{ID: "h_2", Name: "lab", URL: "https://lab.example.ts.net"},
	}
	b, err := json.Marshal(peer.Views(hs, "https://macmini.example.ts.net"))
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"id":"h_1","name":"desk","url":"https://desk.example.ts.net","linked":true,"version":"9.9.9","relay":true,"linked_ms":5},` +
		`{"id":"h_2","name":"lab","url":"https://lab.example.ts.net","linked":false,"version":"","relay":false}]`
	if string(b) != want {
		t.Fatalf("%s\nwant %s", b, want)
	}
	if got := peer.Views(nil, ""); got == nil || len(got) != 0 {
		t.Fatalf("%#v", got)
	}
}

func TestRelayLookup(t *testing.T) {
	m, st := newManager(t, peer.Options{})
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	authSecret := make([]byte, 16)
	rand.Read(authSecret)
	enc := base64.RawURLEncoding
	addHosts(t, st,
		store.Host{ID: "h_desk0001", Name: "desk", URL: "https://desk.example.ts.net", Link: store.HostLink{Token: "tok",
			Relay: store.Relay{Secret: "s3cr3t", Key: enc.EncodeToString(key.Bytes()), Auth: enc.EncodeToString(authSecret), Base: "https://macmini.example.ts.net"}}},
		store.Host{ID: "h_lab00001", Name: "lab", URL: "https://lab.example.ts.net", Link: store.HostLink{Relay: store.Relay{Secret: "unlinked"}}})
	id, k, a, ok := m.Relay("s3cr3t") // OK is still false: it answers while the relay is set up
	if !ok || id != "h_desk0001" || !bytes.Equal(k.Bytes(), key.Bytes()) || !bytes.Equal(a, authSecret) {
		t.Fatalf("Relay = %q, %v", id, ok)
	}
	for _, s := range []string{"", "s3cr3", "s3cr3tt", "unlinked"} {
		if _, _, _, ok := m.Relay(s); ok {
			t.Errorf("Relay(%q) found a host", s)
		}
	}
}

func TestLookup(t *testing.T) {
	m, st := newManager(t, peer.Options{})
	addHosts(t, st,
		store.Host{ID: "h_1", Name: "desk", URL: "https://desk.example.ts.net"},
		store.Host{ID: "h_2", Name: "lab", URL: "https://lab.example.ts.net"},
		store.Host{ID: "h_3", Name: "lab", URL: "https://lab2.example.ts.net"},
		store.Host{ID: "h_4", Name: "h_1", URL: "https://odd.example.ts.net"})
	if v, err := m.Lookup("h_1"); err != nil || v.Name != "desk" { // an ID wins over a name
		t.Errorf("Lookup(h_1) = %+v, %v", v, err)
	}
	if v, err := m.Lookup("desk"); err != nil || v.ID != "h_1" {
		t.Errorf("Lookup(desk) = %+v, %v", v, err)
	}
	if _, err := m.Lookup("lab"); kindOf(err) != "invalid_params" || !strings.Contains(err.Error(), "h_2, h_3") {
		t.Errorf("Lookup(lab): %v", err)
	}
	if _, err := m.Lookup("nope"); kindOf(err) != "not_found" || !strings.Contains(err.Error(), "mori hosts") {
		t.Errorf("Lookup(nope): %v", err)
	}
}

func TestMarkUnlinked(t *testing.T) {
	m, st := newManager(t, peer.Options{})
	addHosts(t, st, store.Host{ID: "h_desk0001", Name: "desk", URL: "https://desk.example.ts.net", Link: store.HostLink{Token: "new", Version: "9.9.9"}})
	m.MarkUnlinked("h_desk0001", "old") // a newer link replaced the token the host refused
	if st.Hosts()[0].Link.Token != "new" {
		t.Fatal("forgot a newer token")
	}
	m.MarkUnlinked("h_desk0001", "new")
	if h := st.Hosts()[0]; h.Link != (store.HostLink{}) || h.Name != "desk" {
		t.Fatalf("%+v", h)
	}
	m.MarkUnlinked("h_nope0000", "new") // no such host: nothing happens
	if v := m.Views()[0]; v.Linked || v.Version != "" {
		t.Fatalf("%+v", v)
	}
}
