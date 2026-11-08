package gitx

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// newRepo makes a repository with one commit under a path with a space and
// Hangul in it, and returns its real path: git reports real paths, and
// macOS keeps temporary directories behind a symlink.
func newRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	// The user's own git config must not change what the tests see.
	empty := filepath.Join(t.TempDir(), "gitconfig")
	write(t, empty, "")
	t.Setenv("GIT_CONFIG_GLOBAL", empty)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")

	dir := filepath.Join(t.TempDir(), "저장소 하나", "app")
	write(t, filepath.Join(dir, "문서", "새 파일.md"), "a\n")
	write(t, filepath.Join(dir, "a.txt"), "a\n")
	write(t, filepath.Join(dir, "[ab].txt"), "glob\n")
	git(t, dir, "init", "-q", "-b", "main")
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-q", "-m", "init")
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=mori-test", "-c", "user.email=mori-test@example.com", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func write(t *testing.T, path, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func changePaths(st Status) []string {
	var ps []string
	for _, c := range st.Changes {
		ps = append(ps, c.Kind+" "+c.Path)
	}
	return ps
}

func TestStatusAndDiff(t *testing.T) {
	repo := newRepo(t)
	ctx := context.Background()
	var g Runner
	write(t, filepath.Join(repo, "문서", "새 파일.md"), "a\nb\n")
	write(t, filepath.Join(repo, "a.txt"), "a\nchanged\n")
	write(t, filepath.Join(repo, "추적 안 됨.txt"), "new\n")

	st, err := g.Status(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"changed a.txt", "changed 문서/새 파일.md", "untracked 추적 안 됨.txt"}
	if got := changePaths(st); st.Branch != "main" || st.Head == "" || !slices.Equal(got, want) {
		t.Fatalf("%+v\n got %q\nwant %q", st, got, want)
	}

	d, truncated, err := g.Diff(ctx, repo, "문서/새 파일.md", false, 1<<20)
	if err != nil || truncated || !strings.Contains(d, "\n+b\n") {
		t.Fatalf("tracked diff (%v, %v):\n%s", truncated, err, d)
	}
	if d, _, err := g.Diff(ctx, repo, "문서/새 파일.md", true, 1<<20); err != nil || d != "" {
		t.Fatalf("nothing is staged, got (%v):\n%s", err, d)
	}
	d, _, err = g.Diff(ctx, repo, "추적 안 됨.txt", false, 1<<20)
	if err != nil || !strings.Contains(d, "--- /dev/null") || !strings.Contains(d, "\n+new\n") {
		t.Fatalf("untracked diff (%v):\n%s", err, d)
	}
	// "[ab].txt" is a name, not a pattern matching a.txt.
	if d, _, err := g.Diff(ctx, repo, "[ab].txt", false, 1<<20); err != nil || d != "" {
		t.Fatalf("pathspec magic (%v):\n%s", err, d)
	}
	d, truncated, err = g.Diff(ctx, repo, "", false, 1<<20)
	if err != nil || truncated || !strings.Contains(d, "+changed") || !strings.Contains(d, "+b") {
		t.Fatalf("whole diff (%v, %v):\n%s", truncated, err, d)
	}
	d, truncated, err = g.Diff(ctx, repo, "", false, 64)
	if err != nil || !truncated || len(d) > 64 || !strings.HasSuffix(d, "\n") {
		t.Fatalf("cut diff (%v, %v): %d bytes\n%s", truncated, err, len(d), d)
	}
}

func TestDiffOfUntrackedDirectory(t *testing.T) {
	repo := newRepo(t)
	ctx := context.Background()
	var g Runner
	write(t, filepath.Join(repo, "새 폴더", "r.txt"), "r\n")
	write(t, filepath.Join(repo, "새 폴더", "sub", "q.txt"), "q\n")
	st, err := g.Status(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	if got := changePaths(st); !slices.Equal(got, []string{"untracked 새 폴더/"}) {
		t.Fatalf("%q", got)
	}
	d, truncated, err := g.Diff(ctx, repo, "새 폴더/", false, 1<<20)
	if err != nil || truncated || !strings.Contains(d, "+++ b/새 폴더/r.txt") || !strings.Contains(d, "+++ b/새 폴더/sub/q.txt") {
		t.Fatalf("(%v, %v):\n%s", truncated, err, d)
	}
	d, truncated, err = g.Diff(ctx, repo, "새 폴더/", false, 100)
	if err != nil || !truncated || len(d) > 100 {
		t.Fatalf("cut (%v, %v): %d bytes\n%s", truncated, err, len(d), d)
	}
}

func TestWorktreesAddRemove(t *testing.T) {
	repo := newRepo(t)
	ctx := context.Background()
	var g Runner
	ws, err := g.Worktrees(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	if len(ws) != 1 || !ws[0].Main || ws[0].Path != repo || ws[0].Branch != "main" {
		t.Fatalf("%+v", ws)
	}

	path := WorktreePath(repo, "feat/새기능")
	if want := filepath.Join(filepath.Dir(repo), "app.wt", "feat"); path != want {
		t.Fatalf("path %q, want %q", path, want)
	}
	if err := g.AddWorktree(ctx, repo, path, "feat/새기능", true, ""); err != nil {
		t.Fatal(err)
	}
	ws, err = g.Worktrees(ctx, path) // from the linked worktree, the main one still comes first
	if err != nil {
		t.Fatal(err)
	}
	if len(ws) != 2 || ws[0].Path != repo || ws[1].Path != path || ws[1].Branch != "feat/새기능" || ws[1].Main {
		t.Fatalf("%+v", ws)
	}
	if !IsRepo(path) || !IsRepo(repo) || IsRepo(filepath.Dir(repo)) {
		t.Fatal("IsRepo")
	}
	if st, err := g.Status(ctx, path); err != nil || st.Branch != "feat/새기능" {
		t.Fatalf("%+v %v", st, err)
	}
	bs, err := g.Branches(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	if len(bs.Local) != 2 || bs.Local[0].Name != "feat/새기능" || bs.Local[0].Current || bs.Local[1].Name != "main" || !bs.Local[1].Current || len(bs.Remote) != 0 {
		t.Fatalf("%+v", bs)
	}

	// From an existing branch at a base: the branch is checked out already.
	err = g.AddWorktree(ctx, repo, WorktreePath(repo, "main"), "main", false, "")
	var ge *Error
	if !errors.As(err, &ge) || !strings.Contains(ge.Stderr, "main") {
		t.Fatalf("checked out twice: %v", err)
	}
	if _, err := os.Stat(WorktreePath(repo, "main")); err == nil {
		t.Fatal("a refused worktree left its directory")
	}

	write(t, filepath.Join(path, "dirty.txt"), "x\n")
	if err := g.RemoveWorktree(ctx, repo, path, false); !errors.As(err, &ge) {
		t.Fatalf("dirty worktree removed without force: %v", err)
	}
	if err := g.RemoveWorktree(ctx, repo, path, true); err != nil {
		t.Fatal(err)
	}
	if ws, err = g.Worktrees(ctx, repo); err != nil || len(ws) != 1 {
		t.Fatalf("%+v %v", ws, err)
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatalf("empty %s left behind: %v", filepath.Dir(path), err)
	}
}

func TestAddWorktreeFromBase(t *testing.T) {
	repo := newRepo(t)
	ctx := context.Background()
	var g Runner
	git(t, repo, "branch", "base-branch")
	path := WorktreePath(repo, "from-base")
	if err := g.AddWorktree(ctx, repo, path, "from-base", true, "base-branch"); err != nil {
		t.Fatal(err)
	}
	if st, err := g.Status(ctx, path); err != nil || st.Branch != "from-base" {
		t.Fatalf("%+v %v", st, err)
	}
	err := g.AddWorktree(ctx, repo, WorktreePath(repo, "x"), "x", true, "no-such-base")
	var ge *Error
	if !errors.As(err, &ge) {
		t.Fatalf("missing base: %v", err)
	}
}

func TestAddWorktreeRejectsBadNames(t *testing.T) {
	repo := newRepo(t)
	ctx := context.Background()
	var g Runner
	for _, c := range []struct{ branch, base string }{
		{"-x", ""}, {"bad..name", ""}, {"a b", ""}, {"", ""}, {"ok", "-q"}, {"ok", "--orphan"},
	} {
		err := g.AddWorktree(ctx, repo, WorktreePath(repo, "bad"), c.branch, true, c.base)
		var ne *NameError
		if !errors.As(err, &ne) {
			t.Errorf("%+v: %v", c, err)
		}
	}
	if ws, err := g.Worktrees(ctx, repo); err != nil || len(ws) != 1 {
		t.Fatalf("%+v %v", ws, err)
	}
}

func TestErrors(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	ctx := context.Background()
	_, err := Runner{}.Status(ctx, t.TempDir())
	var ge *Error
	if !errors.As(err, &ge) || ge.Args[0] != "status" || !strings.Contains(ge.Stderr, "not a git repository") {
		t.Fatalf("not a repository: %#v", err)
	}
	if _, err := (Runner{Path: "mori-no-such-git"}).Status(ctx, t.TempDir()); !errors.Is(err, exec.ErrNotFound) || !errors.As(err, &ge) {
		t.Fatalf("no git: %v", err)
	}
	if _, err := (Runner{Timeout: 1}).Status(ctx, t.TempDir()); !errors.Is(err, context.DeadlineExceeded) || !errors.As(err, &ge) {
		t.Fatalf("timeout: %v", err)
	}
}
