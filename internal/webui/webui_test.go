package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	return rec
}

func TestPlaceholder(t *testing.T) {
	h := http.HandlerFunc(placeholder)
	for _, p := range []string{"/", "/pair"} {
		rec := get(t, h, p)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "Mori") {
			t.Fatalf("%s: %d", p, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "<script>") {
			t.Fatalf("%s: inline script breaks the CSP", p)
		}
	}
	rec := get(t, h, "/placeholder.js")
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/javascript") {
		t.Fatalf("js: %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
	if rec := get(t, h, "/nope"); rec.Code != 404 {
		t.Fatalf("unknown path: %d", rec.Code)
	}
}

func TestSPA(t *testing.T) {
	h := spa(fstest.MapFS{
		"index.html":           {Data: []byte("<!doctype html><title>Mori</title>")},
		"sw.js":                {Data: []byte("self.x = 1")},
		"manifest.json":        {Data: []byte("{}")},
		"assets/index-AbC1.js": {Data: []byte("export {}")},
		"assets/inter.woff2":   {Data: []byte("wOF2")},
		"icons/icon-192.png":   {Data: []byte("\x89PNG")},
		".gitkeep":             {Data: nil},
	})
	for _, p := range []string{"/", "/pair"} {
		rec := get(t, h, p)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<title>Mori") {
			t.Fatalf("%s: %d %q", p, rec.Code, rec.Body.String())
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
			t.Fatalf("%s: Cache-Control %q", p, cc)
		}
	}
	cases := []struct {
		path, ctype, cache string
	}{
		{"/assets/index-AbC1.js", "text/javascript", "public, max-age=31536000, immutable"},
		{"/assets/inter.woff2", "font/woff2", "public, max-age=31536000, immutable"},
		{"/sw.js", "text/javascript", "no-cache"},
		{"/manifest.json", "application/json", "no-cache"},
		{"/icons/icon-192.png", "image/png", "no-cache"},
	}
	for _, c := range cases {
		rec := get(t, h, c.path)
		if rec.Code != 200 {
			t.Fatalf("%s: %d", c.path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, c.ctype) {
			t.Fatalf("%s: Content-Type %q", c.path, ct)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != c.cache {
			t.Fatalf("%s: Cache-Control %q", c.path, cc)
		}
	}
	// No directory listings, no dot files, nothing outside the build.
	for _, p := range []string{"/assets/", "/icons/", "/.gitkeep", "/nope", "/t/x"} {
		if rec := get(t, h, p); rec.Code != 404 {
			t.Fatalf("%s: %d", p, rec.Code)
		}
	}
}

// Handler picks dist/ or the placeholder from what was embedded; either
// way the root page answers.
func TestHandlerServesRoot(t *testing.T) {
	if rec := get(t, Handler(), "/"); rec.Code != 200 || !strings.Contains(rec.Body.String(), "Mori") {
		t.Fatalf("/: %d", rec.Code)
	}
}
