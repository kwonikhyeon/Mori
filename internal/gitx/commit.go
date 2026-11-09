package gitx

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// CommitFile is a file a commit changed, against its first parent.
type CommitFile struct {
	Path    string `json:"path"`
	Orig    string `json:"orig,omitempty"` // the path before a rename or a copy
	Kind    string `json:"kind"`           // added, deleted, modified, renamed, copied or typechange
	Added   int    `json:"added"`          // lines; 0 for a binary file
	Deleted int    `json:"deleted"`
	Binary  bool   `json:"binary"`
}

// Commit is what a commit is: who wrote it and when, its message and the
// files it changed (spec §7.1).
type Commit struct {
	Hash           string       `json:"hash"`
	Parents        []string     `json:"parents"`
	Author         string       `json:"author"`
	Email          string       `json:"email"`
	AuthorMS       int64        `json:"author_ms"`
	Committer      string       `json:"committer"`
	CommitterEmail string       `json:"committer_email"`
	CommitMS       int64        `json:"commit_ms"`
	Message        string       `json:"message"`
	Files          []CommitFile `json:"files"`
	Truncated      bool         `json:"truncated"` // there are more files than Files
}

// ErrNoCommit is a hash that names no commit of the repository: no object
// at all, or a tree, a blob or a tag.
var ErrNoCommit = errors.New("gitx: no such commit")

// commitFormat prints nine fields; the message, last, may hold anything.
const commitFormat = "--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%cN%x00%cE%x00%ct%x00%B"

// maxCommitFiles bounds the files of a commit (spec §3 decision 110), and
// maxCommitOutput what git may print of them.
const (
	maxCommitFiles  = 3000
	maxCommitOutput = 16 << 20
)

// Commit is the commit rev, a full hash, of the repository at dir, with
// the files it changed against its first parent, or all of its files for
// a root commit (spec §3 decisions 109, 110). A rev that is not a full
// hash is a *NameError, and one that names no commit ErrNoCommit.
func (g Runner) Commit(ctx context.Context, dir, rev string) (Commit, error) {
	f, err := g.show(ctx, dir, rev, commitFormat, 9)
	if err != nil {
		return Commit{}, err
	}
	c := Commit{Hash: f[0], Parents: strings.Fields(f[1]), Author: f[2], Email: f[3], AuthorMS: unixMS(f[4]),
		Committer: f[5], CommitterEmail: f[6], CommitMS: unixMS(f[7]), Message: strings.TrimRight(f[8], "\n")}
	args := append([]string{"diff-tree", "-r", "-M", "--raw", "--numstat", "-z"}, against(c.Hash, c.Parents)...)
	out, cut, err := g.output(ctx, dir, maxCommitOutput, append(args, "--")...)
	if err != nil {
		return Commit{}, err
	}
	if c.Files, err = ParseCommitFiles(out, cut); err != nil {
		return Commit{}, err
	}
	c.Truncated = cut || len(c.Files) > maxCommitFiles
	c.Files = c.Files[:min(len(c.Files), maxCommitFiles)]
	return c, nil
}

// CommitDiff is the diff of the commit rev, a full hash, against its first
// parent, of paths or of all of it when there are none. A renamed file
// shows as a rename when paths holds both its paths. It keeps limit bytes
// when limit > 0, cut back to a whole line, and truncated says so.
func (g Runner) CommitDiff(ctx context.Context, dir, rev string, paths []string, limit int) (diff string, truncated bool, err error) {
	f, err := g.show(ctx, dir, rev, "--format=%H%x00%P", 2)
	if err != nil {
		return "", false, err
	}
	// diff-tree, unlike git diff, runs no external diff or textconv.
	args := append([]string{"diff-tree", "-r", "-p", "-M"}, against(f[0], strings.Fields(f[1]))...)
	out, truncated, err := g.output(ctx, dir, limit, append(append(args, "--"), paths...)...)
	if err != nil {
		return "", false, err
	}
	return string(wholeLines(out, truncated)), truncated, nil
}

// show reads the commit rev in format, of n NUL-separated fields of which
// the last may hold anything. git log shows a tree or a blob as nothing,
// and an annotated tag as the commit it is on.
func (g Runner) show(ctx context.Context, dir, rev, format string, n int) ([]string, error) {
	if !IsHash(rev) {
		return nil, &NameError{Name: rev}
	}
	out, err := g.run(ctx, dir, "log", "-1", "-z", "--no-color", "--no-show-signature", "--encoding=UTF-8", format, rev, "--")
	if err != nil {
		// With --quiet, rev-parse exits with 1 when no commit has the hash,
		// and with 128 when, say, dir is no repository.
		if _, e := g.run(ctx, dir, "rev-parse", "--verify", "--quiet", rev+"^{commit}"); exitCode(e) == 1 {
			return nil, ErrNoCommit
		}
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNoCommit
	}
	s, ok := strings.CutSuffix(string(out), "\x00")
	f := strings.SplitN(s, "\x00", n)
	if !ok || len(f) != n {
		return nil, badEntry("log", string(out))
	}
	if f[0] != rev {
		return nil, ErrNoCommit
	}
	return f, nil
}

// against is what diff-tree compares to show the change of the commit
// hash: its first parent and it, or for a root commit it alone.
func against(hash string, parents []string) []string {
	if len(parents) == 0 {
		return []string{"--root", "--no-commit-id", hash}
	}
	return []string{parents[0], hash}
}

// ParseCommitFiles reads git diff-tree -r --raw --numstat -z, which prints
// an entry for each file and then the counts of each file in the same
// order. When the output was cut short, it keeps the files whose counts
// came whole.
func ParseCommitFiles(b []byte, cut bool) ([]CommitFile, error) {
	files := []CommitFile{}
	f := strings.Split(string(b), "\x00")
	// After the last NUL comes nothing, or a field git was stopped in.
	if last := f[len(f)-1]; last != "" && !cut {
		return nil, badEntry("diff-tree", last)
	}
	f = f[:len(f)-1]
	i := 0
	for ; i < len(f) && strings.HasPrefix(f[i], ":"); i++ {
		// :<mode> <mode> <hash> <hash> <status>, then the path, or for a
		// rename or a copy the path before and after.
		h := strings.Fields(f[i][1:])
		if len(h) != 5 {
			return nil, badEntry("diff-tree", f[i])
		}
		paths := 1
		if h[4][0] == 'R' || h[4][0] == 'C' {
			paths = 2
		}
		if i+paths >= len(f) {
			if cut {
				return files[:0], nil
			}
			return nil, badEntry("diff-tree", f[i])
		}
		file := CommitFile{Path: f[i+paths], Kind: fileKind(h[4][0])}
		if paths == 2 {
			file.Orig = f[i+1]
		}
		files = append(files, file)
		i += paths
	}
	n := 0 // the files with their counts
	for ; n < len(files) && i < len(f); n++ {
		// <added>\t<deleted>\t<path>, or "-" for both of a binary file; a
		// rename has no path there, and its two paths follow.
		c := strings.SplitN(f[i], "\t", 3)
		if len(c) != 3 {
			return nil, badEntry("diff-tree", f[i])
		}
		orig, path, next := "", c[2], i+1
		if path == "" {
			if i+2 >= len(f) {
				if cut {
					break
				}
				return nil, badEntry("diff-tree", f[i])
			}
			orig, path, next = f[i+1], f[i+2], i+3
		}
		file := &files[n]
		if path != file.Path || orig != file.Orig {
			return nil, badEntry("diff-tree", f[i])
		}
		if c[0] == "-" && c[1] == "-" {
			file.Binary = true
		} else {
			added, err1 := strconv.Atoi(c[0])
			deleted, err2 := strconv.Atoi(c[1])
			if err1 != nil || err2 != nil {
				return nil, badEntry("diff-tree", f[i])
			}
			file.Added, file.Deleted = added, deleted
		}
		i = next
	}
	if !cut && (n < len(files) || i < len(f)) {
		return nil, fmt.Errorf("git diff-tree: counts for %d of %d files, %d fields left over", n, len(files), len(f)-i)
	}
	return files[:n], nil
}

func fileKind(status byte) string {
	switch status {
	case 'A':
		return "added"
	case 'D':
		return "deleted"
	case 'R':
		return "renamed"
	case 'C':
		return "copied"
	case 'T':
		return "typechange"
	}
	return "modified"
}
