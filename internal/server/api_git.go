package server

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/folders"
	"github.com/kwonikhyeon/mori/internal/gitx"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/store"
)

// maxDiff is how much diff the API returns, cut at a line (spec §7.1).
const maxDiff = 1 << 20

// repoFolder is the registered folder id when it is the top of a git
// worktree (spec §3 decision 77).
func (s *Server) repoFolder(id string) (store.Folder, error) {
	f, err := s.folder(id)
	if err == nil && !gitx.IsRepo(f.Path) {
		err = errorf(http.StatusConflict, "conflict", "이 폴더는 git 저장소가 아닙니다")
	}
	return f, err
}

// gitSummary is GET /api/folders/{id}/git: the folder's branch, how far it
// is from its upstream, how many files changed, and its worktrees.
type gitSummary struct {
	Repo      bool            `json:"repo"`
	Head      string          `json:"head"`
	Branch    string          `json:"branch"`
	Detached  bool            `json:"detached"`
	Upstream  string          `json:"upstream"`
	Ahead     int             `json:"ahead"`
	Behind    int             `json:"behind"`
	Changes   int             `json:"changes"`
	Worktrees []gitx.Worktree `json:"worktrees"`
}

// handleFolderGit sums up a folder's repository. A folder that is not one
// gets the same shape with repo false.
func (s *Server) handleFolderGit(w http.ResponseWriter, r *http.Request) {
	f, err := s.folder(r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	if !gitx.IsRepo(f.Path) {
		writeJSON(w, http.StatusOK, gitSummary{Worktrees: []gitx.Worktree{}})
		return
	}
	st, err := s.d.Git.Status(r.Context(), f.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	ws, err := s.d.Folders.Refresh(r.Context(), f.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, gitSummary{
		Repo: true, Head: st.Head, Branch: st.Branch, Detached: st.Detached, Upstream: st.Upstream,
		Ahead: st.Ahead, Behind: st.Behind, Changes: len(st.Changes), Worktrees: ws,
	})
}

func (s *Server) handleBranches(w http.ResponseWriter, r *http.Request) {
	f, err := s.repoFolder(r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	bs, err := s.d.Git.Branches(r.Context(), f.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, bs)
}

// handleAddWorktree checks out a branch in a new worktree beside the main
// one (spec §3 decision 15). With create it makes the branch, from base or
// HEAD; without, a branch only a remote has becomes a local one tracking
// it, as git does.
func (s *Server) handleAddWorktree(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Branch string `json:"branch"`
		Create bool   `json:"create"`
		Base   string `json:"base"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	branch := strings.TrimSpace(req.Branch)
	if branch == "" {
		writeError(w, invalid("branch가 필요합니다"))
		return
	}
	f, err := s.repoFolder(r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	main, err := s.mainWorktree(r, f)
	if err != nil {
		writeError(w, err)
		return
	}
	path := gitx.WorktreePath(main.Path, branch)
	if err := s.d.Git.AddWorktree(r.Context(), main.Path, path, branch, req.Create, strings.TrimSpace(req.Base)); err != nil {
		writeError(w, err)
		return
	}
	ws, err := s.d.Folders.Refresh(r.Context(), f.ID)
	if err != nil {
		s.log.Warn("folder worktrees", "folder", f.ID, "err", err)
	}
	wt, ok := folders.Match(ws, path)
	if !ok {
		wt = gitx.Worktree{Path: path, Branch: branch}
	}
	s.log.Info("worktree added", "folder", f.ID, "path", wt.Path, "branch", branch)
	writeJSON(w, http.StatusCreated, wt)
}

// mainWorktree lists the worktrees of f afresh and returns the main one,
// where git is run to add or remove the others.
func (s *Server) mainWorktree(r *http.Request, f store.Folder) (gitx.Worktree, error) {
	ws, err := s.d.Folders.Refresh(r.Context(), f.ID)
	if err != nil {
		return gitx.Worktree{}, err
	}
	if len(ws) == 0 || !ws[0].Main {
		return gitx.Worktree{}, errorf(http.StatusInternalServerError, "internal", "git이 이 폴더의 워크트리를 보여 주지 않습니다")
	}
	return ws[0], nil
}

// handleRemoveWorktree removes a linked worktree of the folder (spec §3
// decision 73). It refuses the main worktree, one a registered folder is
// in, and one a live session started in or runs in now; while the core is
// away it cannot tell, so it refuses too. force removes a worktree with
// changes; git keeps a locked one until it is unlocked.
func (s *Server) handleRemoveWorktree(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	switch {
	case p == "":
		writeError(w, invalid("path가 필요합니다"))
		return
	case !filepath.IsAbs(p):
		writeError(w, invalid("path는 절대 경로여야 합니다: %s", p))
		return
	}
	force, err := queryBool(r, "force")
	if err != nil {
		writeError(w, err)
		return
	}
	f, err := s.repoFolder(r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	main, err := s.mainWorktree(r, f)
	if err != nil {
		writeError(w, err)
		return
	}
	wt, ok := folders.Match(s.d.Folders.Worktrees(f.ID), p)
	switch {
	case !ok:
		writeError(w, invalid("이 폴더의 워크트리가 아닙니다: %s", p))
		return
	case wt.Main:
		writeError(w, invalid("주 워크트리는 지울 수 없습니다"))
		return
	}
	if err := s.worktreeInUse(r.Context(), wt); err != nil {
		writeError(w, err)
		return
	}
	if err := s.d.Git.RemoveWorktree(r.Context(), main.Path, wt.Path, force); err != nil {
		writeError(w, err)
		return
	}
	if _, err := s.d.Folders.Refresh(r.Context(), f.ID); err != nil {
		s.log.Warn("folder worktrees", "folder", f.ID, "err", err)
	}
	s.log.Info("worktree removed", "folder", f.ID, "path", wt.Path, "force", force)
	w.WriteHeader(http.StatusNoContent)
}

// worktreeInUse says why wt must stay, if it must. It asks the core for
// the live terminals rather than reading the cache, which may not have a
// session started a moment ago yet.
func (s *Server) worktreeInUse(ctx context.Context, wt gitx.Worktree) error {
	for _, g := range s.d.Store.Folders() {
		if folders.Within(filepath.Clean(g.Path), wt.Path) {
			return errorf(http.StatusConflict, "conflict", "등록된 폴더가 이 워크트리 안에 있습니다. 먼저 등록을 해제하세요: %s", g.Path)
		}
	}
	var list struct {
		Terminals []hc.Terminal `json:"terminals"`
	}
	err := s.d.Core.Call(ctx, "terminal.list", map[string]any{}, &list)
	switch {
	case errors.Is(err, core.ErrUnavailable):
		return errorf(http.StatusServiceUnavailable, "core_unavailable", "코어에 연결되지 않아 이 워크트리의 세션을 확인할 수 없습니다")
	case err != nil:
		return err
	}
	for _, t := range list.Terminals {
		if t.State != "finished" && folders.Inside(t, wt.Path) {
			return errorf(http.StatusConflict, "live", "이 워크트리에서 실행 중인 세션이 있습니다: %s", core.DisplayTitle(t))
		}
	}
	return nil
}

func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	wt, err := s.worktreeParam(r)
	if err != nil {
		writeError(w, err)
		return
	}
	st, err := s.d.Git.Status(r.Context(), wt.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// handleGitDiff shows the diff of a file or directory of a worktree, or of
// every tracked file when file is empty (spec §3 decision 62).
func (s *Server) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	file := r.URL.Query().Get("file")
	if file != "" && !gitx.SafeRelPath(file) {
		writeError(w, invalid("file은 워크트리 안의 상대 경로여야 합니다: %s", file))
		return
	}
	staged, err := queryBool(r, "staged")
	if err != nil {
		writeError(w, err)
		return
	}
	wt, err := s.worktreeParam(r)
	if err != nil {
		writeError(w, err)
		return
	}
	diff, truncated, err := s.d.Git.Diff(r.Context(), wt.Path, file, staged, maxDiff)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"diff": diff, "truncated": truncated})
}

// worktreeParam is the worktree ?path= names. It must be one of a
// registered folder's (spec §8), and git then runs in the path git gave
// for it. A worktree made outside Mori a moment ago is not known yet, so
// the folders are listed again once before the path is refused (spec §3
// decision 75).
func (s *Server) worktreeParam(r *http.Request) (gitx.Worktree, error) {
	p := r.URL.Query().Get("path")
	switch {
	case p == "":
		return gitx.Worktree{}, invalid("path가 필요합니다")
	case !filepath.IsAbs(p):
		return gitx.Worktree{}, invalid("path는 절대 경로여야 합니다: %s", p)
	}
	if _, wt, ok := s.d.Folders.Owner(p); ok {
		return wt, nil
	}
	s.d.Folders.RefreshAll(r.Context())
	if _, wt, ok := s.d.Folders.Owner(p); ok {
		return wt, nil
	}
	return gitx.Worktree{}, invalid("등록된 폴더의 워크트리가 아닙니다: %s", p)
}
