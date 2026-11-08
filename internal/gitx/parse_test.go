package gitx

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseStatus(t *testing.T) {
	in := strings.Join([]string{
		"# branch.oid 1111111111111111111111111111111111111111",
		"# branch.head main",
		"# branch.upstream origin/main",
		"# branch.ab +2 -1",
		"1 .M N... 100644 100644 100644 aaaa bbbb 문서/새 파일.md",
		"1 A. N... 000000 100644 100644 0000 cccc added.go",
		"2 R. N... 100644 100644 100644 dddd eeee R100 new name.go",
		"old name.go",
		"u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.txt",
		"? 추적 안 됨.txt",
		"",
	}, "\x00")
	st, err := ParseStatus([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	if st.Head == "" || st.Branch != "main" || st.Detached || st.Upstream != "origin/main" || st.Ahead != 2 || st.Behind != 1 {
		t.Fatalf("header: %+v", st)
	}
	want := []Change{
		{Path: "문서/새 파일.md", Index: ".", Worktree: "M", Kind: "changed"},
		{Path: "added.go", Index: "A", Worktree: ".", Kind: "changed"},
		{Path: "new name.go", Orig: "old name.go", Index: "R", Worktree: ".", Kind: "renamed"},
		{Path: "conflict.txt", Index: "U", Worktree: "U", Kind: "unmerged"},
		{Path: "추적 안 됨.txt", Index: "?", Worktree: "?", Kind: "untracked"},
	}
	if !reflect.DeepEqual(st.Changes, want) {
		t.Fatalf("changes:\n got %+v\nwant %+v", st.Changes, want)
	}
}

func TestParseStatusDetachedInitial(t *testing.T) {
	st, err := ParseStatus([]byte("# branch.oid (initial)\x00# branch.head (detached)\x00"))
	if err != nil {
		t.Fatal(err)
	}
	if !st.Detached || st.Branch != "" || st.Head != "" || st.Changes == nil || len(st.Changes) != 0 {
		t.Fatalf("%+v", st)
	}
}

func TestParseStatusRejectsBrokenEntries(t *testing.T) {
	for _, in := range []string{
		"1 .M N... 100644",                 // too few fields
		"2 R. N... 1 1 1 a b R100 only.go", // no original path after it
		"# branch.ab +x -1",
		"z what",
	} {
		if _, err := ParseStatus([]byte(in + "\x00")); err == nil {
			t.Errorf("%q: no error", in)
		}
	}
}

func TestParseWorktrees(t *testing.T) {
	for _, sep := range []string{"\x00", "\n"} { // -z, and git before 2.36
		in := strings.Join([]string{
			"worktree /r/app", "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/main", "",
			"worktree /r/app.wt/feat x", "HEAD 2222222222222222222222222222222222222222", "branch refs/heads/feat/x", "locked", "",
			"worktree /r/app.wt/old", "HEAD 3333333333333333333333333333333333333333", "detached",
			"prunable gitdir file points to non-existent location", "",
		}, sep)
		ws, err := ParseWorktrees([]byte(in))
		if err != nil {
			t.Fatal(err)
		}
		want := []Worktree{
			{Path: filepath.FromSlash("/r/app"), Head: "1111111111111111111111111111111111111111", Branch: "main", Main: true},
			{Path: filepath.FromSlash("/r/app.wt/feat x"), Head: "2222222222222222222222222222222222222222", Branch: "feat/x", Locked: true},
			{Path: filepath.FromSlash("/r/app.wt/old"), Head: "3333333333333333333333333333333333333333", Detached: true, Prunable: true},
		}
		if !reflect.DeepEqual(ws, want) {
			t.Fatalf("sep %q:\n got %+v\nwant %+v", sep, ws, want)
		}
	}
}

func TestParseWorktreesLockReasonWithNewline(t *testing.T) {
	ws, err := ParseWorktrees([]byte("worktree /r/app\x00bare\x00\x00worktree /r/w\x00HEAD 1\x00detached\x00locked line1\nline2\x00\x00"))
	if err != nil {
		t.Fatal(err)
	}
	if len(ws) != 2 || !ws[0].Bare || !ws[0].Main || !ws[1].Locked || ws[1].Path != filepath.FromSlash("/r/w") {
		t.Fatalf("%+v", ws)
	}
}

func TestParseBranches(t *testing.T) {
	in := strings.Join([]string{
		"refs/heads/feat/x\x00aaaa\x00origin/feat/x\x00 ",
		"refs/heads/main\x00bbbb\x00origin/main\x00*",
		"refs/remotes/origin/HEAD\x00bbbb\x00\x00 ",
		"refs/remotes/origin/main\x00bbbb\x00\x00 ",
		"",
	}, "\n")
	bs, err := ParseBranches([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	want := Branches{
		Local: []Branch{
			{Name: "feat/x", Head: "aaaa", Upstream: "origin/feat/x"},
			{Name: "main", Head: "bbbb", Upstream: "origin/main", Current: true},
		},
		Remote: []Branch{{Name: "origin/main", Head: "bbbb", Remote: true}},
	}
	if !reflect.DeepEqual(bs, want) {
		t.Fatalf("\n got %+v\nwant %+v", bs, want)
	}
	empty, err := ParseBranches(nil)
	if err != nil || empty.Local == nil || empty.Remote == nil {
		t.Fatalf("empty: %+v %v", empty, err)
	}
}

func TestBranchSlugAndPath(t *testing.T) {
	for in, want := range map[string]string{
		"feat/login": "feat-login",
		"fix//a b":   "fix-a-b",
		"-x-":        "x",
		"한글":         "wt",
		"..":         "wt",
		"v1.2":       "v1.2",
		"aux":        "wt-aux", // Windows device names cannot be directories
		"CON.txt":    "wt-CON.txt",
		"console":    "console",
	} {
		if got := BranchSlug(in); got != want {
			t.Errorf("BranchSlug(%q) = %q, want %q", in, got, want)
		}
	}
	if got := BranchSlug(strings.Repeat("a", 200)); len(got) > maxSlug {
		t.Errorf("long slug has %d bytes", len(got))
	}
	if got := WorktreePath(filepath.FromSlash("/r/app"), "feat/a"); got != filepath.FromSlash("/r/app.wt/feat-a") {
		t.Fatal(got)
	}
}

func TestWorktreePathSkipsTaken(t *testing.T) {
	root := filepath.Join(t.TempDir(), "app")
	taken := filepath.Join(filepath.Dir(root), "app.wt", "feat-a")
	if err := os.MkdirAll(taken, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := WorktreePath(root, "feat/a"); got != taken+"-2" {
		t.Fatal(got)
	}
	if err := os.MkdirAll(taken+"-2", 0o755); err != nil {
		t.Fatal(err)
	}
	if got := WorktreePath(root, "feat/a"); got != taken+"-3" {
		t.Fatal(got)
	}
}

func TestSafeRelPath(t *testing.T) {
	for in, want := range map[string]bool{
		"a/b.go":         true,
		"문서/새 파일.md":     true,
		"a..b/c":         true,
		"../x":           false,
		"/etc/passwd":    false,
		"a/../../x":      false,
		"a\\..\\..\\x":   false,
		"":               false,
		`C:\x`:           false,
		"c:x":            false,
		"\\\\srv\\share": false,
		"a\x00b":         false,
	} {
		if got := SafeRelPath(in); got != want {
			t.Errorf("SafeRelPath(%q) = %v, want %v", in, got, want)
		}
	}
}
