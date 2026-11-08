package webui

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPlaceholderServedWithoutBuild(t *testing.T) {
	for _, p := range []string{"/", "/pair"} {
		rec := httptest.NewRecorder()
		Handler().ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "Mori") {
			t.Fatalf("%s: %d", p, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "<script>") {
			t.Fatalf("%s: inline script breaks the CSP", p)
		}
	}
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/placeholder.js", nil))
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/javascript") {
		t.Fatalf("js: %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
	rec = httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/nope", nil))
	if rec.Code != 404 {
		t.Fatalf("unknown path: %d", rec.Code)
	}
}
