package folders

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/gittest"
	"github.com/kwonikhyeon/mori/internal/gitx"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/store"
)

// abs makes a path of this machine from a slash path that starts at the
// root, on drive C: on Windows.
func abs(p string) string {
	if p == "" || runtime.GOOS != "windows" {
		return p
	}
	return "C:" + filepath.FromSlash(p)
}

func newResolver(t *testing.T, fs ...store.Folder) *Resolver {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Update(func(s *store.State) error { s.Folders = fs; return nil }); err != nil {
		t.Fatal(err)
	}
	return New(st, gitx.Runner{})
}

// setWorktrees stands in for git listing the worktrees of folder id.
func (r *Resolver) setWorktrees(id string, ws ...gitx.Worktree) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.wts[id] = ws
}

func label(id string) map[string]string { return map[string]string{core.LabelFolder: id} }

func mkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
}

// realTempDir is a new temporary directory by its real path.
func realTempDir(t *testing.T) string {
	t.Helper()
	dir, err := Canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestWithin(t *testing.T) {
	cases := []struct {
		path, dir string
		want      bool
	}{
		{"/w/app/src", "/w/app", true},
		{"/w/app", "/w/app", true},
		{"/w/application", "/w/app", false},
		{"/w", "/w/app", false},
		{"/other/app", "/w/app", false},
		{"/w/app", "/", true},
		{"/", "/", true},
	}
	for _, c := range cases {
		if got := Within(abs(c.path), abs(c.dir)); got != c.want {
			t.Errorf("Within(%q, %q) = %v", c.path, c.dir, got)
		}
	}
	if runtime.GOOS == "windows" && (!Within(`C:\W\App\src`, `c:\w\app`) || !SamePath(`C:\W\App`, `c:\w\app`)) {
		t.Error("on Windows, paths that differ in case only are the same")
	}
	if runtime.GOOS != "windows" && (Within("/W/App/src", "/w/app") || SamePath("/W/App", "/w/app")) {
		t.Error("paths that differ in case are different")
	}
}

func TestResolveOrder(t *testing.T) {
	r := newResolver(t,
		store.Folder{ID: "f_a", Path: abs("/w/app")},
		store.Folder{ID: "f_b", Path: abs("/w/app/sub")},
		store.Folder{ID: "f_c", Path: abs("/w/other")})
	r.setWorktrees("f_a", gitx.Worktree{Path: abs("/w/app"), Main: true}, gitx.Worktree{Path: abs("/w/app.wt/feat")})
	cases := []struct {
		addr, cwd string
		labels    map[string]string
		id, wt    string
	}{
		{"t1", "/w/app/src", nil, "f_a", "/w/app"},
		{"t1", "/w/app/sub/x", nil, "f_b", ""},                     // the deeper folder
		{"t1", "/w/app.wt/feat/pkg", nil, "f_a", "/w/app.wt/feat"}, // a worktree beside its folder
		{"t1", "/w/other", label("f_a"), "f_a", ""},                // the label first
		{"t1", "/w/app.wt/feat", label("f_a"), "f_a", "/w/app.wt/feat"},
		{"t1", "/w/other", label("f_gone"), "f_c", ""}, // a label of no registered folder
		{"t1", "/elsewhere", nil, "", ""},
		{"t1", "/w/application", nil, "", ""},            // a sibling that shares a prefix
		{"rohan/t7", "/w/app/src", label("f_a"), "", ""}, // another machine's terminal
		{"t1", "", nil, "", ""},
	}
	for _, c := range cases {
		id, wt := r.Resolve(hc.Terminal{Address: c.addr, Cwd: abs(c.cwd), Labels: c.labels})
		if id != c.id || wt != abs(c.wt) {
			t.Errorf("%s in %s %v: (%q, %q), want (%q, %q)", c.addr, c.cwd, c.labels, id, wt, c.id, abs(c.wt))
		}
	}
}

func TestResolveTies(t *testing.T) {
	// git lists the same worktrees from any worktree of a repository.
	ws := []gitx.Worktree{{Path: abs("/w/app"), Main: true}, {Path: abs("/w/app.wt/feat")}, {Path: abs("/w/app.wt/other")}}
	r := newResolver(t,
		store.Folder{ID: "f_a", Path: abs("/w/app")},
		store.Folder{ID: "f_x", Path: abs("/w/app.wt/feat")}, // a linked worktree registered as well
		store.Folder{ID: "f_d1", Path: abs("/w/dup")},
		store.Folder{ID: "f_d2", Path: abs("/w/dup")}) // a hand-edited state.json may have this
	r.setWorktrees("f_a", ws...)
	r.setWorktrees("f_x", ws...)
	cases := []struct{ cwd, id, wt string }{
		{"/w/app.wt/feat/pkg", "f_x", "/w/app.wt/feat"}, // a folder's own path over a worktree of another
		{"/w/app/src", "f_a", "/w/app"},
		{"/w/app.wt/other/x", "f_a", "/w/app.wt/other"}, // the folder registered first
		{"/w/dup/x", "f_d1", ""},
	}
	for _, c := range cases {
		if id, wt := r.Resolve(hc.Terminal{Address: "t1", Cwd: abs(c.cwd)}); id != c.id || wt != abs(c.wt) {
			t.Errorf("%s: (%q, %q), want (%q, %q)", c.cwd, id, wt, c.id, abs(c.wt))
		}
	}
}

func TestResolveThroughSymlink(t *testing.T) { // plan Review Focus 5
	base := realTempDir(t)
	home := filepath.Join(base, "home")
	proj := filepath.Join(base, "data", "proj")
	mkdir(t, home)
	mkdir(t, filepath.Join(proj, "sub"))
	link := filepath.Join(home, "proj-link")
	if err := os.Symlink(proj, link); err != nil {
		t.Skip("cannot make a symlink here:", err)
	}
	r := newResolver(t, store.Folder{ID: "f_home", Path: home}, store.Folder{ID: "f_proj", Path: proj})
	r.setWorktrees("f_proj", gitx.Worktree{Path: proj, Main: true})
	cases := []struct {
		cwd    string
		labels map[string]string
		id, wt string
	}{
		{link, nil, "f_proj", proj}, // where the link leads, not the folder it sits in
		{filepath.Join(link, "sub"), nil, "f_proj", proj},
		{link, label("f_proj"), "f_proj", proj},
		{filepath.Join(home, "gone"), nil, "f_home", ""}, // a cwd that is no longer there, as it is
	}
	for _, c := range cases {
		for range 2 { // the second time from the cache
			if id, wt := r.Resolve(hc.Terminal{Address: "t1", Cwd: c.cwd, Labels: c.labels}); id != c.id || wt != c.wt {
				t.Errorf("%s %v: (%q, %q), want (%q, %q)", c.cwd, c.labels, id, wt, c.id, c.wt)
			}
		}
	}

	if runtime.GOOS == "darwin" { // its temporary directories sit behind /var -> /private/var
		raw := t.TempDir()
		canon, err := Canonical(raw)
		if err != nil || canon == raw {
			t.Fatalf("%q -> %q, %v", raw, canon, err)
		}
		r := newResolver(t, store.Folder{ID: "f_t", Path: canon})
		if id, _ := r.Resolve(hc.Terminal{Address: "t1", Cwd: raw}); id != "f_t" {
			t.Fatalf("%q: %q", raw, id)
		}
	}
}

func TestOwner(t *testing.T) {
	r := newResolver(t, store.Folder{ID: "f_a", Path: abs("/w/app")})
	feat := gitx.Worktree{Path: abs("/w/app.wt/feat"), Branch: "feat"}
	r.setWorktrees("f_a", gitx.Worktree{Path: abs("/w/app"), Main: true}, feat)
	r.setWorktrees("f_gone", gitx.Worktree{Path: abs("/w/gone"), Main: true}) // cached, but no longer registered
	cases := []struct {
		path string
		ok   bool
	}{
		{"/w/app.wt/feat", true},
		{"/w/app.wt/feat/", true},
		{"/w/app", true},
		{"/w/app.wt/feat/sub", false}, // worktrees only, not what is in them
		{"/w/gone", false},
		{"/w/elsewhere", false},
	}
	for _, c := range cases {
		id, w, ok := r.Owner(abs(c.path))
		if ok != c.ok || ok && id != "f_a" {
			t.Errorf("%s: (%q, %+v, %v)", c.path, id, w, ok)
		}
	}
	if _, w, _ := r.Owner(feat.Path); w != feat {
		t.Fatalf("%+v", w)
	}

	base := realTempDir(t)
	wt := filepath.Join(base, "app.wt", "feat")
	mkdir(t, wt)
	link := filepath.Join(base, "link")
	if err := os.Symlink(wt, link); err != nil {
		t.Skip("cannot make a symlink here:", err)
	}
	r = newResolver(t, store.Folder{ID: "f_b", Path: filepath.Join(base, "app")})
	r.setWorktrees("f_b", gitx.Worktree{Path: filepath.Join(base, "app"), Main: true}, gitx.Worktree{Path: wt})
	if id, w, ok := r.Owner(link); !ok || id != "f_b" || w.Path != wt {
		t.Fatalf("through a symlink: (%q, %+v, %v)", id, w, ok)
	}
	if w, ok := Match(r.Worktrees("f_b"), link); !ok || w.Path != wt {
		t.Fatalf("Match through a symlink: (%+v, %v)", w, ok)
	}
}

func TestInside(t *testing.T) {
	wt := abs("/w/app.wt/feat")
	fg := func(cwd string) *hc.Foreground { return &hc.Foreground{Name: "sh", Cwd: abs(cwd)} }
	cases := []struct {
		t    hc.Terminal
		want bool
	}{
		{hc.Terminal{Address: "t1", Cwd: abs("/w/app.wt/feat/pkg")}, true},
		{hc.Terminal{Address: "t1", Cwd: wt}, true},
		{hc.Terminal{Address: "t1", Cwd: abs("/w/app"), Foreground: fg("/w/app.wt/feat/x")}, true}, // went there since
		{hc.Terminal{Address: "t1", Cwd: abs("/w/app"), Foreground: fg("/w/app/src")}, false},
		{hc.Terminal{Address: "t1", Cwd: abs("/w/app.wt/feature")}, false},
		{hc.Terminal{Address: "rohan/t7", Cwd: wt}, false}, // another machine's path
		{hc.Terminal{Address: "t1"}, false},
	}
	for _, c := range cases {
		if got := Inside(c.t, wt); got != c.want {
			t.Errorf("%+v: %v", c.t, got)
		}
	}

	base := realTempDir(t)
	dir := filepath.Join(base, "app.wt", "feat")
	mkdir(t, filepath.Join(dir, "pkg"))
	link := filepath.Join(base, "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Skip("cannot make a symlink here:", err)
	}
	if !Inside(hc.Terminal{Address: "t1", Cwd: base, Foreground: &hc.Foreground{Cwd: filepath.Join(link, "pkg")}}, dir) {
		t.Fatal("a foreground cwd through a symlink")
	}
}

func TestRefreshFromGit(t *testing.T) {
	repo := gittest.Repo(t)
	plain := realTempDir(t)
	sub := filepath.Join(repo, "sub")
	mkdir(t, sub)
	r := newResolver(t,
		store.Folder{ID: "f_r", Path: repo},
		store.Folder{ID: "f_plain", Path: plain},
		store.Folder{ID: "f_sub", Path: sub}) // inside a worktree, not the top of one
	var changes atomic.Int32
	r.OnChange(func() { changes.Add(1) })
	ctx := context.Background()

	ws, err := r.Refresh(ctx, "f_r")
	if err != nil || len(ws) != 1 || !ws[0].Main || ws[0].Path != repo || ws[0].Branch != "main" || changes.Load() != 1 {
		t.Fatalf("%+v %v, %d changes", ws, err, changes.Load())
	}
	if _, err := r.Refresh(ctx, "f_r"); err != nil || changes.Load() != 1 {
		t.Fatalf("nothing changed: %v, %d changes", err, changes.Load())
	}
	for _, id := range []string{"f_plain", "f_sub", "f_unknown"} {
		if ws, err := r.Refresh(ctx, id); err != nil || ws == nil || len(ws) != 0 {
			t.Errorf("%s: %+v %v", id, ws, err)
		}
	}
	if changes.Load() != 1 {
		t.Fatalf("%d changes", changes.Load())
	}

	wt := gitx.WorktreePath(repo, "feat")
	gittest.Git(t, repo, "worktree", "add", "-b", "feat", wt)
	if errs := r.RefreshAll(ctx); len(errs) != 0 || changes.Load() != 2 {
		t.Fatalf("%v, %d changes", errs, changes.Load())
	}
	if ws := r.Worktrees("f_r"); len(ws) != 2 || ws[1].Path != wt || ws[1].Branch != "feat" || ws[1].Main {
		t.Fatalf("%+v", ws)
	}
	if id, w := r.Resolve(hc.Terminal{Address: "t1", Cwd: filepath.Join(wt, "x")}); id != "f_r" || w != wt {
		t.Fatalf("(%q, %q)", id, w)
	}
	if id, w := r.Resolve(hc.Terminal{Address: "t1", Cwd: filepath.Join(sub, "x")}); id != "f_sub" || w != "" {
		t.Fatalf("(%q, %q)", id, w)
	}

	// When git fails, a folder keeps what it had.
	r.git = gitx.Runner{Path: "mori-no-such-git"}
	if _, err := r.Refresh(ctx, "f_r"); err == nil {
		t.Fatal("no error")
	}
	if errs := r.RefreshAll(ctx); len(errs) != 1 || errs["f_r"] == nil {
		t.Fatalf("%v", errs)
	}
	if len(r.Worktrees("f_r")) != 2 || changes.Load() != 2 {
		t.Fatalf("%+v, %d changes", r.Worktrees("f_r"), changes.Load())
	}

	// A folder no longer registered is forgotten.
	r.git = gitx.Runner{}
	if err := r.st.Update(func(s *store.State) error { s.Folders = s.Folders[1:]; return nil }); err != nil {
		t.Fatal(err)
	}
	if errs := r.RefreshAll(ctx); len(errs) != 0 || len(r.Worktrees("f_r")) != 0 || changes.Load() != 3 {
		t.Fatalf("%v %+v, %d changes", errs, r.Worktrees("f_r"), changes.Load())
	}
}

func TestLaterRefreshWins(t *testing.T) {
	r := newResolver(t, store.Folder{ID: "f_a", Path: abs("/w/app")})
	older, newer := r.ticket(), r.ticket()
	r.mu.Lock()
	r.save("f_a", newer, []gitx.Worktree{{Path: abs("/w/app"), Main: true}, {Path: abs("/w/app.wt/new")}})
	changed := r.save("f_a", older, []gitx.Worktree{{Path: abs("/w/app"), Main: true}}) // started first, ended last
	r.mu.Unlock()
	if ws := r.Worktrees("f_a"); changed || len(ws) != 2 {
		t.Fatalf("an older refresh overwrote a newer one: %+v", ws)
	}
}

func TestLogErrorsOnChangeOnly(t *testing.T) {
	var buf strings.Builder
	log := slog.New(slog.NewTextHandler(&buf, nil))
	last := map[string]string{}
	boom := errors.New("git worktree list: boom")
	logErrors(log, last, map[string]error{"f_a": boom})
	logErrors(log, last, map[string]error{"f_a": boom})
	if n := strings.Count(buf.String(), "level=WARN"); n != 1 {
		t.Fatalf("the same error logged %d times:\n%s", n, buf.String())
	}
	logErrors(log, last, map[string]error{"f_a": errors.New("git worktree list: other")})
	logErrors(log, last, map[string]error{})
	logErrors(log, last, map[string]error{})
	if w, i := strings.Count(buf.String(), "level=WARN"), strings.Count(buf.String(), "level=INFO"); w != 2 || i != 1 || len(last) != 0 {
		t.Fatalf("%d warnings, %d infos:\n%s", w, i, buf.String())
	}
}
