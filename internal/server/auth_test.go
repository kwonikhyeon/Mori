package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/store"
)

type testEnv struct {
	t     *testing.T
	srv   *httptest.Server
	s     *Server
	auth  *auth.Auth
	store *store.Store
	token string // the paired device's cookie, once pair has run
}

func newTestEnv(t *testing.T, opts ...func(*Deps)) *testEnv {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	a := auth.New(st, auth.Options{})
	discard := slog.New(slog.DiscardHandler)
	d := Deps{Version: "test", HostName: "testhost", Store: st, Auth: a, UI: http.NotFoundHandler(), Logger: discard,
		Core: core.New(core.Options{Logger: discard})} // never started: the core is down
	for _, o := range opts {
		o(&d)
	}
	s := New(d)
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return &testEnv{t: t, srv: srv, s: s, auth: a, store: st}
}

// do sends a request with the device cookie (if paired) and a same-origin
// Origin header. A string body goes as is; anything else as JSON.
func (e *testEnv) do(method, path string, body any) *http.Response {
	e.t.Helper()
	return e.doFrom(e.srv.URL, method, path, body)
}

func (e *testEnv) doFrom(origin, method, path string, body any) *http.Response {
	e.t.Helper()
	var r io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		r = strings.NewReader(b)
	default:
		j, err := json.Marshal(b)
		if err != nil {
			e.t.Fatal(err)
		}
		r = bytes.NewReader(j)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, r)
	if err != nil {
		e.t.Fatal(err)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if e.token != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: e.token})
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { res.Body.Close() })
	return res
}

// pair pairs a new device through the API and makes it the one do uses.
func (e *testEnv) pair() store.Device {
	e.t.Helper()
	code := e.auth.NewCode("test")
	res := e.do("POST", "/api/pair", map[string]string{"code": code.Code, "name": "tester"})
	if res.StatusCode != 204 {
		e.t.Fatalf("pair %d", res.StatusCode)
	}
	for _, c := range res.Cookies() {
		if c.Name == auth.CookieName {
			e.token = c.Value
		}
	}
	ds := e.auth.Devices()
	return ds[len(ds)-1]
}

// dialWS opens a WebSocket as the paired device.
func (e *testEnv) dialWS(path string) *websocket.Conn {
	e.t.Helper()
	c, res, err := e.tryWS(e.srv.URL, path)
	if err != nil {
		e.t.Fatalf("dial %s: %v (%v)", path, err, res)
	}
	e.t.Cleanup(func() { c.CloseNow() })
	return c
}

func (e *testEnv) tryWS(origin, path string) (*websocket.Conn, *http.Response, error) {
	h := http.Header{"Origin": {origin}}
	if e.token != "" {
		h.Set("Cookie", (&http.Cookie{Name: auth.CookieName, Value: e.token}).String())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(e.srv.URL, "http")+path, &websocket.DialOptions{HTTPHeader: h})
}

// readUntilClosed reads until the server closes c and returns the code.
func readUntilClosed(t *testing.T, c *websocket.Conn) websocket.StatusCode {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

func decode[T any](t *testing.T, res *http.Response) T {
	t.Helper()
	var v T
	if err := json.NewDecoder(res.Body).Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

type errorBody struct {
	Error struct{ Kind, Message string }
}

func TestUnauthenticatedIs401ThenPairedIs200(t *testing.T) {
	e := newTestEnv(t)
	r := e.do("GET", "/api/devices", nil)
	if r.StatusCode != 401 || decode[errorBody](t, r).Error.Kind != "unauthorized" {
		t.Fatal(r.StatusCode)
	}
	e.pair()
	if r := e.do("GET", "/api/devices", nil); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
}

func TestUnknownTokenIs401(t *testing.T) {
	e := newTestEnv(t)
	e.token = "not-a-real-token"
	if r := e.do("GET", "/api/devices", nil); r.StatusCode != 401 {
		t.Fatal(r.StatusCode)
	}
}

func TestCrossOriginPostIs403(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	for _, origin := range []string{"https://evil.example", ""} {
		r := e.doFrom(origin, "POST", "/api/pair-codes", "{}")
		if r.StatusCode != 403 || decode[errorBody](t, r).Error.Kind != "forbidden_origin" {
			t.Fatalf("origin %q: %d", origin, r.StatusCode)
		}
	}
	// Reads need no Origin: the cookie is SameSite=Strict, and other pages
	// cannot read the response.
	if r := e.doFrom("", "GET", "/api/devices", nil); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
}

func TestPairingFromAnotherOriginIs403(t *testing.T) {
	e := newTestEnv(t)
	code := e.auth.NewCode("")
	r := e.doFrom("https://evil.example", "POST", "/api/pair", map[string]string{"code": code.Code})
	if r.StatusCode != 403 {
		t.Fatal(r.StatusCode)
	}
	if len(e.auth.Devices()) != 0 {
		t.Fatal("paired from another origin")
	}
}

func TestProxyForwardedHostIsSameOrigin(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/pair-codes", strings.NewReader("{}"))
	req.Header.Set("Origin", "https://macmini.example.ts.net")
	req.Header.Set("X-Forwarded-Host", "macmini.example.ts.net")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: e.token})
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
}

func TestHelloReportsPaired(t *testing.T) {
	e := newTestEnv(t)
	type hello struct{ Paired bool }
	if decode[hello](t, e.do("GET", "/api/hello", nil)).Paired {
		t.Fatal("paired before pairing")
	}
	e.pair()
	if !decode[hello](t, e.do("GET", "/api/hello", nil)).Paired {
		t.Fatal("not paired after pairing")
	}
}

func TestPairSetsDeviceCookie(t *testing.T) {
	e := newTestEnv(t)
	code := e.auth.NewCode("iPhone")
	r := e.do("POST", "/api/pair", map[string]string{"code": strings.ToLower(code.Code)})
	if r.StatusCode != 204 {
		t.Fatal(r.StatusCode)
	}
	var c *http.Cookie
	for _, x := range r.Cookies() {
		if x.Name == auth.CookieName {
			c = x
		}
	}
	if c == nil || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode || c.Path != "/" {
		t.Fatalf("cookie %+v", c)
	}
	if ds := e.auth.Devices(); len(ds) != 1 || ds[0].Name != "iPhone" {
		t.Fatalf("devices %+v", ds)
	}
}

func TestBadCodeThenRateLimited(t *testing.T) {
	e := newTestEnv(t)
	for i := range 10 {
		r := e.do("POST", "/api/pair", map[string]string{"code": "0000-0000"})
		if r.StatusCode != 400 || decode[errorBody](t, r).Error.Kind != "invalid_params" {
			t.Fatalf("attempt %d: %d", i, r.StatusCode)
		}
	}
	code := e.auth.NewCode("")
	r := e.do("POST", "/api/pair", map[string]string{"code": code.Code})
	if r.StatusCode != 429 || decode[errorBody](t, r).Error.Kind != "rate_limited" {
		t.Fatal(r.StatusCode)
	}
}

func TestDevicesMarkCurrent(t *testing.T) {
	e := newTestEnv(t)
	first := e.pair()
	second := e.pair()
	type dev struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Current   bool   `json:"current"`
		CreatedMs int64  `json:"created_ms"`
	}
	ds := decode[[]dev](t, e.do("GET", "/api/devices", nil))
	if len(ds) != 2 {
		t.Fatal(ds)
	}
	for _, d := range ds {
		if d.Current != (d.ID == second.ID) || d.Name != "tester" || d.CreatedMs == 0 {
			t.Fatalf("%+v (first %s, second %s)", d, first.ID, second.ID)
		}
	}
	raw, _ := json.Marshal(ds)
	if strings.Contains(string(raw), "token") {
		t.Fatal(string(raw))
	}
}

func TestRevokeOtherDevice(t *testing.T) {
	e := newTestEnv(t)
	other := e.pair()
	e.pair()
	if r := e.do("DELETE", "/api/devices/"+other.ID, nil); r.StatusCode != 204 {
		t.Fatal(r.StatusCode)
	}
	r := e.do("DELETE", "/api/devices/"+other.ID, nil)
	if r.StatusCode != 404 || decode[errorBody](t, r).Error.Kind != "not_found" {
		t.Fatal(r.StatusCode)
	}
	if ds := e.auth.Devices(); len(ds) != 1 {
		t.Fatal(ds)
	}
}

func TestLogoutRevokesThisDevice(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	r := e.do("POST", "/api/logout", nil)
	if r.StatusCode != 204 {
		t.Fatal(r.StatusCode)
	}
	cleared := false
	for _, c := range r.Cookies() {
		cleared = cleared || c.Name == auth.CookieName && c.MaxAge < 0
	}
	if !cleared {
		t.Fatal("cookie not cleared")
	}
	if len(e.auth.Devices()) != 0 {
		t.Fatal("device kept")
	}
	if r := e.do("GET", "/api/devices", nil); r.StatusCode != 401 {
		t.Fatal(r.StatusCode)
	}
}

func TestPairCodesGiveLink(t *testing.T) {
	e := newTestEnv(t, func(d *Deps) { d.PublicURL = func() string { return "https://macmini.example.ts.net/" } })
	e.pair()
	type pairCode struct {
		Code      string `json:"code"`
		URL       string `json:"url"`
		ExpiresMs int64  `json:"expires_ms"`
	}
	for _, body := range []any{map[string]string{"name": "iPad"}, nil} {
		r := e.do("POST", "/api/pair-codes", body)
		if r.StatusCode != 200 {
			t.Fatal(r.StatusCode)
		}
		pc := decode[pairCode](t, r)
		if !regexp.MustCompile(`^[0-9A-Z]{4}-[0-9A-Z]{4}$`).MatchString(pc.Code) {
			t.Fatal(pc.Code)
		}
		if pc.URL != "https://macmini.example.ts.net/pair#code="+pc.Code {
			t.Fatal(pc.URL)
		}
		if left := time.Until(time.UnixMilli(pc.ExpiresMs)); left < 4*time.Minute || left > 5*time.Minute {
			t.Fatal(left)
		}
	}
}

func TestBodyLimits(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	r := e.do("POST", "/api/pair-codes", `{"name":"`+strings.Repeat("a", maxJSONBody)+`"}`)
	if r.StatusCode != 413 || decode[errorBody](t, r).Error.Kind != "too_large" {
		t.Fatal(r.StatusCode)
	}
	r = e.do("POST", "/api/pair-codes", `{"name":`)
	if r.StatusCode != 400 || decode[errorBody](t, r).Error.Kind != "invalid_params" {
		t.Fatal(r.StatusCode)
	}
}

func TestRevokeClosesOpenWebSocket(t *testing.T) {
	e := newTestEnv(t)
	dev := e.pair()
	c := e.dialWS("/ws/events")
	if err := e.auth.Revoke(dev.ID); err != nil {
		t.Fatal(err)
	}
	if code := readUntilClosed(t, c); code != 4401 {
		t.Fatal(code)
	}
}

func TestWebSocketWithoutCookieClosed4401(t *testing.T) {
	e := newTestEnv(t)
	c, res, err := e.tryWS(e.srv.URL, "/ws/events")
	if err != nil {
		t.Fatalf("%v (%v)", err, res)
	}
	defer c.CloseNow()
	if code := readUntilClosed(t, c); code != 4401 {
		t.Fatal(code)
	}
}

func TestCrossOriginWebSocketIs403(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	_, res, err := e.tryWS("https://evil.example", "/ws/events")
	if err == nil || res == nil || res.StatusCode != 403 {
		t.Fatalf("%v (%v)", err, res)
	}
}
