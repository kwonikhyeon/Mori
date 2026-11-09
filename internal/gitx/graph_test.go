package gitx

import (
	"context"
	"fmt"
	"maps"
	"math/rand/v2"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// row writes a laid out commit as "hash lane.color up[..] pass[..] down[..]".
func row(c LogCommit) string {
	edges := func(es []Edge) string {
		s := make([]string, len(es))
		for i, e := range es {
			s[i] = fmt.Sprintf("%d.%d", e.Lane, e.Color)
		}
		return "[" + strings.Join(s, " ") + "]"
	}
	return fmt.Sprintf("%s %d.%d up%s pass%s down%s", c.Hash, c.Lane, c.Color, edges(c.Up), edges(c.Pass), edges(c.Down))
}

// history makes a log of lines of a hash and its parents, newest first.
func history(lines ...string) []LogCommit {
	cs := make([]LogCommit, len(lines))
	for i, l := range lines {
		f := strings.Fields(l)
		cs[i] = LogCommit{Hash: f[0], Parents: f[1:]}
	}
	return cs
}

// checkJoins checks what holds of every layout: the dot sits on the first
// lane coming into it and no line passes through it, a lane has one color
// in each half of a row, the width is the lanes used, and each row's pass
// and down lines go on as the next row's up and pass lines.
func checkJoins(t *testing.T, cs []LogCommit, width int) {
	t.Helper()
	set := func(ess ...[]Edge) map[Edge]bool {
		m := map[Edge]bool{}
		for _, es := range ess {
			for _, e := range es {
				m[e] = true
			}
		}
		return m
	}
	used := -1
	for i, c := range cs {
		if c.Up == nil || c.Pass == nil || c.Down == nil {
			t.Fatalf("row %d has a nil list: %+v", i, c)
		}
		if len(c.Up) > 0 && c.Up[0] != (Edge{c.Lane, c.Color}) || c.Lane < 0 {
			t.Fatalf("row %d: dot off its lane: %s", i, row(c))
		}
		used = max(used, c.Lane)
		for _, half := range []map[Edge]bool{set(c.Up, c.Pass), set(c.Pass, c.Down)} {
			seen := map[int]bool{}
			for e := range half {
				if seen[e.Lane] || e.Lane < 0 {
					t.Fatalf("row %d: lane %d twice in a half: %s", i, e.Lane, row(c))
				}
				seen[e.Lane] = true
				used = max(used, e.Lane)
			}
		}
		for _, e := range c.Pass {
			if e.Lane == c.Lane {
				t.Fatalf("row %d: a line passes through the dot: %s", i, row(c))
			}
		}
		if i+1 < len(cs) && !maps.Equal(set(c.Pass, c.Down), set(cs[i+1].Up, cs[i+1].Pass)) {
			t.Fatalf("rows %d and %d do not join:\n%s\n%s", i, i+1, row(c), row(cs[i+1]))
		}
	}
	if width != used+1 {
		t.Fatalf("width %d, lanes used %d", width, used+1)
	}
}

func TestLayout(t *testing.T) {
	for _, tc := range []struct {
		name  string
		log   []string
		rows  []string
		width int
	}{
		{"line", []string{"C B", "B A", "A"}, []string{
			"C 0.0 up[] pass[] down[0.0]",
			"B 0.0 up[0.0] pass[] down[0.0]",
			"A 0.0 up[0.0] pass[] down[]",
		}, 1},
		{"merge", []string{"M E F2", "E B", "F2 F1", "F1 B", "B A", "A"}, []string{
			"M 0.0 up[] pass[] down[0.0 1.1]",
			"E 0.0 up[0.0] pass[1.1] down[0.0]",
			"F2 1.1 up[1.1] pass[0.0] down[1.1]",
			"F1 1.1 up[1.1] pass[0.0] down[1.1]",
			"B 0.0 up[0.0 1.1] pass[] down[0.0]",
			"A 0.0 up[0.0] pass[] down[]",
		}, 2},
		{"two tips", []string{"X Y", "Z Y", "Y"}, []string{
			"X 0.0 up[] pass[] down[0.0]",
			"Z 1.1 up[] pass[0.0] down[1.1]",
			"Y 0.0 up[0.0 1.1] pass[] down[]",
		}, 2},
		{"free lane reused", []string{"a x", "b y", "c x", "y", "d x", "x"}, []string{
			"a 0.0 up[] pass[] down[0.0]",
			"b 1.1 up[] pass[0.0] down[1.1]",
			"c 2.2 up[] pass[0.0 1.1] down[2.2]",
			"y 1.1 up[1.1] pass[0.0 2.2] down[]",
			"d 1.3 up[] pass[0.0 2.2] down[1.3]",
			"x 0.0 up[0.0 1.3 2.2] pass[] down[]",
		}, 3},
		{"other parent already waited for", []string{"n b", "m a b", "a b", "b"}, []string{
			"n 0.0 up[] pass[] down[0.0]",
			"m 1.1 up[] pass[0.0] down[1.1 0.0]",
			"a 1.1 up[1.1] pass[0.0] down[1.1]",
			"b 0.0 up[0.0 1.1] pass[] down[]",
		}, 2},
		{"lane freed at the dot taken by the other parent", []string{"p x", "q x", "x r s", "r", "s"}, []string{
			"p 0.0 up[] pass[] down[0.0]",
			"q 1.1 up[] pass[0.0] down[1.1]",
			"x 0.0 up[0.0 1.1] pass[] down[0.0 1.2]",
			"r 0.0 up[0.0] pass[1.2] down[]",
			"s 1.2 up[1.2] pass[] down[]",
		}, 2},
		{"octopus", []string{"O P1 P2 P3", "P1 R", "P2 R", "P3 R", "R"}, []string{
			"O 0.0 up[] pass[] down[0.0 1.1 2.2]",
			"P1 0.0 up[0.0] pass[1.1 2.2] down[0.0]",
			"P2 1.1 up[1.1] pass[0.0 2.2] down[1.1]",
			"P3 2.2 up[2.2] pass[0.0 1.1] down[2.2]",
			"R 0.0 up[0.0 1.1 2.2] pass[] down[]",
		}, 3},
		{"unrelated root", []string{"a b c", "c", "b", "z"}, []string{
			"a 0.0 up[] pass[] down[0.0 1.1]",
			"c 1.1 up[1.1] pass[0.0] down[]",
			"b 0.0 up[0.0] pass[] down[]",
			"z 0.2 up[] pass[] down[]",
		}, 2},
		{"parents past the end", []string{"T P Q"}, []string{
			"T 0.0 up[] pass[] down[0.0 1.1]",
		}, 2},
		{"same parent twice", []string{"D P P", "P"}, []string{
			"D 0.0 up[] pass[] down[0.0]",
			"P 0.0 up[0.0] pass[] down[]",
		}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cs := history(tc.log...)
			width := Layout(cs)
			var rows []string
			for _, c := range cs {
				rows = append(rows, row(c))
			}
			if !slices.Equal(rows, tc.rows) || width != tc.width {
				t.Fatalf("width %d\n got %q\nwant %q", width, rows, tc.rows)
			}
			checkJoins(t, cs, width)
		})
	}
	if w := Layout(nil); w != 0 {
		t.Fatalf("empty log: width %d", w)
	}
}

func TestLayoutJoinsOnAnyLog(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 106))
	for range 300 {
		cs := make([]LogCommit, 1+r.IntN(40))
		for i := range cs {
			cs[i].Hash = fmt.Sprint("c", i)
			// Parents come later in the log, or past its end.
			for k := r.IntN(4); k > 0; k-- {
				cs[i].Parents = append(cs[i].Parents, fmt.Sprint("c", i+1+r.IntN(6)))
			}
		}
		checkJoins(t, cs, Layout(cs))
	}
}

func TestParseRefs(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want []Ref
	}{
		{"", []Ref{}},
		{"HEAD -> refs/heads/main, refs/heads/feat/x, refs/heads/a, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v2, tag: refs/tags/v10",
			[]Ref{{"main", "branch", true}, {"a", "branch", false}, {"feat/x", "branch", false}, {"origin/main", "remote", false}, {"v10", "tag", false}, {"v2", "tag", false}}},
		{"tag: refs/tags/v1, refs/heads/side, HEAD", []Ref{{"HEAD", "head", false}, {"side", "branch", false}, {"v1", "tag", false}}},
		{"refs/remotes/up/feat, grafted", []Ref{{"up/feat", "remote", false}}},
	} {
		if got := parseRefs(tc.in); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%q:\n got %+v\nwant %+v", tc.in, got, tc.want)
		}
	}
}

func TestParseLog(t *testing.T) {
	h1, h2, h3 := strings.Repeat("1", 40), strings.Repeat("2", 40), strings.Repeat("3", 64)
	rec := func(f ...string) string { return strings.Join(f, "\x00") + "\x00" }
	cs, err := ParseLog([]byte(rec(h1, h2+" "+h3, "몰이 테스터", "1700000000", "병합: feat", "HEAD -> refs/heads/main, tag: refs/tags/v1") +
		rec(h2, "", "mori", "", "", "")))
	if err != nil {
		t.Fatal(err)
	}
	want := []LogCommit{
		{Hash: h1, Parents: []string{h2, h3}, Author: "몰이 테스터", TimeMS: 1700000000000, Subject: "병합: feat", Refs: []Ref{{"main", "branch", true}, {"v1", "tag", false}}},
		{Hash: h2, Parents: []string{}, Author: "mori", Refs: []Ref{}}, // a time git could not read is 0
	}
	if !reflect.DeepEqual(cs, want) {
		t.Fatalf("\n got %+v\nwant %+v", cs, want)
	}
	if cs, err := ParseLog(nil); err != nil || cs == nil || len(cs) != 0 {
		t.Fatalf("empty: %v %v", cs, err)
	}
	for _, in := range []string{
		rec(h1, "", "a", "1", "s"),                                 // five fields
		strings.TrimSuffix(rec(h1, "", "a", "1", "s", ""), "\x00"), // not ended
		rec("HEAD", "", "a", "1", "s", ""),
		rec(h1, "main", "a", "1", "s", ""),
	} {
		if _, err := ParseLog([]byte(in)); err == nil {
			t.Errorf("%q: no error", in)
		}
	}
}

// graphRepo adds to newRepo's commit "init" on main: a branch feat of two
// commits, merged into main after a commit of main's own; a branch side
// from init; the tags v0 (annotated, on init), v1 (on the merge) and one
// on a blob; origin/main, with origin/HEAD pointing at it; and a stash.
// Its config then asks git log for another encoding, other decorations,
// colors and signatures. It returns the hashes by subject.
func graphRepo(t *testing.T) (string, map[string]string) {
	t.Helper()
	repo := newRepo(t)
	commit := func(file, s, msg string) {
		write(t, filepath.Join(repo, file), s)
		git(t, repo, "add", "--", file)
		git(t, repo, "commit", "-q", "-m", msg)
	}
	git(t, repo, "checkout", "-q", "-b", "feat")
	commit("f.txt", "1\n", "feat 1")
	commit("f.txt", "2\n", "feat 2")
	git(t, repo, "checkout", "-q", "main")
	commit("m.txt", "m\n", "main 1")
	git(t, repo, "merge", "-q", "--no-ff", "-m", "merge feat", "feat")
	git(t, repo, "checkout", "-q", "-b", "side", "main~2")
	commit("s.txt", "s\n", "옆 가지")
	git(t, repo, "checkout", "-q", "main")
	git(t, repo, "tag", "v1")
	git(t, repo, "tag", "-a", "-m", "v0", "v0", "main~2")
	git(t, repo, "tag", "blob", git(t, repo, "hash-object", "-w", "a.txt"))
	git(t, repo, "update-ref", "refs/remotes/origin/main", "main~1")
	git(t, repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
	write(t, filepath.Join(repo, "a.txt"), "stashed\n")
	git(t, repo, "stash", "-q")
	h := map[string]string{}
	for _, l := range strings.Split(git(t, repo, "log", "--branches", "--format=%H %s"), "\n") {
		hash, subject, _ := strings.Cut(l, " ")
		h[subject] = hash
	}
	for _, kv := range [][2]string{
		{"i18n.logOutputEncoding", "EUC-KR"},
		{"log.excludeDecoration", "refs/remotes/"},
		{"log.decorate", "short"},
		{"log.showSignature", "true"},
		{"color.ui", "always"},
	} {
		git(t, repo, "config", kv[0], kv[1])
	}
	return repo, h
}

func subjects(gr Graph) []string {
	var s []string
	for _, c := range gr.Commits {
		s = append(s, c.Subject)
	}
	return s
}

func TestLog(t *testing.T) {
	repo, h := graphRepo(t)
	ctx := context.Background()
	var g Runner

	gr, err := g.Log(ctx, repo, false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if gr.More || len(gr.Commits) != 6 {
		t.Fatalf("more %v: %q", gr.More, subjects(gr))
	}
	checkJoins(t, gr.Commits, gr.Width)
	at := map[string]int{}
	for i, c := range gr.Commits {
		at[c.Hash] = i
	}
	want := map[string][]Ref{
		"merge feat": {{"main", "branch", true}, {"v1", "tag", false}},
		"feat 2":     {{"feat", "branch", false}},
		"feat 1":     {},
		"main 1":     {{"origin/main", "remote", false}},
		"옆 가지":       {{"side", "branch", false}},
		"init":       {{"v0", "tag", false}},
	}
	for _, c := range gr.Commits {
		if !reflect.DeepEqual(c.Refs, want[c.Subject]) || c.Hash != h[c.Subject] || c.Author != "mori-test" || c.TimeMS <= 0 {
			t.Errorf("%+v", c)
		}
		for _, p := range c.Parents {
			if i, ok := at[p]; !ok || i <= at[c.Hash] {
				t.Errorf("parent %s of %q is not below it", p, c.Subject)
			}
		}
	}
	if m := gr.Commits[at[h["merge feat"]]]; !slices.Equal(m.Parents, []string{h["main 1"], h["feat 2"]}) {
		t.Errorf("merge parents %v", m.Parents)
	}

	gr, err = g.Log(ctx, repo, true, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := subjects(gr); len(got) != 5 || slices.Contains(got, "옆 가지") {
		t.Fatalf("HEAD only: %q", got)
	}
	checkJoins(t, gr.Commits, gr.Width)

	for limit, more := range map[int]bool{2: true, 5: true, 6: false, 7: false} {
		gr, err = g.Log(ctx, repo, false, limit)
		if err != nil || gr.More != more || len(gr.Commits) != min(limit, 6) {
			t.Fatalf("limit %d: %v more %v %q", limit, err, gr.More, subjects(gr))
		}
		checkJoins(t, gr.Commits, gr.Width)
	}
}

func TestLogShowsADetachedWorktreeOnlyFromIt(t *testing.T) {
	repo := newRepo(t)
	ctx := context.Background()
	var g Runner
	wt := filepath.Join(filepath.Dir(repo), "wt")
	git(t, repo, "worktree", "add", "-q", "--detach", wt)
	write(t, filepath.Join(wt, "w.txt"), "w\n")
	git(t, wt, "add", "w.txt")
	git(t, wt, "commit", "-q", "-m", "detached work")

	gr, err := g.Log(ctx, repo, false, 0)
	if err != nil || !slices.Equal(subjects(gr), []string{"init"}) || !reflect.DeepEqual(gr.Commits[0].Refs, []Ref{{"main", "branch", true}}) {
		t.Fatalf("%v %+v", err, gr)
	}
	gr, err = g.Log(ctx, wt, false, 0)
	if err != nil || !slices.Equal(subjects(gr), []string{"detached work", "init"}) {
		t.Fatalf("%v %+v", err, gr)
	}
	if got := [][]Ref{gr.Commits[0].Refs, gr.Commits[1].Refs}; !reflect.DeepEqual(got, [][]Ref{{{"HEAD", "head", false}}, {{"main", "branch", false}}}) {
		t.Fatalf("%+v", got)
	}
}

func TestLogOfEmptyRepoAndUnbornBranch(t *testing.T) {
	repo := newRepo(t)
	ctx := context.Background()
	var g Runner
	empty := filepath.Join(filepath.Dir(repo), "빈 저장소")
	git(t, filepath.Dir(repo), "init", "-q", "-b", "main", empty)
	for _, head := range []bool{false, true} {
		gr, err := g.Log(ctx, empty, head, 0)
		if err != nil || gr.Commits == nil || len(gr.Commits) != 0 || gr.Width != 0 || gr.More {
			t.Fatalf("head %v: %v %+v", head, err, gr)
		}
	}
	git(t, repo, "checkout", "-q", "--orphan", "fresh")
	gr, err := g.Log(ctx, repo, false, 0)
	if err != nil || !slices.Equal(subjects(gr), []string{"init"}) || !reflect.DeepEqual(gr.Commits[0].Refs, []Ref{{"main", "branch", false}}) {
		t.Fatalf("%v %+v", err, gr)
	}
	if gr, err = g.Log(ctx, repo, true, 0); err != nil || len(gr.Commits) != 0 {
		t.Fatalf("HEAD only: %v %+v", err, gr)
	}
}
