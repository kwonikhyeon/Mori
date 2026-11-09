package server

import (
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/peer"
)

// fakeMori is another host's Mori as far as linking goes: it pairs with
// code and gives the token "tok-<code>".
func fakeMori(t *testing.T, code string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/hello", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"app":"mori","version":"9.9.9","host":"desk","paired":false}`)
	})
	mux.HandleFunc("POST /api/pair", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Code string }
		json.NewDecoder(r.Body).Decode(&body)
		if body.Code != code {
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":{"kind":"invalid_params","message":"코드가 맞지 않거나 만료되었습니다"}}`)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: auth.CookieName, Value: "tok-" + code, Path: "/"})
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/logout", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// withLinks lets the server link to other hosts; c is how it trusts their
// TLS (nil: the system's roots). Its own public URL is not https, so no
// relay is made.
func withLinks(c *tls.Config) func(*Deps) {
	return func(d *Deps) {
		d.Links = peer.New(peer.Options{Store: d.Store, PublicURL: func() string { return "http://hub.invalid" }, Listen: "127.0.0.1:1",
			HostName: d.HostName, Version: d.Version, TLS: c, Logger: d.Logger})
	}
}

func TestHostsAPI(t *testing.T) {
	desk := fakeMori(t, "ABCD-EFGH")
	e := newTestEnv(t, withLinks(nil))
	e.pair()
	for _, body := range []map[string]string{
		{"url": "desk.example.ts.net", "code": "ABCD-EFGH"},
		{"url": desk.URL},
		{"url": desk.URL, "code": "WXYZ-WXYZ"},
	} {
		if eb := e.expectError("POST", "/api/hosts", body, 400); eb.Error.Kind != "invalid_params" {
			t.Fatal(body, eb)
		}
	}
	var v peer.View
	e.json("POST", "/api/hosts", map[string]string{"url": desk.URL + "/pair#code=ABCD-EFGH"}, 201, &v)
	if !strings.HasPrefix(v.ID, "h_") || v.Name != "desk" || v.URL != desk.URL || !v.Linked || v.Version != "9.9.9" || v.Relay || v.RelayError == "" {
		t.Fatalf("%+v", v)
	}
	var again peer.View
	e.json("POST", "/api/hosts", map[string]string{"url": desk.URL + "/", "code": "ABCD-EFGH", "name": "책상"}, 200, &again)
	if again.ID != v.ID || again.Name != "책상" {
		t.Fatalf("relink %+v", again)
	}
	var list []peer.View
	e.json("GET", "/api/hosts", nil, 200, &list)
	if len(list) != 1 || list[0].ID != v.ID {
		t.Fatalf("%+v", list)
	}
	for _, path := range []string{"/api/hosts", "/api/overview"} {
		b, err := io.ReadAll(e.do("GET", path, nil).Body)
		if err != nil || strings.Contains(string(b), "tok-") {
			t.Fatalf("%s shows the token: %s %v", path, b, err)
		}
	}

	e.json("PATCH", "/api/hosts/"+v.ID, map[string]string{"name": " 연구실 "}, 200, &again)
	if again.Name != "연구실" {
		t.Fatalf("rename %+v", again)
	}
	e.expectError("PATCH", "/api/hosts/"+v.ID, map[string]string{"name": "  "}, 400)
	e.expectError("PATCH", "/api/hosts/h_nope0000", map[string]string{"name": "x"}, 404)
	e.json("POST", "/api/hosts/"+v.ID+"/relay", nil, 200, &again)
	if again.Relay || !strings.Contains(again.RelayError, "https") {
		t.Fatalf("relay %+v", again)
	}
	e.expectError("PUT", "/api/hosts", []any{}, 404) // the list is not set as a whole any more

	e.json("DELETE", "/api/hosts/"+v.ID, nil, 204, nil)
	e.expectError("DELETE", "/api/hosts/"+v.ID, nil, 404)
	e.json("GET", "/api/hosts", nil, 200, &list)
	if list == nil || len(list) != 0 {
		t.Fatalf("%#v", list)
	}
}

func TestHostsWithoutLinks(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	var list []peer.View
	e.json("GET", "/api/hosts", nil, 200, &list)
	if list == nil || len(list) != 0 {
		t.Fatalf("%#v", list)
	}
	if eb := e.expectError("POST", "/api/hosts", map[string]string{"url": "https://desk.example.ts.net", "code": "ABCD-EFGH"}, 503); eb.Error.Kind != "unavailable" {
		t.Fatal(eb)
	}
}
