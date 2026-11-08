// Package gittest makes git repositories for tests, with the user's own
// git config kept out of them.
package gittest

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Repo makes a repository named repo with one commit on main in a new
// temporary directory and returns its real path: git reports real paths,
// and macOS keeps temporary directories behind a symlink. It skips the
// test when git is not installed.
func Repo(t testing.TB) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	Isolate(t)
	dir := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("mori\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	Git(t, dir, "init", "-q", "-b", "main")
	Git(t, dir, "add", "-A")
	Git(t, dir, "commit", "-q", "-m", "init")
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

// Isolate points git at an empty global config and no system one until
// the test ends, for the test's own git and the git Mori runs.
func Isolate(t testing.TB) {
	t.Helper()
	empty := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(empty, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", empty)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
}

// Git runs git in dir as a test committer and fails the test when git
// fails.
func Git(t testing.TB, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=mori-test", "-c", "user.email=mori-test@example.com", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}
