package server

import (
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/kwonikhyeon/mori/internal/store"
)

var presetID = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

func (s *Server) handleGetPresets(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.d.Store.Get().Presets)
}

// handlePutPresets replaces the whole preset list.
func (s *Server) handlePutPresets(w http.ResponseWriter, r *http.Request) {
	var ps []store.Preset
	if err := readJSON(w, r, &ps); err != nil {
		writeError(w, err)
		return
	}
	if err := checkPresets(ps); err != nil {
		writeError(w, err)
		return
	}
	if err := s.d.Store.Update(func(st *store.State) error {
		st.Presets = ps
		return nil
	}); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ps)
}

// checkPresets checks a preset list and tidies it in place.
func checkPresets(ps []store.Preset) error {
	if len(ps) == 0 {
		return invalid("프리셋이 하나는 있어야 합니다")
	}
	seen := map[string]bool{}
	for i := range ps {
		p := &ps[i]
		p.Name = oneLine(p.Name)
		if p.Argv == nil {
			p.Argv = []string{}
		}
		switch {
		case !presetID.MatchString(p.ID):
			return invalid("프리셋 id %q: 영문 소문자, 숫자, _, -로 1~32자여야 합니다", p.ID)
		case seen[p.ID]:
			return invalid("프리셋 id %q가 두 번 나옵니다", p.ID)
		case p.Name == "":
			return invalid("프리셋 %s: 이름이 필요합니다", p.ID)
		case utf8.RuneCountInString(p.Name) > maxTitle:
			return invalid("프리셋 %s: 이름은 %d자까지입니다", p.ID, maxTitle)
		case slices.Contains(p.Argv, ""):
			return invalid("프리셋 %s: argv에 빈 항목이 있습니다", p.ID)
		case p.Task && len(p.Argv) == 0:
			return invalid("프리셋 %s: 작업을 받으려면 실행할 프로그램(argv)이 있어야 합니다", p.ID)
		}
		seen[p.ID] = true
	}
	return nil
}

func (s *Server) handleGetHosts(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.d.Store.Get().Hosts)
}

// handlePutHosts replaces the links to other hosts' Mori (spec §3 #2).
func (s *Server) handlePutHosts(w http.ResponseWriter, r *http.Request) {
	hs := []store.Host{}
	if err := readJSON(w, r, &hs); err != nil {
		writeError(w, err)
		return
	}
	if hs == nil { // the body was null
		hs = []store.Host{}
	}
	for i := range hs {
		h := &hs[i]
		h.Name = oneLine(h.Name)
		if h.Name == "" || utf8.RuneCountInString(h.Name) > maxTitle {
			writeError(w, invalid("호스트 이름은 1~%d자여야 합니다", maxTitle))
			return
		}
		u, err := hostURL(h.URL)
		if err != nil {
			writeError(w, err)
			return
		}
		h.URL = u
	}
	if err := s.d.Store.Update(func(st *store.State) error {
		st.Hosts = hs
		return nil
	}); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, hs)
}

// hostURL checks a link to another host: an absolute http or https URL
// without credentials. The UI opens it as a link, so no other scheme may
// pass.
func hostURL(v string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(v))
	if err != nil || u.Scheme != "https" && u.Scheme != "http" || u.Host == "" || u.User != nil {
		return "", invalid("호스트 주소 %q: https://호스트 꼴이어야 합니다", v)
	}
	return strings.TrimRight(u.String(), "/"), nil
}
