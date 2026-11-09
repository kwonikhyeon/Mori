package gitx

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// Ref is a name on a commit of the graph: a local branch, a remote one
// named like "origin/main", a tag, or HEAD when it is detached.
type Ref struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`    // head, branch, remote or tag
	Current bool   `json:"current"` // the branch HEAD points at
}

// Edge is a line of a graph row in a lane, colored by the line it is part
// of (spec §7.1).
type Edge struct {
	Lane  int `json:"lane"`
	Color int `json:"color"`
}

// LogCommit is a commit of the graph, a row of it. Its dot is in Lane.
// Up lines come down into the dot, Pass lines go by it, and Down lines
// leave it for its parents.
type LogCommit struct {
	Hash    string   `json:"hash"`
	Parents []string `json:"parents"`
	Author  string   `json:"author"`
	TimeMS  int64    `json:"time_ms"` // when it was written
	Subject string   `json:"subject"`
	Refs    []Ref    `json:"refs"`
	Lane    int      `json:"lane"`
	Color   int      `json:"color"`
	Up      []Edge   `json:"up"`
	Pass    []Edge   `json:"pass"`
	Down    []Edge   `json:"down"`
}

// Graph is the commit graph of a repository, newest first. Width is how
// many lanes it needs, and More says that it has more commits than it
// shows.
type Graph struct {
	Commits []LogCommit `json:"commits"`
	Width   int         `json:"width"`
	More    bool        `json:"more"`
}

// DefaultLogLimit and MaxLogLimit bound how many commits a graph shows
// (spec §3 decision 107).
const (
	DefaultLogLimit = 200
	MaxLogLimit     = 2000
)

// maxLogOutput bounds what git log may print for one graph.
const maxLogOutput = 16 << 20

// logFormat prints six fields for each commit; with -z each ends in a
// NUL.
const (
	logFormat = "--format=%H%x00%P%x00%aN%x00%at%x00%s%x00%D"
	logFields = 6
)

// Log is the graph of the commits of the repository at dir that its
// branches, remote branches, tags and HEAD reach, or HEAD alone when
// headOnly, newest first in --topo-order (spec §3 decisions 104 to 108,
// 111). It shows limit commits, DefaultLogLimit when limit <= 0, and a
// repository without commits has none, without an error.
func (g Runner) Log(ctx context.Context, dir string, headOnly bool, limit int) (Graph, error) {
	if limit <= 0 {
		limit = DefaultLogLimit
	}
	limit = min(limit, MaxLogLimit)
	args := []string{"log", "--topo-order", "-z", "--no-color", "--no-show-signature", "--encoding=UTF-8",
		"--decorate=full", "--decorate-refs=HEAD", "--decorate-refs=refs/heads/", "--decorate-refs=refs/remotes/", "--decorate-refs=refs/tags/",
		"--ignore-missing", "--max-count=" + strconv.Itoa(limit+1), logFormat}
	if !headOnly {
		args = append(args, "--branches", "--remotes", "--tags")
	}
	out, cut, err := g.output(ctx, dir, maxLogOutput, append(args, "HEAD", "--")...)
	if err != nil {
		return Graph{}, err
	}
	if cut {
		out = wholeRecords(out, logFields)
	}
	cs, err := ParseLog(out)
	if err != nil {
		return Graph{}, err
	}
	gr := Graph{More: cut}
	if len(cs) > limit {
		cs, gr.More = cs[:limit], true
	}
	gr.Width = Layout(cs)
	gr.Commits = cs
	return gr, nil
}

// wholeRecords cuts output that was cut short back to its last whole
// record of n NUL-ended fields.
func wholeRecords(b []byte, n int) []byte {
	end, nuls := 0, 0
	for i, c := range b {
		if c == 0 {
			if nuls++; nuls%n == 0 {
				end = i + 1
			}
		}
	}
	return b[:end]
}

// ParseLog reads git log -z in logFormat. A time git could not read, of a
// broken commit, is 0.
func ParseLog(b []byte) ([]LogCommit, error) {
	cs := []LogCommit{}
	if len(b) == 0 {
		return cs, nil
	}
	s, ok := strings.CutSuffix(string(b), "\x00")
	f := strings.Split(s, "\x00")
	if !ok || len(f)%logFields != 0 {
		return nil, fmt.Errorf("git log: output is not whole records of %d fields", logFields)
	}
	for i := 0; i < len(f); i += logFields {
		c := LogCommit{Hash: f[i], Parents: strings.Fields(f[i+1]), Author: f[i+2], TimeMS: unixMS(f[i+3]), Subject: f[i+4], Refs: parseRefs(f[i+5])}
		if !IsHash(c.Hash) || slices.ContainsFunc(c.Parents, func(p string) bool { return !IsHash(p) }) {
			return nil, badEntry("log", strings.Join(f[i:i+logFields], "\x00"))
		}
		cs = append(cs, c)
	}
	return cs, nil
}

// IsHash says whether s is a full commit hash as git prints it: 40 (SHA-1)
// or 64 (SHA-256) lowercase hex digits. Mori asks git about commits by
// their hashes alone, so a name like "main" or "HEAD~1", which the clients
// have no need for, never reaches git as a revision (spec §3 decision 109).
func IsHash(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for _, c := range []byte(s) {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// unixMS reads a time git printed in seconds as milliseconds, 0 when it
// is not a number.
func unixMS(s string) int64 {
	sec, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return sec * 1000
}

var refOrder = map[string]int{"head": 0, "branch": 1, "remote": 2, "tag": 3}

// parseRefs reads %D of git log --decorate=full, like "HEAD ->
// refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1", or
// "HEAD, ..." when HEAD is detached. It leaves out a remote's HEAD and
// what was not asked for, like "grafted".
func parseRefs(d string) []Ref {
	refs := []Ref{}
	if d == "" {
		return refs
	}
	for _, name := range strings.Split(d, ", ") {
		var r Ref
		if head, branch, ok := strings.Cut(name, " -> "); ok && head == "HEAD" {
			name, r.Current = branch, true
		}
		switch {
		case name == "HEAD":
			r.Name, r.Kind = name, "head"
		case strings.HasPrefix(name, "tag: refs/tags/"):
			r.Name, r.Kind = strings.TrimPrefix(name, "tag: refs/tags/"), "tag"
		case strings.HasPrefix(name, "refs/heads/"):
			r.Name, r.Kind = strings.TrimPrefix(name, "refs/heads/"), "branch"
		case strings.HasPrefix(name, "refs/remotes/") && !strings.HasSuffix(name, "/HEAD"):
			r.Name, r.Kind = strings.TrimPrefix(name, "refs/remotes/"), "remote"
		default:
			continue
		}
		refs = append(refs, r)
	}
	slices.SortFunc(refs, func(a, b Ref) int {
		if d := refOrder[a.Kind] - refOrder[b.Kind]; d != 0 {
			return d
		}
		if a.Current != b.Current {
			if a.Current {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Name, b.Name)
	})
	return refs
}

// Layout puts the commits of a log in --topo-order, newest first, in
// lanes, and returns how many lanes they take (spec §3 decision 106). A
// commit goes in the leftmost lane waiting for it, or when none is (the
// tip of a branch) in the leftmost free one with a new color. Its first
// parent goes on in its lane; another parent joins a lane waiting for it,
// or takes the leftmost free one with a new color. Lanes never move.
func Layout(cs []LogCommit) int {
	type track struct {
		want  string // the commit the lane waits for; "" when free
		color int
	}
	var lanes []track
	free := func() int {
		for l, t := range lanes {
			if t.want == "" {
				return l
			}
		}
		lanes = append(lanes, track{})
		return len(lanes) - 1
	}
	colors := 0
	for i := range cs {
		c := &cs[i]
		c.Lane, c.Up, c.Pass, c.Down = -1, []Edge{}, []Edge{}, []Edge{}
		for l, t := range lanes {
			switch {
			case t.want == c.Hash:
				c.Up = append(c.Up, Edge{l, t.color})
				if c.Lane < 0 {
					c.Lane, c.Color = l, t.color
				}
				lanes[l].want = ""
			case t.want != "":
				c.Pass = append(c.Pass, Edge{l, t.color})
			}
		}
		if c.Lane < 0 {
			c.Lane, c.Color = free(), colors
			colors++
		}
		for k, p := range c.Parents {
			e := Edge{c.Lane, c.Color}
			if k > 0 {
				if l := slices.IndexFunc(lanes, func(t track) bool { return t.want == p }); l >= 0 {
					e = Edge{l, lanes[l].color}
				} else {
					e = Edge{free(), colors}
					colors++
				}
			}
			lanes[e.Lane] = track{p, e.Color}
			if !slices.Contains(c.Down, e) {
				c.Down = append(c.Down, e)
			}
		}
	}
	// A lane is added for a dot or a line that takes it at once.
	return len(lanes)
}
