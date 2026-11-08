// Package folders tells which registered folder, and which of its git
// worktrees, a terminal belongs to (spec §5), and keeps the worktrees git
// lists for each folder.
package folders

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/gitx"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/store"
)

// maxReal bounds the cache of real paths, which starts over when full.
const maxReal = 1024

// Resolver tells where terminals belong from the registered folders and
// the worktrees git last listed for them. mu may be held while reading the
// store, never the other way round.
type Resolver struct {
	st  *store.Store
	git gitx.Runner

	mu       sync.Mutex
	wts      map[string][]gitx.Worktree // folder ID → its worktrees, main first; absent when none
	tickets  map[string]uint64          // folder ID → the refresh whose list wts holds
	next     uint64
	real     map[string]string // start cwd → its real path, or itself when that fails
	onChange func()
}

// New makes a Resolver that knows no worktrees until a refresh.
func New(st *store.Store, git gitx.Runner) *Resolver {
	return &Resolver{
		st:      st,
		git:     git,
		wts:     map[string][]gitx.Worktree{},
		tickets: map[string]uint64{},
		real:    map[string]string{},
	}
}

// OnChange sets what to call when the worktrees of a folder change. It is
// called with no lock of the Resolver held.
func (r *Resolver) OnChange(f func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.onChange = f
}

// Resolve tells which folder t belongs to and, in a repository, which of
// the folder's worktrees (spec §3 decisions 13 and 70): the registered
// folder its label names, or else the folder whose path or worktree is the
// deepest to hold where t started, judged by the real path and then the
// path as given. A terminal of another machine, or one no folder holds,
// gives "", "": it goes under 기타.
func (r *Resolver) Resolve(t hc.Terminal) (folderID, worktree string) {
	if remote(t.Address) {
		return "", ""
	}
	fs := r.st.Folders()
	var paths []string
	if t.Cwd != "" {
		raw := filepath.Clean(t.Cwd)
		real := r.realPath(raw)
		paths = append(paths, real)
		if real != raw {
			paths = append(paths, raw)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if id := t.Labels[core.LabelFolder]; id != "" && slices.ContainsFunc(fs, func(f store.Folder) bool { return f.ID == id }) {
		for _, p := range paths {
			if w, ok := deepest(r.wts[id], p); ok {
				return id, w.Path
			}
		}
		return id, ""
	}
	for _, p := range paths {
		if id, wt, ok := r.match(fs, p); ok {
			return id, wt
		}
	}
	return "", ""
}

// realPath is p with its symlinks resolved, remembered: terminals start in
// few places, and the file system is asked outside the lock so that a slow
// one holds up no one else. A path that cannot be resolved stays as it is.
func (r *Resolver) realPath(p string) string {
	r.mu.Lock()
	real, ok := r.real[p]
	r.mu.Unlock()
	if ok {
		return real
	}
	real = p
	if filepath.IsAbs(p) { // never against Mori's own working directory
		if rp, err := filepath.EvalSymlinks(p); err == nil {
			real = rp
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.real) >= maxReal {
		clear(r.real)
	}
	r.real[p] = real
	return real
}

// match finds the folder whose path, or a worktree of it, is the deepest
// to hold path: a folder's own path before a worktree at the same place,
// and the folder registered first among equals. Called with r.mu held.
func (r *Resolver) match(fs []store.Folder, path string) (id, worktree string, ok bool) {
	best, own := -1, false
	try := func(fid, dir string, isOwn bool) {
		if dir == "" || !Within(path, dir) {
			return
		}
		if len(dir) > best || len(dir) == best && isOwn && !own {
			best, own, id = len(dir), isOwn, fid
		}
	}
	for _, f := range fs {
		try(f.ID, filepath.Clean(f.Path), true)
		for _, w := range r.wts[f.ID] {
			try(f.ID, w.Path, false)
		}
	}
	if best < 0 {
		return "", "", false
	}
	if w, ok := deepest(r.wts[id], path); ok {
		worktree = w.Path
	}
	return id, worktree, true
}

// deepest is the worktree in ws that holds path most closely.
func deepest(ws []gitx.Worktree, path string) (gitx.Worktree, bool) {
	var best gitx.Worktree
	ok := false
	for _, w := range ws {
		if Within(path, w.Path) && (!ok || len(w.Path) > len(best.Path)) {
			best, ok = w, true
		}
	}
	return best, ok
}

// Refresh asks git for the worktrees of folder id again and keeps them. A
// folder that is not the top of a worktree has none (spec §3 decision 68),
// and so has one that is not registered. When git fails, the folder keeps
// what it had, which Refresh returns with the error.
func (r *Resolver) Refresh(ctx context.Context, id string) ([]gitx.Worktree, error) {
	fs := r.st.Folders()
	i := slices.IndexFunc(fs, func(f store.Folder) bool { return f.ID == id })
	if i < 0 {
		return []gitx.Worktree{}, nil
	}
	ticket := r.ticket()
	ws, err := r.list(ctx, fs[i])
	if err != nil {
		return r.Worktrees(id), err
	}
	r.mu.Lock()
	changed := r.save(id, ticket, ws)
	onChange := r.onChange
	r.mu.Unlock()
	if changed && onChange != nil {
		onChange()
	}
	return r.Worktrees(id), nil
}

// RefreshAll refreshes the folders one after another and forgets the
// worktrees of folders no longer registered. It returns the error of each
// folder git failed for; those keep what they had.
func (r *Resolver) RefreshAll(ctx context.Context) map[string]error {
	errs := map[string]error{}
	changed := false
	for _, f := range r.st.Folders() {
		if ctx.Err() != nil {
			break
		}
		ticket := r.ticket()
		ws, err := r.list(ctx, f)
		if err != nil {
			errs[f.ID] = err
			continue
		}
		r.mu.Lock()
		changed = r.save(f.ID, ticket, ws) || changed
		r.mu.Unlock()
	}
	r.mu.Lock()
	// Read under the lock, so that a folder registered since the loop and
	// refreshed already stays.
	keep := map[string]bool{}
	for _, f := range r.st.Folders() {
		keep[f.ID] = true
	}
	for id := range r.wts {
		if !keep[id] {
			delete(r.wts, id)
			changed = true
		}
	}
	for id := range r.tickets {
		if !keep[id] {
			delete(r.tickets, id)
		}
	}
	onChange := r.onChange
	r.mu.Unlock()
	if changed && onChange != nil {
		onChange()
	}
	return errs
}

// Run refreshes every folder now and then every so often until ctx ends,
// logging a folder's git error when it appears, changes or clears.
func (r *Resolver) Run(ctx context.Context, every time.Duration, log *slog.Logger) {
	last := map[string]string{}
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		errs := r.RefreshAll(ctx)
		if ctx.Err() != nil {
			return
		}
		logErrors(log, last, errs)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// logErrors logs how errs differs from the errors in last, then makes last
// hold errs: a refresh every 30 seconds must not log the same failure each
// time (spec §3 decision 76).
func logErrors(log *slog.Logger, last map[string]string, errs map[string]error) {
	for id, err := range errs {
		if msg := err.Error(); last[id] != msg {
			log.Warn("folder worktrees", "folder", id, "err", msg)
			last[id] = msg
		}
	}
	for id := range last {
		if errs[id] == nil {
			log.Info("folder worktrees: error cleared", "folder", id)
			delete(last, id)
		}
	}
}

// ticket orders refreshes by when they asked git.
func (r *Resolver) ticket() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	return r.next
}

// save keeps ws as the worktrees of folder id unless a refresh that asked
// git later has saved already, and reports whether they changed (spec §3
// decision 72). Called with r.mu held.
func (r *Resolver) save(id string, ticket uint64, ws []gitx.Worktree) bool {
	if ticket < r.tickets[id] {
		return false
	}
	r.tickets[id] = ticket
	old := r.wts[id]
	if len(ws) == 0 {
		delete(r.wts, id)
	} else {
		r.wts[id] = ws
	}
	return !slices.Equal(old, ws)
}

func (r *Resolver) list(ctx context.Context, f store.Folder) ([]gitx.Worktree, error) {
	if !gitx.IsRepo(f.Path) {
		return nil, nil
	}
	return r.git.Worktrees(ctx, f.Path)
}

// Worktrees is a copy of the worktrees last listed for folder id, main
// first; [] when it has none.
func (r *Resolver) Worktrees(id string) []gitx.Worktree {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]gitx.Worktree{}, r.wts[id]...)
}

// Owner finds the registered folder that has the worktree at path, as
// given or by its real path: a path the git API may work in (spec §8).
func (r *Resolver) Owner(path string) (folderID string, wt gitx.Worktree, ok bool) {
	paths := candidates(path)
	fs := r.st.Folders()
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, f := range fs {
		if w, ok := find(r.wts[f.ID], paths); ok {
			return f.ID, w, true
		}
	}
	return "", gitx.Worktree{}, false
}

// Match finds the worktree at path in ws, as given or by its real path.
func Match(ws []gitx.Worktree, path string) (gitx.Worktree, bool) {
	return find(ws, candidates(path))
}

func find(ws []gitx.Worktree, paths []string) (gitx.Worktree, bool) {
	for _, p := range paths {
		for _, w := range ws {
			if SamePath(w.Path, p) {
				return w, true
			}
		}
	}
	return gitx.Worktree{}, false
}

// candidates are path cleaned and, when it differs, its real path.
func candidates(path string) []string {
	p := filepath.Clean(path)
	ps := []string{p}
	if filepath.IsAbs(p) {
		if real, err := Canonical(p); err == nil && real != p {
			ps = append(ps, real)
		}
	}
	return ps
}

// Inside reports whether t started in dir or below it, or its foreground
// program runs there now, by the paths as given or their real paths. A
// terminal of another machine never is: its paths are not this host's.
func Inside(t hc.Terminal, dir string) bool {
	if remote(t.Address) {
		return false
	}
	cwds := []string{t.Cwd}
	if t.Foreground != nil {
		cwds = append(cwds, t.Foreground.Cwd)
	}
	for _, c := range cwds {
		if c == "" {
			continue
		}
		c = filepath.Clean(c)
		if Within(c, dir) {
			return true
		}
		if filepath.IsAbs(c) {
			if real, err := filepath.EvalSymlinks(c); err == nil && Within(real, dir) {
				return true
			}
		}
	}
	return false
}

// Canonical is path made absolute with its symlinks resolved, the form git
// reports paths in and folders are kept in. The path must exist.
func Canonical(path string) (string, error) {
	p, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}

// Within reports whether path is dir or inside it. Both are clean.
func Within(path, dir string) bool {
	if dir == "" || len(path) < len(dir) || !SamePath(path[:len(dir)], dir) {
		return false
	}
	return len(path) == len(dir) || os.IsPathSeparator(dir[len(dir)-1]) || os.IsPathSeparator(path[len(dir)])
}

// SamePath reports whether a and b are the same path the way the host
// compares names: regardless of case on Windows, exactly elsewhere.
func SamePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// remote reports whether addr names a terminal of another machine, as
// rohan/t7 does.
func remote(addr string) bool { return strings.Contains(addr, "/") }
