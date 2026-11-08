package server

import (
	"cmp"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/kwonikhyeon/mori/internal/folders"
	"github.com/kwonikhyeon/mori/internal/gitx"
	"github.com/kwonikhyeon/mori/internal/store"
)

// maxFsEntries is how many directories the folder picker lists (spec §3
// decision 74).
const maxFsEntries = 2000

func (s *Server) handleListFolders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.folderViews(s.d.Store.Folders()))
}

// handleAddFolder registers a directory as a folder, kept by its real
// path: git reports real paths, and a folder reached through two symlinks
// is one folder.
func (s *Server) handleAddFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	path, err := folderPath(req.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	name := oneLine(req.Name)
	if utf8.RuneCountInString(name) > maxTitle {
		writeError(w, invalid("이름은 %d자까지입니다", maxTitle))
		return
	}
	if name == "" {
		name = filepath.Base(filepath.Clean(req.Path)) // the name the user picked, not where a link leads
	}
	f := store.Folder{ID: store.NewID("f_"), Name: name, Path: path, CreatedMs: time.Now().UnixMilli()}
	if err := s.d.Store.Update(func(st *store.State) error {
		for _, g := range st.Folders {
			if folders.SamePath(filepath.Clean(g.Path), path) {
				return errorf(http.StatusConflict, "conflict", "이미 등록된 폴더입니다: %s", g.Path)
			}
		}
		st.Folders = append(st.Folders, f)
		return nil
	}); err != nil {
		writeError(w, err)
		return
	}
	if _, err := s.d.Folders.Refresh(r.Context(), f.ID); err != nil {
		s.log.Warn("folder worktrees", "folder", f.ID, "err", err)
	}
	s.log.Info("folder added", "folder", f.ID, "path", f.Path)
	s.FoldersChanged()
	writeJSON(w, http.StatusCreated, s.folderView(f))
}

// folderPath checks the path of a folder to register and returns its real
// path.
func folderPath(p string) (string, error) {
	switch {
	case p == "":
		return "", invalid("path가 필요합니다")
	case !filepath.IsAbs(p):
		return "", invalid("path는 절대 경로여야 합니다: %s", p)
	}
	real, err := folders.Canonical(p)
	if err != nil {
		return "", invalid("폴더가 없습니다: %s", p)
	}
	if info, err := os.Stat(real); err != nil || !info.IsDir() {
		return "", invalid("폴더가 아닙니다: %s", p)
	}
	return real, nil
}

// handlePatchFolder renames a folder. An empty name gives it the name of
// its directory.
func (s *Server) handlePatchFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name *string `json:"name"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	if req.Name == nil {
		writeError(w, invalid("name이 필요합니다"))
		return
	}
	name := oneLine(*req.Name)
	if utf8.RuneCountInString(name) > maxTitle {
		writeError(w, invalid("이름은 %d자까지입니다", maxTitle))
		return
	}
	id := r.PathValue("id")
	var out store.Folder
	if err := s.d.Store.Update(func(st *store.State) error {
		i := folderIndex(st.Folders, id)
		if i < 0 {
			return noFolder(id)
		}
		st.Folders[i].Name = cmp.Or(name, filepath.Base(st.Folders[i].Path))
		out = st.Folders[i]
		return nil
	}); err != nil {
		writeError(w, err)
		return
	}
	s.FoldersChanged()
	writeJSON(w, http.StatusOK, s.folderView(out))
}

// handleRemoveFolder forgets a folder. Its files, worktrees and sessions
// stay; the sessions move to another folder or to 기타.
func (s *Server) handleRemoveFolder(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.d.Store.Update(func(st *store.State) error {
		i := folderIndex(st.Folders, id)
		if i < 0 {
			return noFolder(id)
		}
		st.Folders = slices.Delete(st.Folders, i, i+1)
		return nil
	}); err != nil {
		writeError(w, err)
		return
	}
	s.log.Info("folder removed", "folder", id)
	s.FoldersChanged()
	w.WriteHeader(http.StatusNoContent)
}

func folderIndex(fs []store.Folder, id string) int {
	return slices.IndexFunc(fs, func(f store.Folder) bool { return f.ID == id })
}

func noFolder(id string) error {
	return errorf(http.StatusNotFound, "not_found", "없는 폴더입니다: %s", id)
}

// folder is the registered folder id.
func (s *Server) folder(id string) (store.Folder, error) {
	fs := s.d.Store.Folders()
	if i := folderIndex(fs, id); i >= 0 {
		return fs[i], nil
	}
	return store.Folder{}, noFolder(id)
}

type fsEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Git  bool   `json:"git"` // the top of a git worktree
}

// handleFs lists the directories in a directory for the folder picker,
// the home directory by default (spec §3 decision 74). Hidden ones, by a
// leading dot or on Windows by the hidden attribute, show with hidden=1.
func (s *Server) handleFs(w http.ResponseWriter, r *http.Request) {
	hidden, err := queryBool(r, "hidden")
	if err != nil {
		writeError(w, err)
		return
	}
	dir := r.URL.Query().Get("path")
	if dir == "" {
		if dir, err = os.UserHomeDir(); err != nil {
			writeError(w, invalid("홈 폴더를 알 수 없습니다. path를 주세요"))
			return
		}
	}
	if !filepath.IsAbs(dir) {
		writeError(w, invalid("path는 절대 경로여야 합니다: %s", dir))
		return
	}
	dir = filepath.Clean(dir)
	info, err := os.Stat(dir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		writeError(w, errorf(http.StatusNotFound, "not_found", "폴더가 없습니다: %s", dir))
		return
	case err != nil:
		writeError(w, invalid("폴더를 읽을 수 없습니다: %s", dir))
		return
	case !info.IsDir():
		writeError(w, invalid("폴더가 아닙니다: %s", dir))
		return
	}
	des, err := os.ReadDir(dir)
	if err != nil && len(des) == 0 {
		writeError(w, invalid("폴더를 읽을 수 없습니다: %s", dir))
		return
	}
	entries := []fsEntry{}
	for _, de := range des {
		name := de.Name()
		if !hidden && (strings.HasPrefix(name, ".") || hiddenEntry(de)) {
			continue
		}
		p := filepath.Join(dir, name)
		if !isDir(de, p) {
			continue
		}
		entries = append(entries, fsEntry{Name: name, Path: p})
	}
	slices.SortFunc(entries, func(a, b fsEntry) int {
		return cmp.Or(cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), cmp.Compare(a.Name, b.Name))
	})
	truncated := len(entries) > maxFsEntries
	if truncated {
		entries = entries[:maxFsEntries]
	}
	for i := range entries {
		entries[i].Git = gitx.IsRepo(entries[i].Path)
	}
	parent := filepath.Dir(dir)
	if parent == dir {
		parent = "" // the root
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": dir, "parent": parent, "entries": entries, "truncated": truncated})
}

// isDir reports whether the entry de at p is a directory or leads to one,
// as a symlink or, on Windows, a junction does.
func isDir(de fs.DirEntry, p string) bool {
	if de.IsDir() {
		return true
	}
	if de.Type()&(fs.ModeSymlink|fs.ModeIrregular) == 0 {
		return false
	}
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

// hiddenEntry reports whether the file system marks de hidden.
func hiddenEntry(de fs.DirEntry) bool {
	info, err := de.Info()
	return err == nil && hiddenAttr(info)
}
