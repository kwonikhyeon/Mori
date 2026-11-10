package server

import (
	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/gitx"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/store"
)

// TerminalView is a terminal as the API shows it: the core's record, the
// folder it belongs to, the name to show and the question it asks (spec
// §7.1). Title stays the title the program set.
type TerminalView struct {
	hc.Terminal
	FolderID     string `json:"folder_id"`
	Worktree     string `json:"worktree"`
	DisplayTitle string `json:"display_title"`
	Preset       string `json:"preset,omitempty"`
	Ask          string `json:"ask,omitempty"` // what a blocked program asks, for expect (spec §3 #194)
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
	folder, worktree := s.d.Folders.Resolve(t)
	return TerminalView{
		Terminal:     t,
		FolderID:     folder,
		Worktree:     worktree,
		DisplayTitle: core.DisplayTitle(t),
		Preset:       t.Labels[core.LabelPreset],
		Ask:          core.AskID(t),
	}
}

// FolderView is a folder as the API shows it: the stored record, whether
// it is the top of a git worktree, and the worktrees git last listed for
// it (spec §3 decisions 68 and 69).
type FolderView struct {
	store.Folder
	Repo      bool            `json:"repo"`
	Worktrees []gitx.Worktree `json:"worktrees"`
}

func (s *Server) folderView(f store.Folder) FolderView {
	return FolderView{Folder: f, Repo: gitx.IsRepo(f.Path), Worktrees: s.d.Folders.Worktrees(f.ID)}
}

func (s *Server) folderViews(fs []store.Folder) []FolderView {
	out := make([]FolderView, 0, len(fs))
	for _, f := range fs {
		out = append(out, s.folderView(f))
	}
	return out
}
