package server

import (
	"bufio"
	"cmp"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/peer"
	"github.com/kwonikhyeon/mori/internal/store"
)

// hostSaw is what a host got from the hub.
type hostSaw struct {
	Method, Path, RawQuery, Proto string
	Header                        http.Header
	Body                          int64
}

// fakePeer is another host's Mori behind the hub. It answers each API with
// what it got, or with an error body when status is an error, and echoes
// on /ws/events.
type fakePeer struct {
	mu     sync.Mutex
	status int // 0: 200
	got    []hostSaw
	ended  chan struct{} // an echo socket ended
}

func newFakePeer(t *testing.T) (*fakePeer, *httptest.Server) {
	t.Helper()
	p := &fakePeer{ended: make(chan struct{}, 8)}
	srv := httptest.NewServer(p)
	t.Cleanup(srv.Close)
	return p, srv
}

func (p *fakePeer) answer(status int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.status = status
}

func (p *fakePeer) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.got)
}

func (p *fakePeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	n, err := io.Copy(io.Discard, r.Body)
	if err != nil {
		return // the hub gave up on the body
	}
	saw := hostSaw{Method: r.Method, Path: r.URL.EscapedPath(), RawQuery: r.URL.RawQuery, Proto: r.Proto, Header: r.Header.Clone(), Body: n}
	p.mu.Lock()
	p.got = append(p.got, saw)
	status := cmp.Or(p.status, http.StatusOK)
	p.mu.Unlock()
	switch {
	case status >= 400:
		writeJSON(w, status, map[string]any{"error": map[string]string{"kind": "core_unavailable", "message": "그 호스트의 오류"}})
	case r.URL.Path == "/ws/events":
		p.echo(w, r)
	default:
		w.Header().Set("Set-Cookie", "evil=1")
		w.Header().Set("Content-Security-Policy", "default-src *")
		writeJSON(w, status, saw)
	}
}

func (p *fakePeer) echo(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, nil) // nil: Origin must be this host, which the hub says it is
	if err != nil {
		return
	}
	defer func() {
		select {
		case p.ended <- struct{}{}:
		default:
		}
	}()
	defer c.CloseNow()
	for {
		typ, b, err := c.Read(context.Background())
		if err != nil {
			return
		}
		if err := c.Write(context.Background(), typ, b); err != nil {
			return
		}
	}
}

// linkHost puts a host at origin in the hub's state as linked, with the
// token "tok", and returns its ID.
func (e *testEnv) linkHost(origin string) string {
	e.t.Helper()
	var id string
	if err := e.store.Update(func(st *store.State) error {
		id = fmt.Sprintf("h_peer%04d", len(st.Hosts)+1)
		st.Hosts = append(st.Hosts, store.Host{ID: id, Name: "desk", URL: origin,
			Link: store.HostLink{Token: "tok", Version: "9.9.9", LinkedMs: 1}})
		return nil
	}); err != nil {
		e.t.Fatal(err)
	}
	return id
}

// openSockets counts the sockets the hub would cut on revoke or stop.
func (e *testEnv) openSockets() int {
	e.s.hub.mu.Lock()
	defer e.s.hub.mu.Unlock()
	n := 0
	for _, cs := range e.s.hub.conns {
		n += len(cs)
	}
	return n
}

// echoes checks that c gets back what it sends.
func echoes(t *testing.T, c *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), wsWait)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, []byte("안녕")); err != nil {
		t.Fatal(err)
	}
	if _, b, err := c.Read(ctx); err != nil || string(b) != "안녕" {
		t.Fatalf("%q %v", b, err)
	}
}

func TestProxyForwardsWithHubCookie(t *testing.T) {
	p, peerSrv := newFakePeer(t)
	e := newTestEnv(t, withLinks(nil))
	e.pair()
	id := e.linkHost(peerSrv.URL)

	req, err := http.NewRequest("GET", e.srv.URL+"/h/"+id+"/api/terminals/machine%2Ft7?x=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", e.srv.URL)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "ko")
	req.Header.Set("Authorization", "Bearer phone")
	req.Header.Set("X-Forwarded-For", "10.0.0.9")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: e.token})
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatal(res.StatusCode)
	}
	saw := decode[hostSaw](t, res)
	if saw.Method != "GET" || saw.Path != "/api/terminals/machine%2Ft7" || saw.RawQuery != "x=1" {
		t.Fatalf("%+v", saw)
	}
	if c := saw.Header.Values("Cookie"); len(c) != 1 || c[0] != auth.CookieName+"=tok" {
		t.Fatalf("the host got the cookie %q, want the hub's own", c)
	}
	if saw.Header.Get("Origin") != peerSrv.URL || saw.Header.Get("User-Agent") != "mori-hub/test" || saw.Header.Get("Accept") != "application/json" {
		t.Fatalf("%v", saw.Header)
	}
	for k := range saw.Header {
		if !slices.Contains([]string{"Accept", "Accept-Encoding", "Cookie", "Origin", "User-Agent"}, k) {
			t.Errorf("the host got %s: %q", k, saw.Header[k])
		}
	}
	for _, c := range res.Cookies() {
		if c.Name == "evil" {
			t.Error("the host's cookie reached the phone")
		}
	}
	if csp := res.Header.Values("Content-Security-Policy"); len(csp) != 1 || csp[0] == "default-src *" {
		t.Errorf("CSP %q, want the hub's own", csp)
	}
	if p.count() != 1 {
		t.Fatal(p.count())
	}
}

func TestProxyAllowlist(t *testing.T) {
	p, peerSrv := newFakePeer(t)
	e := newTestEnv(t, withLinks(nil))
	e.pair()
	h := "/h/" + e.linkHost(peerSrv.URL)
	for _, c := range []struct{ method, path string }{
		{"POST", "/api/pair"}, {"POST", "/api/logout"}, {"GET", "/api/devices"}, {"DELETE", "/api/devices/d_1"},
		{"POST", "/api/pair-codes"}, {"GET", "/api/hosts"}, {"POST", "/api/hosts"}, {"GET", "/api/push/key"},
		{"POST", "/api/push/subscriptions"}, {"POST", "/api/push/test"}, {"POST", "/api/relay/abc"},
		{"DELETE", "/api/presets"}, {"GET", h + "/api/hello"}, {"GET", "/"}, {"GET", "/api/nope"},
	} {
		if eb := e.expectError(c.method, h+c.path, nil, http.StatusNotFound); eb.Error.Kind != "not_found" {
			t.Errorf("%s %s: %+v", c.method, c.path, eb)
		}
	}
	if n := p.count(); n != 0 {
		t.Fatalf("the host got %d requests", n)
	}
	e.json("GET", h+"/api/hello", nil, http.StatusOK, nil)
	if p.count() != 1 {
		t.Fatal(p.count())
	}
}

func TestProxyHostErrors(t *testing.T) {
	p, peerSrv := newFakePeer(t)
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	e := newTestEnv(t, withLinks(nil))
	e.pair()
	id, goneID := e.linkHost(peerSrv.URL), e.linkHost(gone.URL)

	if eb := e.expectError("GET", "/h/h_nope0000/api/hello", nil, http.StatusNotFound); eb.Error.Kind != "not_found" {
		t.Fatal(eb)
	}
	if eb := e.expectError("GET", "/h/"+goneID+"/api/overview", nil, http.StatusBadGateway); eb.Error.Kind != "host_unreachable" || eb.Error.Message != "desk에 닿지 못했습니다" {
		t.Fatal(eb)
	}
	p.answer(http.StatusServiceUnavailable) // the host's own errors pass through
	if eb := e.expectError("GET", "/h/"+id+"/api/overview", nil, http.StatusServiceUnavailable); eb.Error.Kind != "core_unavailable" || eb.Error.Message != "그 호스트의 오류" {
		t.Fatal(eb)
	}

	p.answer(http.StatusUnauthorized) // the host revoked the hub
	if eb := e.expectError("GET", "/h/"+id+"/api/overview", nil, http.StatusConflict); eb.Error.Kind != "host_unlinked" {
		t.Fatal(eb)
	}
	var hello struct{ Paired bool }
	e.json("GET", "/api/hello", nil, http.StatusOK, &hello)
	if !hello.Paired {
		t.Fatal("the phone lost its pairing with the hub")
	}
	var hosts []peer.View
	e.json("GET", "/api/hosts", nil, http.StatusOK, &hosts)
	if i := slices.IndexFunc(hosts, func(v peer.View) bool { return v.ID == id }); i < 0 || hosts[i].Linked {
		t.Fatalf("%+v", hosts)
	}
	n := p.count()
	if eb := e.expectError("GET", "/h/"+id+"/api/overview", nil, http.StatusConflict); eb.Error.Kind != "host_unlinked" || p.count() != n {
		t.Fatal(eb, p.count()) // without a token the hub does not ask
	}

	e.token = ""
	e.expectError("GET", "/h/"+id+"/api/hello", nil, http.StatusUnauthorized)

	plain := newTestEnv(t) // a Mori that links to no one
	plain.pair()
	if eb := plain.expectError("GET", "/h/h_peer0001/api/hello", nil, http.StatusServiceUnavailable); eb.Error.Kind != "unavailable" {
		t.Fatal(eb)
	}
}

func TestProxyBodyLimit(t *testing.T) {
	p, peerSrv := newFakePeer(t)
	e := newTestEnv(t, withLinks(nil))
	e.pair()
	files := "/h/" + e.linkHost(peerSrv.URL) + "/api/terminals/t1/files"

	res := e.upload(files, "file", "big.bin", make([]byte, maxUpload)) // the most a host takes
	if res.StatusCode != http.StatusOK {
		t.Fatal(res.StatusCode)
	}
	if saw := decode[hostSaw](t, res); saw.Body < maxUpload {
		t.Fatalf("the host read %d bytes", saw.Body)
	}

	n := p.count()
	big := strings.Repeat("x", 11<<20)
	if eb := e.expectError("POST", files, big, http.StatusRequestEntityTooLarge); eb.Error.Kind != "too_large" {
		t.Fatal(eb)
	}
	req, err := http.NewRequest("POST", e.srv.URL+files, io.MultiReader(strings.NewReader(big))) // no length: chunked
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", e.srv.URL)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: e.token})
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatal(res.StatusCode)
	}
	if p.count() != n {
		t.Fatal("the host took a body over the limit")
	}
}

func TestProxyWebSocket(t *testing.T) {
	p, peerSrv := newFakePeer(t)
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	e := newTestEnv(t, withLinks(nil))
	dev := e.pair()
	id, goneID := e.linkHost(peerSrv.URL), e.linkHost(gone.URL)

	c := e.dialWS("/h/" + id + "/ws/events")
	echoes(t, c)
	if n := e.openSockets(); n != 1 {
		t.Fatalf("%d sockets", n)
	}
	if err := e.auth.Revoke(dev.ID); err != nil {
		t.Fatal(err)
	}
	if code := readUntilClosed(t, c); code != -1 {
		t.Fatalf("closed with %d; a revoked device's relayed socket is cut without a code", code)
	}
	select {
	case <-p.ended:
	case <-time.After(wsWait):
		t.Fatal("the host's socket is still open")
	}
	e.eventually(func() bool { return e.openSockets() == 0 })

	e.pair()
	refused := func(path string, want websocket.StatusCode) {
		t.Helper()
		c, _, err := e.tryWS(e.srv.URL, path)
		if err != nil {
			t.Fatal(path, err)
		}
		defer c.CloseNow()
		if code := readUntilClosed(t, c); code != want {
			t.Errorf("%s: closed with %d, want %d", path, code, want)
		}
	}
	refused("/h/h_nope0000/ws/events", closeUnknownHost)
	refused("/h/"+url.PathEscape(strings.Repeat("가", 60))+"/ws/events", closeUnknownHost) // its reason is cut to fit
	refused("/h/"+goneID+"/ws/events", closeHostUnreachable)
	p.answer(http.StatusUnauthorized)
	refused("/h/"+id+"/ws/events", closeUnauthorized) // the host revoked the hub
	refused("/h/"+id+"/ws/events", closeUnauthorized) // and now the hub has no token for it
	e.token = ""
	refused("/h/"+id+"/ws/events", closeUnauthorized) // the phone is not paired
}

// closeFrame is a close frame with code 4000, as a host sends it.
const closeFrame = "\x88\x02\x0f\xa0"

func TestTunnelEndsWhenHostCloses(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() { // a host that ends the socket as soon as it opens
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		if _, err := http.ReadRequest(bufio.NewReader(c)); err != nil {
			return
		}
		io.WriteString(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
			"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"+closeFrame)
	}()
	e := newTestEnv(t, withLinks(nil))
	e.pair()
	id := e.linkHost("http://" + ln.Addr().String())

	phone, err := net.Dial("tcp", e.srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer phone.Close() // the phone stays silent: it never closes on its own
	fmt.Fprintf(phone, "GET /h/%s/ws/events HTTP/1.1\r\nHost: %s\r\nOrigin: %s\r\nCookie: %s=%s\r\n"+
		"Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
		id, e.srv.Listener.Addr(), e.srv.URL, auth.CookieName, e.token)
	phone.SetReadDeadline(time.Now().Add(wsWait))
	br := bufio.NewReader(phone)
	res, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatal(res.Status)
	}
	if rest, err := io.ReadAll(br); err != nil || string(rest) != closeFrame {
		t.Fatalf("%q %v; want the host's close frame, then the end", rest, err)
	}
	e.eventually(func() bool { return e.openSockets() == 0 })

	// The other way round: the phone goes away without a word.
	p, peerSrv := newFakePeer(t)
	c := e.dialWS("/h/" + e.linkHost(peerSrv.URL) + "/ws/events")
	echoes(t, c)
	c.CloseNow()
	select {
	case <-p.ended:
	case <-time.After(wsWait):
		t.Fatal("the host's socket is still open")
	}
	e.eventually(func() bool { return e.openSockets() == 0 })
}

func TestProxyOverHTTP2Host(t *testing.T) {
	p := &fakePeer{ended: make(chan struct{}, 8)}
	peerSrv := httptest.NewUnstartedServer(p)
	peerSrv.EnableHTTP2 = true // like tailscale serve: h2 offered, HTTP/1.1 still taken
	peerSrv.StartTLS()
	t.Cleanup(peerSrv.Close)
	e := newTestEnv(t, withLinks(peerSrv.Client().Transport.(*http.Transport).TLSClientConfig))
	e.pair()
	id := e.linkHost(peerSrv.URL)

	var saw hostSaw
	e.json("GET", "/h/"+id+"/api/hello", nil, http.StatusOK, &saw)
	if saw.Proto != "HTTP/1.1" {
		t.Fatal(saw.Proto)
	}
	echoes(t, e.dialWS("/h/"+id+"/ws/events"))
}

func TestIsWS(t *testing.T) {
	for path, want := range map[string]bool{
		"/ws/events":              true,
		"/ws/attach":              true,
		"/h/h_peer0001/ws/events": true,
		"/h/h_peer0001/api/hello": false,
		"/api/hello":              false,
		"/h/ws/events":            false,
		"/h/":                     false,
	} {
		if isWS(path) != want {
			t.Errorf("isWS(%q) = %v", path, !want)
		}
	}
}

func TestCloseReason(t *testing.T) {
	long := strings.Repeat("가", 60)
	if r := closeReason(long); len(r) != 123 || !utf8.ValidString(r) || !strings.HasPrefix(long, r) {
		t.Fatalf("%d bytes: %q", len(r), r)
	}
	if r := closeReason("짧은 이유"); r != "짧은 이유" {
		t.Fatal(r)
	}
}
