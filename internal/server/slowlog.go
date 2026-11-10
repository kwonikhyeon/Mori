package server

import (
	"net/http"
	"strings"
	"time"
)

// slowRequest is how long a request may take before it is logged (spec §3
// #192). send and keys wait for a quiet keyboard for about 3 seconds, so
// the line is for what takes longer than that.
const slowRequest = 4 * time.Second

// timeRequests logs a request slower than s.slow: its method, path, status
// and time, never its query or body. Sockets stay open by design and are
// not timed.
func (s *Server) timeRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isWS(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		if d := time.Since(start); d >= s.slow {
			s.log.Warn("느린 요청", "method", r.Method, "path", logPath(r.URL.Path), "status", sw.status(), "ms", d.Milliseconds())
		}
	})
}

// logPath is path as a log may show it: a relay's secret is its
// credential, so it is left out (spec §8).
func logPath(path string) string {
	if strings.HasPrefix(path, "/api/relay/") {
		return "/api/relay/…"
	}
	return path
}

// statusWriter remembers the status a handler answered with. Unwrap lets
// http.ResponseController reach the connection beneath it.
type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.code == 0 {
		w.code = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// status is what the client got: 200 when the handler wrote nothing.
func (w *statusWriter) status() int {
	if w.code == 0 {
		return http.StatusOK
	}
	return w.code
}
