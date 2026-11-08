// Package server serves Mori's REST API, its WebSockets, and the web UI.
package server

import (
	"log/slog"
	"net/http"
	"strings"
)

// Deps are the parts the server is assembled from.
type Deps struct {
	Version  string
	HostName string
	UI       http.Handler
	Logger   *slog.Logger
}

// Server routes requests. Build it with New and serve Handler().
type Server struct {
	d   Deps
	log *slog.Logger
	mux *http.ServeMux
}

func New(d Deps) *Server {
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	if d.UI == nil {
		d.UI = http.NotFoundHandler()
	}
	s := &Server{d: d, log: d.Logger, mux: http.NewServeMux()}
	s.routes()
	return s
}

// Handler is the root handler with security headers on every response.
func (s *Server) Handler() http.Handler { return securityHeaders(s.mux) }

func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/hello", s.handleHello)
	s.mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, errorf(http.StatusNotFound, "not_found", "no such endpoint: %s %s", r.Method, r.URL.Path))
	})
	s.mux.Handle("/", s.d.UI)
}

func (s *Server) handleHello(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"app":     "mori",
		"version": s.d.Version,
		"host":    s.d.HostName,
		"paired":  false,
	})
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
