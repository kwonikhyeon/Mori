// Package server serves Mori's REST API, its WebSockets, and the web UI.
package server

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/store"
)

// Deps are the parts the server is assembled from. Auth and Store are
// required.
type Deps struct {
	Version   string
	HostName  string
	Auth      *auth.Auth
	Store     *store.Store
	PublicURL func() string // where devices reach this server, for pairing links
	UI        http.Handler
	Logger    *slog.Logger
}

// Server routes requests. Build it with New and serve Handler().
type Server struct {
	d   Deps
	log *slog.Logger
	mux *http.ServeMux
	hub *hub
}

func New(d Deps) *Server {
	if d.Auth == nil || d.Store == nil {
		panic("server: Deps.Auth and Deps.Store are required")
	}
	if d.PublicURL == nil {
		d.PublicURL = func() string { return "" }
	}
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	if d.UI == nil {
		d.UI = http.NotFoundHandler()
	}
	s := &Server{d: d, log: d.Logger, mux: http.NewServeMux(), hub: newHub()}
	d.Auth.OnRevoke(s.hub.closeDevice)
	s.routes()
	return s
}

// Handler is the root handler with security headers on every response.
func (s *Server) Handler() http.Handler { return securityHeaders(s.mux) }

// routes puts every API and WebSocket behind requireDevice; the web UI
// itself is public.
func (s *Server) routes() {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/hello", s.handleHello)
	api.HandleFunc("POST /api/pair", s.handlePair)
	api.HandleFunc("POST /api/logout", s.handleLogout)
	api.HandleFunc("GET /api/devices", s.handleDevices)
	api.HandleFunc("DELETE /api/devices/{id}", s.handleRevokeDevice)
	api.HandleFunc("POST /api/pair-codes", s.handlePairCode)
	api.HandleFunc("GET /ws/events", s.handleEventsWS)
	notFound := func(w http.ResponseWriter, r *http.Request) {
		writeError(w, errorf(http.StatusNotFound, "not_found", "없는 API입니다: %s %s", r.Method, r.URL.Path))
	}
	api.HandleFunc("/api/", notFound)
	api.HandleFunc("/ws/", notFound)

	guarded := s.requireDevice(api)
	s.mux.Handle("/api/", guarded)
	s.mux.Handle("/ws/", guarded)
	s.mux.Handle("/", s.d.UI)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp(r.Host))
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// csp builds the policy of spec §8. Some browsers do not let 'self' cover
// WebSockets, so the page's own host is listed for ws: and wss: as well.
func csp(host string) string {
	connect := "'self'"
	if validHost(host) {
		connect += " wss://" + host + " ws://" + host
	}
	return "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
		"connect-src " + connect + "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
}

// validHost reports whether host is safe to place inside a CSP header.
func validHost(host string) bool {
	if host == "" || len(host) > 255 {
		return false
	}
	return strings.IndexFunc(host, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune(".-:[]", r))
	}) < 0
}
