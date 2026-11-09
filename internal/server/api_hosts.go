package server

import (
	"context"
	"net/http"

	"github.com/kwonikhyeon/mori/internal/peer"
)

// hostViews shows the hosts linked to this hub (spec §3 #168). Without
// Links the stored ones are still shown.
func (s *Server) hostViews() []peer.View {
	if s.d.Links == nil {
		return peer.Views(s.d.Store.Hosts(), "")
	}
	return s.d.Links.Views()
}

// needLinks answers 503 when this server cannot link to other hosts.
func (s *Server) needLinks(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.d.Links == nil {
			writeError(w, errorf(http.StatusServiceUnavailable, "unavailable", "이 서버는 다른 호스트로 잇지 않습니다"))
			return
		}
		h(w, r)
	}
}

func (s *Server) handleGetHosts(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.hostViews())
}

// handleLinkHost links the hub to another host's Mori (spec §6.9). It goes
// on when the device leaves, since the host has used up the code by then.
func (s *Server) handleLinkHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL  string `json:"url"`
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	v, created, err := s.d.Links.Link(context.WithoutCancel(r.Context()), req.URL, req.Code, req.Name)
	if err != nil {
		writeError(w, err)
		return
	}
	s.log.Info("host linked", "host", v.ID, "url", v.URL, "relay", v.Relay)
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, v)
}

func (s *Server) handleRenameHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	v, err := s.d.Links.Rename(r.PathValue("id"), req.Name)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// handleUnlinkHost forgets a host, then logs the hub out of it; a host
// that cannot be reached is forgotten all the same.
func (s *Server) handleUnlinkHost(w http.ResponseWriter, r *http.Request) {
	v, err := s.d.Links.Unlink(context.WithoutCancel(r.Context()), r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	s.log.Info("host unlinked", "host", v.ID, "url", v.URL)
	w.WriteHeader(http.StatusNoContent)
}

// handleHostRelay makes the host's relay subscription again with new keys
// (spec §6.11).
func (s *Server) handleHostRelay(w http.ResponseWriter, r *http.Request) {
	v, err := s.d.Links.SetupRelay(context.WithoutCancel(r.Context()), r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	s.log.Info("host relay set up", "host", v.ID, "relay", v.Relay)
	writeJSON(w, http.StatusOK, v)
}
