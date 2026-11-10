package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/store"
)

const maxJSONBody = 1 << 20

type deviceKey struct{}

// deviceFrom is the device that made the request, if it is paired.
func deviceFrom(ctx context.Context) (store.Device, bool) {
	d, ok := ctx.Value(deviceKey{}).(store.Device)
	return d, ok
}

// isWS reports whether path is a socket: the hub's own, or one it relays.
func isWS(path string) bool {
	if strings.HasPrefix(path, "/h/") {
		path = stripHost(path)
	}
	return strings.HasPrefix(path, "/ws/")
}

// requireDevice guards /api/, /ws/ and /h/. Their Host must be a name of
// this server (421 otherwise). Requests that change state and every
// WebSocket must come from this server's own origin (403). API requests
// need a paired device (401), except the public ones. A WebSocket goes on
// without one, and its handler closes it with 4401, which a browser can
// read where it cannot read a refused upgrade.
func (s *Server) requireDevice(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.hosts.allows(r.Host) {
			writeError(w, errBadHost)
			return
		}
		ws := isWS(r.URL.Path)
		if (ws || changesState(r.Method)) && !auth.SameOrigin(r) {
			writeError(w, errorf(http.StatusForbidden, "forbidden_origin", "다른 출처에서 온 요청은 받지 않습니다"))
			return
		}
		if dev, tok, ok := s.d.Auth.Device(r); ok {
			s.d.Auth.Touch(w, dev, tok, r.UserAgent())
			r = r.WithContext(context.WithValue(r.Context(), deviceKey{}, dev))
		} else if !ws && !isPublic(r) {
			writeError(w, errorf(http.StatusUnauthorized, "unauthorized", "이 기기는 페어링되지 않았습니다"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func changesState(method string) bool {
	return method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions
}

func isPublic(r *http.Request) bool {
	return r.Method == http.MethodGet && r.URL.Path == "/api/hello" ||
		r.Method == http.MethodPost && r.URL.Path == "/api/pair"
}

// readJSON decodes a body of at most 1 MiB into v. An empty body leaves v
// as it is.
func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBody)).Decode(v)
	var tooLarge *http.MaxBytesError
	switch {
	case err == nil, errors.Is(err, io.EOF):
		return nil
	case errors.As(err, &tooLarge):
		return errorf(http.StatusRequestEntityTooLarge, "too_large", "요청 본문이 %d바이트를 넘습니다", maxJSONBody)
	}
	return errorf(http.StatusBadRequest, "invalid_params", "요청 본문이 올바른 JSON이 아닙니다: %v", err)
}
