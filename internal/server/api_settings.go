package server

import (
	"net/http"
	"regexp"
	"slices"
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
