package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHelloIsPublicAndHasSecurityHeaders(t *testing.T) {
	e := newTestEnv(t, func(d *Deps) { d.Version, d.HostName = "v-test", "macmini" })
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/hello", nil)
	req.Host = "127.0.0.1:7761"
	e.s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	var got struct {
		App, Version, Host string
		Paired             bool
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.App != "mori" || got.Version != "v-test" || got.Host != "macmini" || got.Paired {
		t.Fatalf("hello %+v", got)
	}
	for _, h := range []string{"Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy"} {
		if rec.Header().Get(h) == "" {
			t.Errorf("missing %s", h)
		}
	}
}

func TestCSPListsOwnHostForWebSockets(t *testing.T) {
	got := csp("macmini.example.ts.net")
	for _, want := range []string{"default-src 'self'", "connect-src 'self' wss://macmini.example.ts.net ws://macmini.example.ts.net;", "frame-ancestors 'none'"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %s", want, got)
		}
	}
	if bad := csp("evil; script-src *"); strings.Contains(bad, "evil") {
		t.Fatalf("host must not be injected: %s", bad)
	}
}

func TestUnknownAPIPathIsJSON404(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	for _, path := range []string{"/api/nope", "/api/pair", "/ws/nope"} { // GET /api/pair: wrong method
		r := e.do("GET", path, nil)
		if r.StatusCode != 404 || decode[errorBody](t, r).Error.Kind != "not_found" {
			t.Fatalf("%s: %d", path, r.StatusCode)
		}
	}
}

func TestErrorShape(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, errorf(400, "invalid_params", "bad %s", "x"))
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), `"kind":"invalid_params"`) || !strings.Contains(rec.Body.String(), `"message":"bad x"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestStatusForKinds(t *testing.T) {
	for kind, want := range map[string]int{
		"not_found": 404, "invalid_params": 400, "blocked": 409, "finished": 409, "live": 409,
		"unavailable": 503, "core_unavailable": 503, "unauthorized": 401, "forbidden_origin": 403,
		"rate_limited": 429, "git_failed": 422, "push_failed": 502, "whatever": 500,
		"host_unlinked": 409, "host_unreachable": 502, "bad_host": 421,
	} {
		if got := statusFor(kind); got != want {
			t.Errorf("%s: %d want %d", kind, got, want)
		}
	}
}
