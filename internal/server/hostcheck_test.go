package server

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// at serves one request whose Host is host, without a cookie.
func (e *testEnv) at(host, method, path string) *httptest.ResponseRecorder {
	e.t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, nil)
	req.Host = host
	e.s.Handler().ServeHTTP(rec, req)
	return rec
}

func TestHostMustNameThisServer(t *testing.T) { // spec §3 #193
	asked := 0
	e := newTestEnv(t, func(d *Deps) {
		d.Names = func() []string {
			asked++
			return []string{"https://macmini.example.ts.net", "mori.example.com"}
		}
	})
	for _, host := range []string{"127.0.0.1:7761", "[::1]:7761", "::1", "100.64.0.7", "localhost:7761", "mori.localhost",
		"macmini.example.ts.net", "MacMini.Example.TS.net.", "macmini.example.ts.net:443", "mori.example.com:8443"} {
		if rec := e.at(host, "GET", "/api/hello"); rec.Code != 200 {
			t.Errorf("%s: %d %s", host, rec.Code, rec.Body)
		}
	}
	for _, path := range []string{"/api/hello", "/api/terminals", "/ws/events", "/h/h_desk0001/api/terminals"} {
		rec := e.at("rebound.example:7761", "GET", path)
		if rec.Code != 421 || !strings.Contains(rec.Body.String(), `"kind":"bad_host"`) {
			t.Errorf("%s: %d %s", path, rec.Code, rec.Body)
		}
	}
	if rec := e.at("rebound.example", "POST", "/api/pair"); rec.Code != 421 {
		t.Errorf("pair from a rebound name: %d", rec.Code)
	}
	if asked != 1 {
		t.Fatalf("names asked %d times, want once in %v", asked, namesEvery)
	}
	// The page and the relay are not the API: the page is public, and the
	// relay's credential is its path.
	if rec := e.at("rebound.example", "GET", "/"); rec.Code == 421 {
		t.Error("the page itself is refused")
	}
	if rec := e.at("rebound.example", "POST", "/api/relay/whatever"); rec.Code == 421 {
		t.Error("the relay is refused")
	}
}

func TestHostNamesFollowTheServer(t *testing.T) {
	pub := "http://127.0.0.1:7761" // Tailscale is not up yet
	e := newTestEnv(t, func(d *Deps) { d.PublicURL = func() string { return pub } })
	if rec := e.at("macmini.example.ts.net", "GET", "/api/hello"); rec.Code != 421 {
		t.Fatalf("before Tailscale: %d", rec.Code)
	}
	pub = "https://macmini.example.ts.net"
	if rec := e.at("macmini.example.ts.net", "GET", "/api/hello"); rec.Code != 421 {
		t.Fatalf("asked again within %v: %d", namesEvery, rec.Code)
	}
	e.s.hosts.next = time.Now() // namesEvery has passed
	if rec := e.at("macmini.example.ts.net", "GET", "/api/hello"); rec.Code != 200 {
		t.Fatalf("after Tailscale came up: %d %s", rec.Code, rec.Body)
	}
}

func TestHostname(t *testing.T) {
	for in, want := range map[string]string{
		"Mac.Example.ts.net.:443": "mac.example.ts.net",
		"mac.example.ts.net":      "mac.example.ts.net",
		"[::1]:7761":              "::1",
		"[::1]":                   "::1",
		"127.0.0.1:7761":          "127.0.0.1",
		"":                        "",
	} {
		if got := hostname(in); got != want {
			t.Errorf("%q: %q want %q", in, got, want)
		}
	}
}

// Requests that come while the names are asked wait for them and are not
// refused: the phone and the Mac come back at once when the server starts.
func TestHostCheckWaitsForTheNames(t *testing.T) {
	release := make(chan struct{})
	c := &hostCheck{names: func() []string {
		<-release
		return []string{"https://macmini.example.ts.net"}
	}}
	got := make(chan bool, 2)
	for range 2 {
		go func() { got <- c.allows("macmini.example.ts.net") }()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	for range 2 {
		if !<-got {
			t.Fatal("refused while the names were asked")
		}
	}
}
