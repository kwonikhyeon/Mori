package server

import (
	"errors"
	"net/http"
	"strings"

	"github.com/kwonikhyeon/mori/internal/auth"
)

// PairLink is the page a device opens to pair. The code sits in the
// fragment, which browsers do not send, so it stays out of request logs.
func PairLink(base, code string) string {
	return strings.TrimRight(base, "/") + "/pair#code=" + code
}

func (s *Server) handleHello(w http.ResponseWriter, r *http.Request) {
	_, paired := deviceFrom(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"app":     "mori",
		"version": s.d.Version,
		"host":    s.d.HostName,
		"paired":  paired,
	})
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	tok, dev, err := s.d.Auth.Pair(req.Code, req.Name, r.UserAgent())
	switch {
	case errors.Is(err, auth.ErrBadCode):
		writeError(w, errorf(http.StatusBadRequest, "invalid_params", "코드가 맞지 않거나 만료되었습니다"))
		return
	case errors.Is(err, auth.ErrRateLimited):
		writeError(w, errorf(http.StatusTooManyRequests, "rate_limited", "실패가 너무 많습니다. 10분 뒤에 다시 시도하세요"))
		return
	case err != nil:
		writeError(w, err)
		return
	}
	s.log.Info("device paired", "device", dev.ID, "name", dev.Name)
	auth.SetCookie(w, tok)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	dev, _ := deviceFrom(r.Context())
	if err := s.d.Auth.Revoke(dev.ID); err != nil && !errors.Is(err, auth.ErrNotFound) {
		writeError(w, err)
		return
	}
	auth.ClearCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

type deviceJSON struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	UserAgent  string `json:"user_agent"`
	CreatedMs  int64  `json:"created_ms"`
	LastSeenMs int64  `json:"last_seen_ms"`
	Current    bool   `json:"current"`
}

func (s *Server) handleDevices(w http.ResponseWriter, r *http.Request) {
	me, _ := deviceFrom(r.Context())
	out := []deviceJSON{}
	for _, d := range s.d.Auth.Devices() {
		out = append(out, deviceJSON{d.ID, d.Name, d.UserAgent, d.CreatedMs, d.LastSeenMs, d.ID == me.ID})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	switch err := s.d.Auth.Revoke(r.PathValue("id")); {
	case errors.Is(err, auth.ErrNotFound):
		writeError(w, errorf(http.StatusNotFound, "not_found", "그런 기기가 없습니다"))
	case err != nil:
		writeError(w, err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *Server) handlePairCode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	c := s.d.Auth.NewCode(req.Name)
	writeJSON(w, http.StatusOK, map[string]any{
		"code":       c.Code,
		"url":        PairLink(s.d.PublicURL(), c.Code),
		"expires_ms": c.Expires.UnixMilli(),
	})
}
