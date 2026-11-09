package gitx

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestIsHash(t *testing.T) {
	for _, s := range []string{strings.Repeat("a", 40), strings.Repeat("0123456789abcdef", 4)} {
		if !IsHash(s) {
			t.Errorf("%q is a hash", s)
		}
	}
	for _, s := range []string{"", "HEAD", "main", strings.Repeat("a", 39), strings.Repeat("a", 41), strings.Repeat("A", 40),
		strings.Repeat("g", 40), "-" + strings.Repeat("a", 39), strings.Repeat("a", 63)} {
		if IsHash(s) {
			t.Errorf("%q is no hash", s)
		}
	}
}

func TestParseCommitFiles(t *testing.T) {
	raw := ":100644 100755 aaaa bbbb M\x00a\x00" +
		":100644 100644 cccc dddd R083\x00long.txt\x00한글 이름.txt\x00" +
		":100644 000000 eeee 0000 D\x00c\x00" +
		":100644 120000 ffff 1111 T\x00e\x00" +
		":000000 100644 0000 2222 A\x00bin.dat\x00"
	stats := []string{"0\t0\ta\x00", "1\t0\t\x00long.txt\x00한글 이름.txt\x00", "0\t1\tc\x00", "1\t1\te\x00", "-\t-\tbin.dat\x00"}
	want := []CommitFile{
		{Path: "a", Kind: "modified"},
		{Path: "한글 이름.txt", Orig: "long.txt", Kind: "renamed", Added: 1},
		{Path: "c", Kind: "deleted", Deleted: 1},
		{Path: "e", Kind: "typechange", Added: 1, Deleted: 1},
		{Path: "bin.dat", Kind: "added", Binary: true},
	}
	for _, tc := range []struct {
		name string
		in   string
		cut  bool
		want []CommitFile
	}{
		{"whole", raw + strings.Join(stats, ""), false, want},
		{"empty", "", false, []CommitFile{}},
		// Cut short, it keeps the files whose counts came whole.
		{"cut in the counts", raw + strings.Join(stats[:3], "") + stats[3][:2], true, want[:3]},
		{"cut between the paths of a rename", raw + stats[0] + "1\t0\t\x00long.txt\x00한글", true, want[:1]},
		{"cut at a NUL", raw + strings.Join(stats[:4], ""), true, want[:4]},
		{"cut in the entries", raw[:len(raw)-5], true, []CommitFile{}},
		{"cut after the entries", raw, true, []CommitFile{}},
	} {
		got, err := ParseCommitFiles([]byte(tc.in), tc.cut)
		if err != nil || got == nil || !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %v\n got %+v\nwant %+v", tc.name, err, got, tc.want)
		}
	}
	for name, in := range map[string]string{
		"no counts":         raw,
		"a count too many":  raw + strings.Join(stats, "") + "0\t0\tz\x00",
		"two counts":        ":100644 100755 aaaa bbbb M\x00a\x00" + "0\ta\x00",
		"another path":      ":100644 100755 aaaa bbbb M\x00a\x00" + "0\t0\tb\x00",
		"not a number":      ":100644 100755 aaaa bbbb M\x00a\x00" + "x\t0\ta\x00",
		"four in an entry":  ":100644 aaaa bbbb M\x00a\x00" + "0\t0\ta\x00",
		"no path":           ":100644 100755 aaaa bbbb M\x00",
		"a rename's path":   ":100644 100644 cccc dddd R083\x00long.txt\x00" + "1\t0\t\x00long.txt\x00",
		"not ended in NULs": raw + strings.Join(stats, "") + "junk",
	} {
		if got, err := ParseCommitFiles([]byte(in), false); err == nil {
			t.Errorf("%s: no error, %+v", name, got)
		}
	}
}

// commitRepo adds to graphRepo a commit on main, "여러 변경", that changes
// a.txt, renames 문서/새 파일.md, deletes [ab].txt and adds a binary
// file; and then a .mailmap that names its author. It returns the hashes
// by subject.
func commitRepo(t *testing.T) (string, map[string]string) {
	t.Helper()
	repo, h := graphRepo(t)
	write(t, filepath.Join(repo, "a.txt"), "a\nb\n")
	if err := os.Rename(filepath.Join(repo, "문서", "새 파일.md"), filepath.Join(repo, "문서", "이름 바꾼 파일.md")); err != nil {
		t.Fatal(err)
	}
	// Not git rm: "[ab].txt" would match a.txt as a pattern.
	if err := os.Remove(filepath.Join(repo, "[ab].txt")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(repo, "bin.dat"), "\x00\x01\x02")
	git(t, repo, "add", "-A")
	git(t, repo, "commit", "-q", "-m", "여러 변경\n\n본문 첫 줄\n둘째 줄")
	h["여러 변경"] = git(t, repo, "rev-parse", "HEAD")
	write(t, filepath.Join(repo, ".mailmap"), "Mori Tester <mori-test@example.com>\n")
	return repo, h
}

func TestCommit(t *testing.T) {
	repo, h := commitRepo(t)
	ctx := context.Background()
	var g Runner
	rev := h["여러 변경"]

	c, err := g.Commit(ctx, repo, rev)
	if err != nil {
		t.Fatal(err)
	}
	want := Commit{Hash: rev, Parents: []string{h["merge feat"]}, Author: "Mori Tester", Email: "mori-test@example.com", AuthorMS: c.AuthorMS,
		Committer: "Mori Tester", CommitterEmail: "mori-test@example.com", CommitMS: c.CommitMS, Message: "여러 변경\n\n본문 첫 줄\n둘째 줄",
		Files: []CommitFile{
			{Path: "[ab].txt", Kind: "deleted", Deleted: 1},
			{Path: "a.txt", Kind: "modified", Added: 1},
			{Path: "bin.dat", Kind: "added", Binary: true},
			{Path: "문서/이름 바꾼 파일.md", Orig: "문서/새 파일.md", Kind: "renamed"},
		}}
	if !reflect.DeepEqual(c, want) || c.AuthorMS <= 0 || c.CommitMS <= 0 {
		t.Fatalf("\n got %+v\nwant %+v", c, want)
	}

	// A merge shows what it brought in: the change against its first parent.
	m, err := g.Commit(ctx, repo, h["merge feat"])
	if err != nil || m.Message != "merge feat" || !slices.Equal(m.Parents, []string{h["main 1"], h["feat 2"]}) ||
		!reflect.DeepEqual(m.Files, []CommitFile{{Path: "f.txt", Kind: "added", Added: 1}}) {
		t.Fatalf("merge: %v %+v", err, m)
	}
	root, err := g.Commit(ctx, repo, h["init"])
	if err != nil || root.Parents == nil || len(root.Parents) != 0 || !reflect.DeepEqual(root.Files, []CommitFile{
		{Path: "[ab].txt", Kind: "added", Added: 1},
		{Path: "a.txt", Kind: "added", Added: 1},
		{Path: "문서/새 파일.md", Kind: "added", Added: 1},
	}) {
		t.Fatalf("root: %v %+v", err, root)
	}

	for _, name := range []string{"main", "HEAD", rev[:7], strings.Repeat("A", 40), "-" + rev[1:]} {
		var ne *NameError
		if _, err := g.Commit(ctx, repo, name); !errors.As(err, &ne) {
			t.Errorf("%q: %v", name, err)
		}
	}
	for _, none := range []string{
		strings.Repeat("0", 40), strings.Repeat("0", 64),
		git(t, repo, "rev-parse", "HEAD^{tree}"), git(t, repo, "rev-parse", "HEAD:a.txt"),
		git(t, repo, "rev-parse", "v0"), // the tag, not the commit it is on
	} {
		if _, err := g.Commit(ctx, repo, none); !errors.Is(err, ErrNoCommit) {
			t.Errorf("%s: %v", none, err)
		}
	}
	// Outside a repository the hash is not what is missing.
	var ge *Error
	if _, err := g.Commit(ctx, t.TempDir(), rev); !errors.As(err, &ge) || errors.Is(err, ErrNoCommit) {
		t.Errorf("not a repository: %v", err)
	}
}

func TestCommitDiff(t *testing.T) {
	repo, h := commitRepo(t)
	ctx := context.Background()
	var g Runner
	rev := h["여러 변경"]
	for _, tc := range []struct {
		name    string
		rev     string
		paths   []string
		in, out []string
	}{
		{"a rename by both its paths", rev, []string{"문서/새 파일.md", "문서/이름 바꾼 파일.md"},
			[]string{"rename from 문서/새 파일.md\n", "rename to 문서/이름 바꾼 파일.md\n"}, []string{"a.txt"}},
		// By its new path alone, git does not see the old one.
		{"a rename by its new path", rev, []string{"문서/이름 바꾼 파일.md"}, []string{"new file mode"}, []string{"rename from"}},
		{"all of it", rev, nil,
			[]string{"\n+b\n", "deleted file mode", "Binary files /dev/null and b/bin.dat differ\n", "rename from 문서/새 파일.md\n"}, nil},
		{"the root", h["init"], []string{"a.txt"}, []string{"new file mode", "\n+a\n"}, []string{"[ab].txt"}},
		// "[ab].txt" is a name, not a pattern matching a.txt.
		{"a name like a pattern", h["init"], []string{"[ab].txt"}, []string{"\n+glob\n"}, []string{"b/a.txt"}},
		{"a merge", h["merge feat"], nil, []string{"b/f.txt", "\n+2\n"}, []string{"m.txt"}},
	} {
		d, cut, err := g.CommitDiff(ctx, repo, tc.rev, tc.paths, 1<<20)
		if err != nil || cut {
			t.Errorf("%s: %v %v", tc.name, cut, err)
			continue
		}
		for _, s := range tc.in {
			if !strings.Contains(d, s) {
				t.Errorf("%s: no %q in\n%s", tc.name, s, d)
			}
		}
		for _, s := range tc.out {
			if strings.Contains(d, s) {
				t.Errorf("%s: %q in\n%s", tc.name, s, d)
			}
		}
	}
	d, cut, err := g.CommitDiff(ctx, repo, rev, nil, 40)
	if err != nil || !cut || len(d) > 40 || !strings.HasSuffix(d, "\n") {
		t.Fatalf("cut (%v, %v): %d bytes\n%s", cut, err, len(d), d)
	}
	var ne *NameError
	if _, _, err := g.CommitDiff(ctx, repo, "main", nil, 0); !errors.As(err, &ne) {
		t.Errorf("a name: %v", err)
	}
	if _, _, err := g.CommitDiff(ctx, repo, strings.Repeat("0", 40), nil, 0); !errors.Is(err, ErrNoCommit) {
		t.Errorf("no such commit: %v", err)
	}
}
