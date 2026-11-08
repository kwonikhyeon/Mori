// Package gitx runs the host's git (spec §3 decision 14) for the status,
// branches, worktrees and diffs of a folder, and reads what it prints.
// It writes nothing to a repository but worktrees.
package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/kwonikhyeon/mori/internal/procutil"
)

// DefaultTimeout bounds each git call of a zero Runner.
const DefaultTimeout = 10 * time.Second

// Runner runs git. The zero value runs "git" from PATH with DefaultTimeout.
type Runner struct {
	Path    string        // the git program; "" is "git"
	Timeout time.Duration // for each call; 0 is DefaultTimeout
}

// Error is a git call that failed: git did not start, did not end in
// time, or exited with an error.
type Error struct {
	Args   []string // what followed "git -c ... -c ..."
	Stderr string
	Err    error
}

func (e *Error) Error() string {
	msg := strings.TrimSpace(e.Stderr)
	if msg == "" {
		msg = e.Err.Error()
	}
	return "git " + strings.Join(e.Args, " ") + ": " + msg
}

func (e *Error) Unwrap() error { return e.Err }

// NameError is a branch or base name git would not take, or that would
// read as an option.
type NameError struct{ Name string }

func (e *NameError) Error() string { return fmt.Sprintf("bad branch or base name %q", e.Name) }

const maxStderr = 8 << 10

// maxNewFiles bounds the untracked files one diff shows.
const maxNewFiles = 100

func (g Runner) program() string {
	if g.Path == "" {
		return "git"
	}
	return g.Path
}

func (g Runner) timeout() time.Duration {
	if g.Timeout <= 0 {
		return DefaultTimeout
	}
	return g.Timeout
}

// gitEnv is the environment of every git call. It leaves out what would
// point git at another repository than its directory, as a git hook that
// started Mori would have set, or make it read names as patterns; and it
// keeps git from asking for passwords, taking locks it can do without and
// reading a file name as a pattern.
func gitEnv() []string {
	env := procutil.WithoutEnv(os.Environ(),
		"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
		"GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS")
	return append(env, "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "GIT_LITERAL_PATHSPECS=1")
}

// output runs git in dir and returns what it printed. With limit > 0 it
// keeps that many bytes and stops git there, and truncated says so; git
// dying of the closed pipe is then no error.
func (g Runner) output(ctx context.Context, dir string, limit int, args ...string) (out []byte, truncated bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, g.timeout())
	defer cancel()
	cmd := exec.CommandContext(ctx, g.program(), append([]string{"-c", "core.quotepath=off", "-c", "color.ui=false"}, args...)...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	procutil.HideWindow(cmd)
	stdout := &capped{max: limit}
	stderr := &capped{max: maxStderr, quiet: true}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err = cmd.Run()
	if stdout.truncated {
		return stdout.buf.Bytes(), true, nil
	}
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err() // the kill was ours
		}
		return stdout.buf.Bytes(), false, &Error{Args: args, Stderr: stderr.buf.String(), Err: err}
	}
	return stdout.buf.Bytes(), false, nil
}

func (g Runner) run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	out, _, err := g.output(ctx, dir, 0, args...)
	return out, err
}

// capped keeps the first max bytes written to it, all of them when max is
// 0. Past max a write fails, which stops git at a closed pipe, or with
// quiet the rest is dropped.
type capped struct {
	buf       bytes.Buffer
	max       int
	quiet     bool
	truncated bool
}

var errCapped = errors.New("gitx: output limit reached")

func (c *capped) Write(p []byte) (int, error) {
	room := c.max - c.buf.Len()
	if c.max <= 0 || len(p) <= room {
		return c.buf.Write(p)
	}
	c.buf.Write(p[:room])
	c.truncated = true
	if c.quiet {
		return len(p), nil
	}
	return room, errCapped
}

func exitCode(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}

// Status is git status of the worktree at dir.
func (g Runner) Status(ctx context.Context, dir string) (Status, error) {
	out, err := g.run(ctx, dir, "status", "--porcelain=v2", "--branch", "-z")
	if err != nil {
		return Status{}, err
	}
	return ParseStatus(out)
}

// Worktrees lists the worktrees of the repository at dir, the main one
// first.
func (g Runner) Worktrees(ctx context.Context, dir string) ([]Worktree, error) {
	out, err := g.run(ctx, dir, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		// git before 2.36 has no -z; if that was not it, this fails the same.
		if out, err = g.run(ctx, dir, "worktree", "list", "--porcelain"); err != nil {
			return nil, err
		}
	}
	return ParseWorktrees(out)
}

// Branches lists the local and remote branches of the repository at dir.
func (g Runner) Branches(ctx context.Context, dir string) (Branches, error) {
	out, err := g.run(ctx, dir, "for-each-ref", branchFormat, "refs/heads", "refs/remotes")
	if err != nil {
		return Branches{}, err
	}
	return ParseBranches(out)
}

// Diff is the diff of file in the worktree at dir, or of every tracked
// file when file is "": of the index against HEAD when staged, else of
// the worktree against the index. Unstaged, the untracked files at file
// show as new ones, up to maxNewFiles. It keeps limit bytes when limit >
// 0, cut back to a whole line, and truncated says so.
func (g Runner) Diff(ctx context.Context, dir, file string, staged bool, limit int) (diff string, truncated bool, err error) {
	args := []string{"diff", "--no-color", "--no-ext-diff"}
	if staged {
		args = append(args, "--cached")
	}
	if file != "" {
		args = append(args, "--", file)
	}
	out, truncated, err := g.output(ctx, dir, limit, args...)
	if err != nil {
		return "", false, err
	}
	if staged || file == "" || truncated {
		return string(wholeLines(out, truncated)), truncated, nil
	}
	news, err := g.untracked(ctx, dir, file)
	if err != nil {
		return "", false, err
	}
	b := bytes.NewBuffer(out)
	for i, f := range news {
		room := 0
		if limit > 0 {
			room = limit - b.Len()
		}
		if i == maxNewFiles || limit > 0 && room <= 0 {
			truncated = true
			break
		}
		// diff --no-index takes /dev/null for nothing on every system, and
		// exits with 1 when the files differ.
		d, cut, err := g.output(ctx, dir, room, "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", f)
		if err != nil && exitCode(err) != 1 {
			return "", false, err
		}
		b.Write(d)
		if cut {
			truncated = true
			break
		}
	}
	return string(wholeLines(b.Bytes(), truncated)), truncated, nil
}

// untracked lists the untracked files at file, which may be a directory.
func (g Runner) untracked(ctx context.Context, dir, file string) ([]string, error) {
	out, err := g.run(ctx, dir, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--", file)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, f := range strings.Split(string(out), "\x00") {
		if p, ok := strings.CutPrefix(f, "? "); ok {
			files = append(files, p)
		}
	}
	return files, nil
}

// wholeLines cuts a cut diff back to its last whole line.
func wholeLines(b []byte, truncated bool) []byte {
	if truncated {
		if i := bytes.LastIndexByte(b, '\n'); i >= 0 {
			return b[:i+1]
		}
	}
	return b
}

// checkName refuses a name that would read as an option, or that git
// would not take for a branch.
func (g Runner) checkName(ctx context.Context, dir, name string) error {
	if name == "" || strings.HasPrefix(name, "-") {
		return &NameError{Name: name}
	}
	_, err := g.run(ctx, dir, "check-ref-format", "--branch", name)
	if exitCode(err) > 0 {
		return &NameError{Name: name}
	}
	return err
}

// AddWorktree adds a worktree of repo at path: on a new branch from base
// (HEAD when "") when create, else on the existing branch.
func (g Runner) AddWorktree(ctx context.Context, repo, path, branch string, create bool, base string) error {
	if err := g.checkName(ctx, repo, branch); err != nil {
		return err
	}
	if strings.HasPrefix(base, "-") {
		return &NameError{Name: base}
	}
	args := []string{"worktree", "add"}
	if create {
		args = append(args, "-b", branch, "--", path)
		if base != "" {
			args = append(args, base)
		}
	} else {
		args = append(args, "--", path, branch)
	}
	_, err := g.run(ctx, repo, args...)
	return err
}

// RemoveWorktree removes the worktree at path from repo. git refuses one
// with changes unless force, and a locked one always. The <name>.wt
// directory goes with its last worktree.
func (g Runner) RemoveWorktree(ctx context.Context, repo, path string, force bool) error {
	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	if _, err := g.run(ctx, repo, append(args, "--", path)...); err != nil {
		return err
	}
	if parent := filepath.Dir(path); strings.HasSuffix(parent, ".wt") {
		os.Remove(parent) // fails, as it should, while it holds anything
	}
	return nil
}
