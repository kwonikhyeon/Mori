package gitx

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Change is one entry of git status.
type Change struct {
	Path     string `json:"path"`
	Orig     string `json:"orig,omitempty"` // the path before a rename
	Index    string `json:"index"`          // X of XY, "." when unchanged
	Worktree string `json:"worktree"`       // Y of XY
	Kind     string `json:"kind"`           // changed, renamed, unmerged or untracked
}

// Status is what git status says of a worktree.
type Status struct {
	Head     string   `json:"head"`   // "" before the first commit
	Branch   string   `json:"branch"` // "" when detached
	Detached bool     `json:"detached"`
	Upstream string   `json:"upstream"`
	Ahead    int      `json:"ahead"`
	Behind   int      `json:"behind"`
	Changes  []Change `json:"changes"`
}

// Worktree is one entry of git worktree list. Path is in the host's form.
type Worktree struct {
	Path     string `json:"path"`
	Head     string `json:"head"`
	Branch   string `json:"branch"` // without refs/heads/, "" when detached
	Main     bool   `json:"main"`
	Bare     bool   `json:"bare"`
	Detached bool   `json:"detached"`
	Locked   bool   `json:"locked"`
	Prunable bool   `json:"prunable"`
}

// Branch is a local branch, or a remote one named like "origin/main".
type Branch struct {
	Name     string `json:"name"`
	Head     string `json:"head"`
	Upstream string `json:"upstream,omitempty"`
	Current  bool   `json:"current"` // checked out where git ran
	Remote   bool   `json:"remote"`
}

type Branches struct {
	Local  []Branch `json:"local"`
	Remote []Branch `json:"remote"`
}

func badEntry(what, entry string) error {
	return fmt.Errorf("git %s: unexpected entry %q", what, entry)
}

// ParseStatus reads git status --porcelain=v2 --branch -z: NUL-ended
// entries, a rename taking the next one for the path it had.
func ParseStatus(b []byte) (Status, error) {
	st := Status{Changes: []Change{}}
	fields := strings.Split(string(b), "\x00")
	for i := 0; i < len(fields); i++ {
		f := fields[i]
		if f == "" {
			continue
		}
		var c Change
		switch f[0] {
		case '#':
			if err := st.header(f); err != nil {
				return Status{}, err
			}
			continue
		case '1': // 1 XY sub mH mI mW hH hI path
			p := strings.SplitN(f, " ", 9)
			if len(p) != 9 || len(p[1]) != 2 {
				return Status{}, badEntry("status", f)
			}
			c = Change{Path: p[8], Index: p[1][:1], Worktree: p[1][1:], Kind: "changed"}
		case '2': // 2 XY sub mH mI mW hH hI Xscore path, then the old path
			p := strings.SplitN(f, " ", 10)
			if len(p) != 10 || len(p[1]) != 2 || i+1 == len(fields) || fields[i+1] == "" {
				return Status{}, badEntry("status", f)
			}
			i++
			c = Change{Path: p[9], Orig: fields[i], Index: p[1][:1], Worktree: p[1][1:], Kind: "renamed"}
		case 'u': // u XY sub m1 m2 m3 mW h1 h2 h3 path
			p := strings.SplitN(f, " ", 11)
			if len(p) != 11 || len(p[1]) != 2 {
				return Status{}, badEntry("status", f)
			}
			c = Change{Path: p[10], Index: p[1][:1], Worktree: p[1][1:], Kind: "unmerged"}
		case '?':
			path, ok := strings.CutPrefix(f, "? ")
			if !ok || path == "" {
				return Status{}, badEntry("status", f)
			}
			c = Change{Path: path, Index: "?", Worktree: "?", Kind: "untracked"}
		case '!': // ignored, listed only with --ignored
			continue
		default:
			return Status{}, badEntry("status", f)
		}
		st.Changes = append(st.Changes, c)
	}
	return st, nil
}

func (st *Status) header(f string) error {
	key, val, _ := strings.Cut(strings.TrimPrefix(f, "# "), " ")
	switch key {
	case "branch.oid":
		if val != "(initial)" {
			st.Head = val
		}
	case "branch.head":
		if val == "(detached)" {
			st.Detached = true
		} else {
			st.Branch = val
		}
	case "branch.upstream":
		st.Upstream = val
	case "branch.ab": // +ahead -behind
		a, b, _ := strings.Cut(val, " ")
		ahead, err1 := strconv.Atoi(strings.TrimPrefix(a, "+"))
		behind, err2 := strconv.Atoi(strings.TrimPrefix(b, "-"))
		if err1 != nil || err2 != nil {
			return badEntry("status", f)
		}
		st.Ahead, st.Behind = ahead, behind
	}
	return nil
}

// ParseWorktrees reads git worktree list --porcelain: lines of an entry
// one after another, an empty one after each entry. The lines end in NUL
// with -z, and in newlines from git before 2.36, which has no -z. The
// first entry is the main worktree.
func ParseWorktrees(b []byte) ([]Worktree, error) {
	sep := "\x00"
	if bytes.IndexByte(b, 0) < 0 {
		sep = "\n"
	}
	ws := []Worktree{}
	cur := -1
	for _, line := range strings.Split(string(b), sep) {
		if line == "" {
			cur = -1
			continue
		}
		key, val, _ := strings.Cut(line, " ")
		if key == "worktree" {
			ws = append(ws, Worktree{Path: filepath.FromSlash(val), Main: len(ws) == 0})
			cur = len(ws) - 1
			continue
		}
		if cur < 0 {
			return nil, badEntry("worktree list", line)
		}
		w := &ws[cur]
		switch key {
		case "HEAD":
			w.Head = val
		case "branch":
			w.Branch = strings.TrimPrefix(val, "refs/heads/")
		case "detached":
			w.Detached = true
		case "bare":
			w.Bare = true
		case "locked":
			w.Locked = true
		case "prunable":
			w.Prunable = true
		}
	}
	return ws, nil
}

// branchFormat is the for-each-ref format ParseBranches reads.
const branchFormat = "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)"

// ParseBranches reads git for-each-ref with branchFormat: a line a ref,
// its fields split by NUL. Remote HEADs are left out.
func ParseBranches(b []byte) (Branches, error) {
	bs := Branches{Local: []Branch{}, Remote: []Branch{}}
	for _, line := range strings.Split(string(b), "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\x00")
		if len(f) != 4 {
			return Branches{}, badEntry("for-each-ref", line)
		}
		if name, ok := strings.CutPrefix(f[0], "refs/heads/"); ok {
			bs.Local = append(bs.Local, Branch{Name: name, Head: f[1], Upstream: f[2], Current: f[3] == "*"})
		} else if name, ok := strings.CutPrefix(f[0], "refs/remotes/"); ok {
			if _, rest, _ := strings.Cut(name, "/"); rest != "HEAD" {
				bs.Remote = append(bs.Remote, Branch{Name: name, Head: f[1], Remote: true})
			}
		}
	}
	return bs, nil
}

// IsRepo reports whether dir is the top of a worktree: dir/.git is there,
// a directory in a main worktree and a file in a linked one.
func IsRepo(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// WorktreePath is where a new worktree of branch goes (spec §3 decision
// 15): <parent>/<name>.wt/<slug> beside the main worktree, or <slug>-2,
// -3 and so on when that is taken.
func WorktreePath(mainRoot, branch string) string {
	base := filepath.Join(filepath.Dir(mainRoot), filepath.Base(mainRoot)+".wt", BranchSlug(branch))
	p := base
	for n := 2; taken(p); n++ {
		p = base + "-" + strconv.Itoa(n)
	}
	return p
}

func taken(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// maxSlug keeps a long branch name from making a directory name the
// file system refuses.
const maxSlug = 64

// BranchSlug makes a directory name of a branch name: what is not
// [A-Za-z0-9._-] becomes -, runs of - become one, and - and . go from the
// ends. An empty result is "wt", and a name Windows keeps for a device,
// as aux is, gets "wt-" before it.
func BranchSlug(branch string) string {
	var b strings.Builder
	dash := false
	for _, r := range branch {
		if r == '-' || !slugRune(r) {
			if !dash {
				b.WriteByte('-')
			}
			dash = true
			continue
		}
		dash = false
		b.WriteRune(r)
	}
	s := b.String()
	if len(s) > maxSlug {
		s = s[:maxSlug]
	}
	s = strings.Trim(s, "-.")
	switch {
	case s == "":
		return "wt"
	case windowsDevice(s):
		return "wt-" + s
	}
	return s
}

func slugRune(r rune) bool {
	return r < utf8.RuneSelf && ('a' <= r && r <= 'z' || 'A' <= r && r <= 'Z' || '0' <= r && r <= '9' || r == '.' || r == '_')
}

// windowsDevice reports whether Windows takes name for a device, as it
// does CON, aux.txt or com1.
func windowsDevice(name string) bool {
	base, _, _ := strings.Cut(name, ".")
	switch u := strings.ToUpper(base); {
	case u == "CON" || u == "PRN" || u == "AUX" || u == "NUL":
		return true
	case len(u) == 4 && (u[:3] == "COM" || u[:3] == "LPT") && '0' <= u[3] && u[3] <= '9':
		return true
	}
	return false
}

// SafeRelPath reports whether file names a path in a worktree the way the
// API takes it: relative, not empty, with no .. in it and on no drive.
func SafeRelPath(file string) bool {
	if file == "" || strings.IndexByte(file, 0) >= 0 || filepath.IsAbs(file) || filepath.VolumeName(file) != "" {
		return false
	}
	f := strings.ReplaceAll(file, `\`, "/") // Windows takes either
	if f[0] == '/' || len(f) >= 2 && f[1] == ':' && ('a' <= f[0]|0x20 && f[0]|0x20 <= 'z') {
		return false
	}
	for _, part := range strings.Split(f, "/") {
		if part == ".." {
			return false
		}
	}
	return true
}
