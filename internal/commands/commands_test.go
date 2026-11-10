package commands

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestFrontmatter(t *testing.T) {
	for _, tc := range []struct {
		name, text string
		meta       map[string]string
		body       string
	}{
		{"no header", "# Title\nbody", map[string]string{}, "# Title\nbody"},
		{"a header that does not close", "---\ndescription: x\nbody", map[string]string{}, "---\ndescription: x\nbody"},
		{"plain", "---\ndescription: Says hi # to you\nargument-hint: [name]\n---\nbody\n",
			map[string]string{"description": "Says hi", "argument-hint": "[name]"}, "body\n"},
		{"a mark and Windows lines", "\ufeff---\r\nname: x\r\n---  \r\nbody", map[string]string{"name": "x"}, "body"},
		{"quoted", "---\na: \"say \\\"hi\\\"\\tnow\"\nb: 'it''s'\nc: \"x\" # note\nd: \"open\n---\n",
			map[string]string{"a": "say \"hi\"\tnow", "b": "it's", "c": "x", "d": "open"}, ""},
		{"blocks", "---\nfolded: >\n  one\n  two\n\n  three\nliteral: |-\n  one\n  two\nnext: z\n---\n",
			map[string]string{"folded": "one two three", "literal": "one\ntwo", "next": "z"}, ""},
		{"lines under the key", "---\nargument-hint:\n  - pr\n  - \"level\"\nmetadata:\n  type: x\ndescription: long\n  and longer\n---\n",
			map[string]string{"argument-hint": "pr level", "metadata": "type: x", "description": "long and longer"}, ""},
		{"comments and an empty header", "---\n# a comment\n---\nbody", map[string]string{}, "body"},
	} {
		meta, body := frontmatter(tc.text)
		if !reflect.DeepEqual(meta, tc.meta) || body != tc.body {
			t.Errorf("%s: got %q, %q; want %q, %q", tc.name, meta, body, tc.meta, tc.body)
		}
	}
}

func TestDescribe(t *testing.T) {
	if got := describe(map[string]string{}, "\n\n## Tidy   the\tcode\nmore"); got != "Tidy the code" {
		t.Errorf("first line: %q", got)
	}
	if got := describe(map[string]string{"description": "Said"}, "Body"); got != "Said" {
		t.Errorf("description: %q", got)
	}
	long := oneLine(strings.Repeat("가", 300))
	if n := len([]rune(long)); n != maxDesc || !strings.HasSuffix(long, "…") {
		t.Errorf("long: %d runes, %q", n, long[len(long)-6:])
	}
	for v, want := range map[string]bool{"false": true, "No": true, " off ": true, "true": false, "": false} {
		if falsy(v) != want {
			t.Errorf("falsy(%q) = %v", v, !want)
		}
	}
}

// write puts files under root: a path and its text.
func write(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for p, text := range files {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func skill(name, more string) string {
	return "---\nname: " + name + "\n" + more + "---\n# " + name + " skill\n"
}

func TestCollect(t *testing.T) {
	tmp := t.TempDir()
	config, repo, plugs := filepath.Join(tmp, "config"), filepath.Join(tmp, "repo"), filepath.Join(tmp, "plugs")
	cwd := filepath.Join(repo, "sub")
	write(t, config, map[string]string{
		"commands/hi.md":                       "---\ndescription: Say hi\nargument-hint: [name]\n---\n",
		"commands/git/push.md":                 "Push the branch\n",
		"commands/deep/a/b/c/four.md":          "four levels down",
		"commands/deep/a/b/c/d/five.md":        "too deep",
		"commands/.draft.md":                   "hidden",
		"commands/notes.txt":                   "not a command",
		"commands/two words.md":                "cannot follow a slash",
		"commands/tidy-up.md":                  "a command the skill of its name beats",
		"skills/tidy/SKILL.md":                 skill("tidy-up", "argument-hint: [path]\n"),
		"skills/secret/SKILL.md":               skill("secret", "user-invocable: false\n"),
		"skills/offme/SKILL.md":                skill("offme", ""),
		"skills/synced/b1/docx/SKILL.md":       skill("docx", "description: \"Word files\"\n"),
		"skills/synced/b1/tidy/SKILL.md":       skill("tidy-up", "description: under the user's own\n"),
		"skills/synced/b1/.staging/x/SKILL.md": skill("staged", ""),
		"skills/synced/b1/manifest.json":       "{}",
		"settings.json": `{"skillOverrides": {"offme": "off", "Kit:gone": "off"},
			"enabledPlugins": {"kit@m": true, "off@m": false, "late@m": true, "local@m": true, "gone@m": true}}`,
		"plugins/installed_plugins.json": asJSON(t, map[string]any{"version": 2, "plugins": map[string]any{
			"kit@m":   []map[string]any{{"scope": "user", "installPath": filepath.Join(plugs, "kit")}},
			"off@m":   []map[string]any{{"scope": "user", "installPath": filepath.Join(plugs, "off")}},
			"late@m":  []map[string]any{{"scope": "user", "installPath": filepath.Join(plugs, "late")}},
			"proj@m":  []map[string]any{{"scope": "project", "projectPath": repo, "installPath": filepath.Join(plugs, "proj")}},
			"local@m": []map[string]any{{"scope": "local", "projectPath": filepath.Join(tmp, "elsewhere"), "installPath": filepath.Join(plugs, "local")}},
			"gone@m":  []map[string]any{{"scope": "user", "installPath": filepath.Join(plugs, "missing")}},
		}}),
	})
	write(t, repo, map[string]string{
		".git/HEAD":                       "ref: refs/heads/main\n",
		".claude/commands/build.md":       "Build from the root",
		".claude/commands/hi.md":          "the user's hi beats this one",
		".claude/commands/review.md":      "Our own review",
		".claude/skills/compact/SKILL.md": skill("compact", "description: Our compact\n"),
		".claude/settings.json":           `{"enabledPlugins": {"proj@m": true}}`,
		".claude/settings.local.json":     `{"enabledPlugins": {"late@m": false}}`,
		"sub/.claude/commands/build.md":   "Build from here",
	})
	write(t, plugs, map[string]string{
		"kit/.claude-plugin/plugin.json": `{"name": "Kit", "commands": ["./extra", "./single.md", 7]}`,
		"kit/commands/deploy.md":         "---\ndescription: Ship it\n---\n",
		"kit/commands/tasks/plan.md":     "Plan a task",
		"kit/extra/more.md":              "More",
		"kit/single.md":                  "One file",
		"kit/skills/lint/SKILL.md":       skill("lint", ""),
		"kit/skills/gone/SKILL.md":       skill("gone", ""),
		"off/commands/no.md":             "off",
		"late/commands/no.md":            "turned off by the project",
		"proj/commands/p.md":             "the project's plugin",
		"local/commands/no.md":           "another project's",
	})

	got, partial := collect(context.Background(), config, cwd)
	if partial {
		t.Error("partial")
	}
	byName := map[string]Command{}
	var names []string
	for _, c := range got {
		byName[c.Name] = c
		if c.Source != SourceBuiltin {
			names = append(names, c.Name)
		}
	}
	want := []string{
		"build", "review", // the project's
		"deep:a:b:c:four", "git:push", "hi", // the user's
		"compact", "docx", "tidy-up", // skills
		"Kit:deploy", "Kit:lint", "Kit:more", "Kit:single", "Kit:tasks:plan", "proj:p", // plugins
	}
	if !slices.Equal(names, want) {
		t.Errorf("names:\n got %q\nwant %q", names, want)
	}
	for name, c := range map[string]Command{
		"hi":         {Name: "hi", Desc: "Say hi", Hint: "[name]", Source: SourceUser},
		"build":      {Name: "build", Desc: "Build from here", Source: SourceProject},
		"tidy-up":    {Name: "tidy-up", Desc: "tidy-up skill", Hint: "[path]", Source: SourceUser, Skill: true},
		"docx":       {Name: "docx", Desc: "Word files", Source: SourceUser, Skill: true},
		"compact":    {Name: "compact", Desc: "Our compact", Source: SourceProject, Skill: true},
		"Kit:deploy": {Name: "Kit:deploy", Desc: "Ship it", Source: SourcePlugin},
		"Kit:lint":   {Name: "Kit:lint", Desc: "lint skill", Source: SourcePlugin, Skill: true},
	} {
		if !reflect.DeepEqual(byName[name], c) {
			t.Errorf("%s: got %+v, want %+v", name, byName[name], c)
		}
	}
	// A built-in comes first; one of a name taken goes, and so does an alias.
	if got[0].Source != SourceBuiltin || got[0].Name != "add-dir" {
		t.Errorf("first: %+v", got[0])
	}
	if cr := byName["code-review"]; cr.Source != SourceBuiltin || len(cr.Aliases) != 0 {
		t.Errorf("code-review keeps the alias the project's review took: %+v", cr)
	}
	if c := byName["clear"]; !slices.Equal(c.Aliases, []string{"reset", "new"}) {
		t.Errorf("clear: %+v", c)
	}
	if !slices.IsSortedFunc(got, func(a, b Command) int { return group(a) - group(b) }) {
		t.Error("not in groups")
	}
	// the built-in list itself is left as it was
	if i := slices.IndexFunc(builtins, func(c Command) bool { return c.Name == "code-review" }); !slices.Equal(builtins[i].Aliases, []string{"review"}) {
		t.Errorf("builtins changed: %+v", builtins[i])
	}
}

func TestCollectOutsideARepository(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, map[string]string{"a/.claude/commands/up.md": "above", "a/b/.claude/commands/here.md": "here"})
	r := &reader{ctx: context.Background(), left: maxFiles}
	cwd := filepath.Join(dir, "a", "b")
	if roots := r.roots(cwd); !slices.Equal(roots, []string{cwd}) {
		t.Fatalf("roots %q", roots)
	}
	got, _ := collect(context.Background(), "", cwd)
	if !slices.ContainsFunc(got, func(c Command) bool { return c.Name == "here" }) ||
		slices.ContainsFunc(got, func(c Command) bool { return c.Name == "up" }) {
		t.Errorf("got %v", got)
	}
}

func TestCollectStopsInTime(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, map[string]string{".claude/commands/x.md": "x"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, partial := collect(ctx, "", dir)
	if !partial || len(got) != len(builtins) {
		t.Errorf("partial %v, %d commands", partial, len(got))
	}
}

// fakeLister lists with collect, counting the reads, at a clock that moves
// when the test says.
func fakeLister(collect func(cwd string) ([]Command, bool)) (l *Lister, reads *atomic.Int32, advance func(time.Duration)) {
	l = New("")
	reads = new(atomic.Int32)
	var mu sync.Mutex
	clock := time.Unix(1000, 0)
	l.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return clock
	}
	l.collect = func(_ context.Context, cwd string) ([]Command, bool) {
		reads.Add(1)
		return collect(cwd)
	}
	return l, reads, func(d time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		clock = clock.Add(d)
	}
}

func TestListerKeepsAList(t *testing.T) {
	one := []Command{{Name: "one", Source: SourceUser}}
	l, reads, advance := fakeLister(func(string) ([]Command, bool) { return one, false })
	ctx := context.Background()
	for range 3 {
		if got := l.List(ctx, "/p/"); got.Partial || !slices.Equal(names(got), []string{"one"}) {
			t.Fatalf("got %+v", got)
		}
	}
	if reads.Load() != 1 {
		t.Errorf("%d reads, want 1", reads.Load())
	}
	advance(time.Minute)
	l.List(ctx, "/p")
	if reads.Load() != 2 {
		t.Errorf("%d reads after a minute, want 2", reads.Load())
	}
}

func TestListerDoesNotKeepAPartialList(t *testing.T) {
	l, reads, _ := fakeLister(func(string) ([]Command, bool) { return []Command{{Name: "some"}}, true })
	for range 2 {
		if got := l.List(context.Background(), "/p"); !got.Partial {
			t.Fatalf("got %+v", got)
		}
	}
	if reads.Load() != 2 {
		t.Errorf("%d reads, want 2", reads.Load())
	}
}

func TestListerWaitsAWhile(t *testing.T) {
	release := make(chan struct{})
	l, reads, advance := fakeLister(func(cwd string) ([]Command, bool) {
		<-release
		return []Command{{Name: "slow"}}, false
	})
	l.wait = 20 * time.Millisecond
	ctx := context.Background()

	// Requests that come during a read share it, and get the built-ins alone.
	var wg sync.WaitGroup
	for range 3 {
		wg.Go(func() {
			if got := l.List(ctx, "/p"); !got.Partial || len(got.Commands) != len(builtins) {
				t.Errorf("got %d, partial %v", len(got.Commands), got.Partial)
			}
		})
	}
	wg.Wait()
	close(release)
	l.wait = time.Minute
	if got := l.List(ctx, "/p"); !slices.Equal(names(got), []string{"slow"}) {
		t.Errorf("after the read: %+v", got)
	}
	if reads.Load() != 1 {
		t.Errorf("%d reads, want 1", reads.Load())
	}

	// A list from before beats the built-ins while a new read is slow.
	stuck := make(chan struct{})
	defer close(stuck)
	l.collect = func(context.Context, string) ([]Command, bool) { <-stuck; return nil, false }
	l.wait = 20 * time.Millisecond
	advance(time.Hour)
	if got := l.List(ctx, "/p"); !slices.Equal(names(got), []string{"slow"}) || got.Partial {
		t.Errorf("stale: %+v", got)
	}

	// A request that ends stops waiting.
	gone, cancel := context.WithCancel(ctx)
	cancel()
	l.wait = time.Minute
	start := time.Now()
	if got := l.List(gone, "/q"); !got.Partial || time.Since(start) > 5*time.Second {
		t.Errorf("gone: partial %v after %v", got.Partial, time.Since(start))
	}
}

func TestListerSurvivesAPanic(t *testing.T) {
	l, _, _ := fakeLister(func(string) ([]Command, bool) { panic("a file no one foresaw") })
	if got := l.List(context.Background(), "/p"); !got.Partial || len(got.Commands) != len(builtins) {
		t.Errorf("got %d, partial %v", len(got.Commands), got.Partial)
	}
}

func TestListerKeepsFiftyFolders(t *testing.T) {
	l, _, advance := fakeLister(func(cwd string) ([]Command, bool) { return []Command{{Name: cwd}}, false })
	for i := range maxCached + 5 {
		advance(time.Millisecond)
		l.List(context.Background(), "/p/"+strings.Repeat("x", i+1))
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.cache) != maxCached {
		t.Errorf("%d kept", len(l.cache))
	}
	if _, ok := l.cache["/p/x"]; ok {
		t.Error("the oldest is kept")
	}
}

func TestBuiltins(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range builtins {
		for _, n := range append([]string{c.Name}, c.Aliases...) {
			if seen[n] || !usable(n) {
				t.Errorf("%q twice or not a name", n)
			}
			seen[n] = true
		}
		if c.Desc == "" || c.Source != SourceBuiltin {
			t.Errorf("%+v", c)
		}
	}
	b := Builtins()
	b[0].Name = "changed"
	if builtins[0].Name == "changed" {
		t.Error("Builtins hands out the list itself")
	}
}

func TestConfigDir(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", "/somewhere/claude")
	if got := ConfigDir(); got != "/somewhere/claude" {
		t.Errorf("got %q", got)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("HOME", "/home/me")
	if got := ConfigDir(); got != "/home/me/.claude" {
		t.Errorf("got %q", got)
	}
}

func names(l List) []string {
	var out []string
	for _, c := range l.Commands {
		out = append(out, c.Name)
	}
	return out
}
