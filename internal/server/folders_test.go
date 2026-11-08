package server

import (
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/kwonikhyeon/mori/internal/gittest"
	"github.com/kwonikhyeon/mori/internal/gitx"
	"github.com/kwonikhyeon/mori/internal/hctest"
	"github.com/kwonikhyeon/mori/internal/store"
)

// realDir makes a temporary directory and returns its real path, the form
// folders are kept in.
func realDir(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func mkdirs(t *testing.T, dirs ...string) {
	t.Helper()
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func writeFile(t *testing.T, path, s string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

// symlink makes link lead to target. Windows lets only some users make
// links; there it reports false instead of failing the test.
func symlink(t *testing.T, target, link string) bool {
	t.Helper()
	err := os.Symlink(target, link)
	if err != nil && runtime.GOOS != "windows" {
		t.Fatal(err)
	}
	return err == nil
}

func gone(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("%s is still there: %v", path, err)
	}
}

func TestFolderCRUD(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	dir := realDir(t)
	proj, other := filepath.Join(dir, "proj"), filepath.Join(dir, "other")
	mkdirs(t, proj, other)
	file := filepath.Join(dir, "f.txt")
	writeFile(t, file, "x")

	var f FolderView
	e.json("POST", "/api/folders", map[string]any{"path": proj + string(filepath.Separator)}, 201, &f)
	if f.ID == "" || f.Name != "proj" || f.Path != proj || f.CreatedMs == 0 || f.Repo || f.Worktrees == nil || len(f.Worktrees) != 0 {
		t.Fatalf("%+v", f)
	}
	for _, c := range []struct {
		body map[string]any
		msg  string
	}{
		{map[string]any{}, "path가 필요합니다"},
		{map[string]any{"path": "proj"}, "절대 경로"},
		{map[string]any{"path": filepath.Join(dir, "missing")}, "폴더가 없습니다"},
		{map[string]any{"path": file}, "폴더가 아닙니다"},
		{map[string]any{"path": other, "name": strings.Repeat("가", maxTitle+1)}, "자까지"},
	} {
		if eb := e.expectError("POST", "/api/folders", c.body, 400); eb.Error.Kind != "invalid_params" || !strings.Contains(eb.Error.Message, c.msg) {
			t.Fatal(c.body, eb)
		}
	}
	if eb := e.expectError("POST", "/api/folders", map[string]any{"path": proj}, 409); eb.Error.Kind != "conflict" {
		t.Fatal(eb)
	}
	var g FolderView
	e.json("POST", "/api/folders", map[string]any{"path": other, "name": "  다른\n 폴더 "}, 201, &g)
	if g.Name != "다른 폴더" || g.Path != other {
		t.Fatalf("%+v", g)
	}
	if link := filepath.Join(dir, "link"); symlink(t, proj, link) {
		// The same directory through a link is the same folder.
		if eb := e.expectError("POST", "/api/folders", map[string]any{"path": link}, 409); eb.Error.Kind != "conflict" {
			t.Fatal(eb)
		}
		// A new one is kept by its real path, named as the user picked it.
		third, thirdLink := filepath.Join(dir, "third"), filepath.Join(dir, "third-link")
		mkdirs(t, third)
		symlink(t, third, thirdLink)
		var h FolderView
		e.json("POST", "/api/folders", map[string]any{"path": thirdLink}, 201, &h)
		if h.Path != third || h.Name != "third-link" {
			t.Fatalf("%+v", h)
		}
		e.json("DELETE", "/api/folders/"+h.ID, nil, 204, nil)
	}
	var list []FolderView
	e.json("GET", "/api/folders", nil, 200, &list)
	if len(list) != 2 || list[0].ID != f.ID || list[1].ID != g.ID {
		t.Fatalf("%+v", list)
	}

	var p FolderView
	e.json("PATCH", "/api/folders/"+f.ID, map[string]any{"name": "새 이름"}, 200, &p)
	if p.ID != f.ID || p.Name != "새 이름" || p.Path != proj || p.Worktrees == nil {
		t.Fatalf("%+v", p)
	}
	e.json("PATCH", "/api/folders/"+f.ID, map[string]any{"name": " "}, 200, &p)
	if p.Name != "proj" {
		t.Fatalf("%+v", p)
	}
	e.expectError("PATCH", "/api/folders/"+f.ID, map[string]any{}, 400)
	e.expectError("PATCH", "/api/folders/"+f.ID, map[string]any{"name": strings.Repeat("가", maxTitle+1)}, 400)
	if eb := e.expectError("PATCH", "/api/folders/f_nope", map[string]any{"name": "x"}, 404); eb.Error.Kind != "not_found" {
		t.Fatal(eb)
	}

	e.json("DELETE", "/api/folders/"+f.ID, nil, 204, nil)
	e.expectError("DELETE", "/api/folders/"+f.ID, nil, 404)
	e.json("GET", "/api/folders", nil, 200, &list)
	if len(list) != 1 || list[0].ID != g.ID {
		t.Fatalf("%+v", list)
	}
	if _, err := os.Stat(proj); err != nil { // forgetting a folder leaves its files
		t.Fatal(err)
	}
}

func TestFsListsDirectoriesOnly(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	dir := realDir(t)
	mkdirs(t, filepath.Join(dir, "a"), filepath.Join(dir, "B"), filepath.Join(dir, ".hidden"), filepath.Join(dir, "r", ".git"))
	writeFile(t, filepath.Join(dir, "f.txt"), "x")
	want := []fsEntry{{Name: "a", Path: filepath.Join(dir, "a")}, {Name: "B", Path: filepath.Join(dir, "B")}}
	if symlink(t, filepath.Join(dir, "a"), filepath.Join(dir, "l")) {
		symlink(t, filepath.Join(dir, "f.txt"), filepath.Join(dir, "lf")) // leads to a file: not listed
		want = append(want, fsEntry{Name: "l", Path: filepath.Join(dir, "l")})
	}
	want = append(want, fsEntry{Name: "r", Path: filepath.Join(dir, "r"), Git: true})

	type listing struct {
		Path, Parent string
		Entries      []fsEntry
		Truncated    bool
	}
	get := func(query string) listing {
		t.Helper()
		var l listing
		e.json("GET", "/api/fs"+query, nil, 200, &l)
		return l
	}
	q := "?path=" + url.QueryEscape(dir)
	if l := get(q); l.Path != dir || l.Parent != filepath.Dir(dir) || l.Truncated || !slices.Equal(l.Entries, want) {
		t.Fatalf("%+v", l)
	}
	if l := get(q + "&hidden=1"); len(l.Entries) != len(want)+1 || l.Entries[0].Name != ".hidden" {
		t.Fatalf("%+v", l)
	}
	if eb := e.expectError("GET", "/api/fs?path="+url.QueryEscape(filepath.Join(dir, "missing")), nil, 404); eb.Error.Kind != "not_found" {
		t.Fatal(eb)
	}
	e.expectError("GET", "/api/fs?path=relative", nil, 400)
	e.expectError("GET", "/api/fs?path="+url.QueryEscape(filepath.Join(dir, "f.txt")), nil, 400)
	e.expectError("GET", "/api/fs"+q+"&hidden=maybe", nil, 400)

	// The home directory by default; the root has no parent.
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	if l := get(""); l.Path != dir {
		t.Fatalf("%+v", l)
	}
	root := filepath.VolumeName(dir) + string(filepath.Separator)
	if l := get("?path=" + url.QueryEscape(root)); l.Path != root || l.Parent != "" {
		t.Fatalf("%+v", l)
	}
}

func TestGitOnPlainFolder(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	f := e.addFolder(realDir(t))
	base := "/api/folders/" + f.ID

	var sum gitSummary
	e.json("GET", base+"/git", nil, 200, &sum)
	if sum.Repo || sum.Branch != "" || sum.Worktrees == nil || len(sum.Worktrees) != 0 {
		t.Fatalf("%+v", sum)
	}
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{"GET", base + "/branches", nil},
		{"POST", base + "/worktrees", map[string]any{"branch": "x", "create": true}},
		{"DELETE", base + "/worktrees?path=" + url.QueryEscape(f.Path), nil},
	} {
		if eb := e.expectError(c.method, c.path, c.body, 409); eb.Error.Kind != "conflict" {
			t.Fatal(c, eb)
		}
	}
	e.expectError("GET", "/api/folders/f_nope/git", nil, 404)
	e.expectError("GET", "/api/folders/f_nope/branches", nil, 404)
	e.expectError("POST", "/api/folders/f_nope/worktrees", map[string]any{"branch": "x"}, 404)
	e.expectError("POST", base+"/worktrees", map[string]any{"branch": " "}, 400)
	e.expectError("DELETE", base+"/worktrees", nil, 400)
	e.expectError("DELETE", base+"/worktrees?path=rel", nil, 400)
	e.expectError("DELETE", base+"/worktrees?force=maybe&path="+url.QueryEscape(f.Path), nil, 400)
}

func TestRemoveWorktreeChecks(t *testing.T) {
	repo := gittest.Repo(t)
	e := newTestEnv(t) // the core is down
	e.pair()
	var f FolderView
	e.json("POST", "/api/folders", map[string]any{"path": repo}, 201, &f)
	if !f.Repo || len(f.Worktrees) != 1 || !f.Worktrees[0].Main || f.Worktrees[0].Path != repo || f.Worktrees[0].Branch != "main" {
		t.Fatalf("%+v", f)
	}
	// Made outside Mori: the folder finds it when it asks git again.
	wt := filepath.Join(filepath.Dir(repo), "outside")
	gittest.Git(t, repo, "worktree", "add", "-q", "-b", "side", wt)
	del := func(p string) string { return "/api/folders/" + f.ID + "/worktrees?path=" + url.QueryEscape(p) }

	if eb := e.expectError("DELETE", del(repo), nil, 400); !strings.Contains(eb.Error.Message, "주 워크트리") {
		t.Fatal(eb)
	}
	if eb := e.expectError("DELETE", del(filepath.Join(filepath.Dir(repo), "nope")), nil, 400); eb.Error.Kind != "invalid_params" {
		t.Fatal(eb)
	}
	// With the core away there is no telling whether a session runs there.
	if eb := e.expectError("DELETE", del(wt), nil, 503); eb.Error.Kind != "core_unavailable" {
		t.Fatal(eb)
	}
	// A folder registered inside it keeps it, core or not.
	sub := filepath.Join(wt, "sub")
	mkdirs(t, sub)
	e.addFolder(sub)
	if eb := e.expectError("DELETE", del(wt), nil, 409); eb.Error.Kind != "conflict" {
		t.Fatal(eb)
	}
	if _, err := os.Stat(wt); err != nil {
		t.Fatal(err)
	}
}

func TestWorktreeLifecycleRefusesLiveSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	repo := gittest.Repo(t)
	e := newTestEnv(t, withCore(t, hctest.Start(t)))
	e.pair()
	e.addPreset(store.Preset{ID: "sh", Name: "sh", Argv: []string{"/bin/sh"}})
	var f FolderView
	e.json("POST", "/api/folders", map[string]any{"path": repo}, 201, &f)
	base := "/api/folders/" + f.ID

	var bs gitx.Branches
	e.json("GET", base+"/branches", nil, 200, &bs)
	if len(bs.Local) != 1 || bs.Local[0].Name != "main" || !bs.Local[0].Current {
		t.Fatalf("%+v", bs)
	}
	var wt gitx.Worktree
	e.json("POST", base+"/worktrees", map[string]any{"branch": "feat/x", "create": true}, 201, &wt)
	if want := filepath.Join(filepath.Dir(repo), filepath.Base(repo)+".wt", "feat-x"); wt.Path != want || wt.Branch != "feat/x" || wt.Main || wt.Head == "" {
		t.Fatalf("%+v, want it at %s", wt, want)
	}
	// The branch is there now, so git refuses to make it again.
	if eb := e.expectError("POST", base+"/worktrees", map[string]any{"branch": "feat/x", "create": true}, 422); eb.Error.Kind != "git_failed" {
		t.Fatal(eb)
	}
	for _, body := range []map[string]any{{"branch": "bad..name", "create": true}, {"branch": "-x"}, {"branch": "y", "create": true, "base": "-q"}} {
		if eb := e.expectError("POST", base+"/worktrees", body, 400); eb.Error.Kind != "invalid_params" {
			t.Fatal(body, eb)
		}
	}
	gittest.Git(t, repo, "branch", "dev")
	var dev gitx.Worktree
	e.json("POST", base+"/worktrees", map[string]any{"branch": "dev"}, 201, &dev)
	if dev.Branch != "dev" || dev.Path != filepath.Join(filepath.Dir(wt.Path), "dev") {
		t.Fatalf("%+v", dev)
	}
	var sum gitSummary
	e.json("GET", base+"/git", nil, 200, &sum)
	if !sum.Repo || sum.Branch != "main" || sum.Head == "" || sum.Detached || sum.Changes != 0 || len(sum.Worktrees) != 3 {
		t.Fatalf("%+v", sum)
	}

	// A session started in the worktree keeps it until the session ends,
	// even when the cache has not heard of it yet.
	var tv TerminalView
	e.json("POST", "/api/terminals", map[string]any{"folder_id": f.ID, "preset": "sh", "worktree": wt.Path}, 201, &tv)
	if tv.FolderID != f.ID || tv.Worktree != wt.Path {
		t.Fatalf("%+v", tv)
	}
	del := base + "/worktrees?path=" + url.QueryEscape(wt.Path)
	if eb := e.expectError("DELETE", del, nil, 409); eb.Error.Kind != "live" {
		t.Fatal(eb)
	}
	term := "/api/terminals/" + url.PathEscape(tv.Address)
	e.json("POST", term+"/kill", nil, 200, nil)
	e.eventually(func() bool {
		var got TerminalView
		e.json("GET", term, nil, 200, &got)
		return got.State == "finished"
	})
	e.json("DELETE", del, nil, 204, nil)
	gone(t, wt.Path)

	// git keeps a worktree with changes unless forced. The .wt directory
	// goes with its last worktree.
	writeFile(t, filepath.Join(dev.Path, "scratch.txt"), "x")
	delDev := base + "/worktrees?path=" + url.QueryEscape(dev.Path)
	if eb := e.expectError("DELETE", delDev, nil, 422); eb.Error.Kind != "git_failed" {
		t.Fatal(eb)
	}
	e.json("DELETE", delDev+"&force=1", nil, 204, nil)
	gone(t, filepath.Dir(dev.Path))
	var list []FolderView
	e.json("GET", "/api/folders", nil, 200, &list)
	if len(list) != 1 || len(list[0].Worktrees) != 1 || !list[0].Worktrees[0].Main {
		t.Fatalf("%+v", list)
	}
}

func TestGitStatusAndDiff(t *testing.T) {
	repo := gittest.Repo(t)
	e := newTestEnv(t)
	e.pair()
	e.json("POST", "/api/folders", map[string]any{"path": repo}, 201, nil)
	writeFile(t, filepath.Join(repo, "README.md"), "mori\nchanged\n")
	writeFile(t, filepath.Join(repo, "new.txt"), "hello\n")
	at := func(p string) string { return "?path=" + url.QueryEscape(p) }

	var st gitx.Status
	e.json("GET", "/api/git/status"+at(repo), nil, 200, &st)
	kinds := map[string]string{}
	for _, c := range st.Changes {
		kinds[c.Path] = c.Kind
	}
	if st.Branch != "main" || len(kinds) != 2 || kinds["README.md"] != "changed" || kinds["new.txt"] != "untracked" {
		t.Fatalf("%+v", st)
	}

	var d struct {
		Diff      string
		Truncated bool
	}
	e.json("GET", "/api/git/diff"+at(repo), nil, 200, &d)
	if !strings.Contains(d.Diff, "+changed") || strings.Contains(d.Diff, "new.txt") || d.Truncated {
		t.Fatalf("%+v", d)
	}
	e.json("GET", "/api/git/diff"+at(repo)+"&file=new.txt", nil, 200, &d)
	if !strings.Contains(d.Diff, "+hello") || strings.Contains(d.Diff, "+changed") {
		t.Fatalf("%+v", d)
	}
	gittest.Git(t, repo, "add", "README.md")
	e.json("GET", "/api/git/diff"+at(repo)+"&staged=1", nil, 200, &d)
	if !strings.Contains(d.Diff, "+changed") {
		t.Fatalf("%+v", d)
	}

	for _, file := range []string{"../x", "a/../../x", filepath.Join(repo, "README.md")} {
		if eb := e.expectError("GET", "/api/git/diff"+at(repo)+"&file="+url.QueryEscape(file), nil, 400); eb.Error.Kind != "invalid_params" {
			t.Fatal(file, eb)
		}
	}
	e.expectError("GET", "/api/git/diff"+at(repo)+"&staged=maybe", nil, 400)
	// Only the worktrees of registered folders, and only their tops.
	for _, p := range []string{"", "rel", realDir(t), filepath.Join(repo, "sub")} {
		e.expectError("GET", "/api/git/status"+at(p), nil, 400)
		e.expectError("GET", "/api/git/diff"+at(p), nil, 400)
	}
	if link := filepath.Join(realDir(t), "link"); symlink(t, repo, link) {
		e.json("GET", "/api/git/status"+at(link), nil, 200, &st)
	}
	// A worktree made outside Mori a moment ago is found when asked for.
	ext := filepath.Join(filepath.Dir(repo), "ext")
	gittest.Git(t, repo, "worktree", "add", "-q", "-b", "ext", ext)
	e.json("GET", "/api/git/status"+at(ext), nil, 200, &st)
	if st.Branch != "ext" || len(st.Changes) != 0 {
		t.Fatalf("%+v", st)
	}
}

func TestFolderViewsCarryWorktrees(t *testing.T) {
	repo := gittest.Repo(t)
	e := newTestEnv(t)
	e.pair()
	e.json("POST", "/api/folders", map[string]any{"path": repo}, 201, nil)

	var ov struct{ Folders []FolderView }
	e.json("GET", "/api/overview", nil, 200, &ov)
	if len(ov.Folders) != 1 || !ov.Folders[0].Repo || len(ov.Folders[0].Worktrees) != 1 {
		t.Fatalf("%+v", ov)
	}
	ev := e.client("/ws/events")
	snap := ev.untilMsg("snapshot", isType("snapshot"))
	if len(snap.Folders) != 1 || !snap.Folders[0].Repo || len(snap.Folders[0].Worktrees) != 1 {
		t.Fatalf("%+v", snap)
	}
	// The periodic refresh finds a worktree made outside Mori, and the
	// browsers hear of it.
	gittest.Git(t, repo, "worktree", "add", "-q", "-b", "side", filepath.Join(filepath.Dir(repo), "side"))
	if errs := e.s.d.Folders.RefreshAll(context.Background()); len(errs) != 0 {
		t.Fatal(errs)
	}
	ev.untilMsg("folders", func(m wsMsg) bool {
		return m.Type == "folders" && len(m.Folders) == 1 && len(m.Folders[0].Worktrees) == 2
	})
}
