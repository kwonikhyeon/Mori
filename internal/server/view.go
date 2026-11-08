package server

import (
	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
)

// TerminalView is a terminal as the API shows it: the core's record, the
// folder it belongs to, and the name to show (spec §7.1). Title stays the
// title the program set.
type TerminalView struct {
	hc.Terminal
	FolderID     string `json:"folder_id"`
	Worktree     string `json:"worktree"`
	DisplayTitle string `json:"display_title"`
	Preset       string `json:"preset,omitempty"`
}

// view dresses t for the API. JSON shows {} and [] rather than null; the
// maps of a cached record are shared, so they are replaced, never filled.
func (s *Server) view(t hc.Terminal) TerminalView {
	if t.Labels == nil {
		t.Labels = map[string]string{}
	}
	if t.Argv == nil {
		t.Argv = []string{}
	}
	folder, worktree := s.d.Resolve(t)
	return TerminalView{
		Terminal:     t,
		FolderID:     folder,
		Worktree:     worktree,
		DisplayTitle: core.DisplayTitle(t),
		Preset:       t.Labels[core.LabelPreset],
	}
}
