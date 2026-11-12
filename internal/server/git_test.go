package server

import (
	"encoding/json"
	"net/url"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/kwonikhyeon/mori/internal/gittest"
	"github.com/kwonikhyeon/mori/internal/gitx"
)

func TestGitLogAndCommit(t *testing.T) {
	repo := gittest.Repo(t)
	gittest.Git(t, repo, "checkout", "-q", "-b", "feat")
	writeFile(t, filepath.Join(repo, "README.md"), "mori\nfeat\n")
	gittest.Git(t, repo, "commit", "-q", "-am", "feat 1")
	gittest.Git(t, repo, "mv", "README.md", "읽어 보기.md")
	gittest.Git(t, repo, "commit", "-q", "-m", "이름 바꾸기")
	gittest.Git(t, repo, "checkout", "-q", "main")
	empty := filepath.Join(realDir(t), "빈 저장소")
	gittest.Git(t, filepath.Dir(empty), "init", "-q", "-b", "main", empty)
	e := newTestEnv(t)
	e.pair()
	e.json("POST", "/api/folders", map[string]any{"path": repo}, 201, nil)
	e.json("POST", "/api/folders", map[string]any{"path": empty}, 201, nil)
	at := func(p string) string { return "?path=" + url.QueryEscape(p) }

	// The lists come as lists, empty or not, never as null.
	var raw struct{ Commits []map[string]json.RawMessage }
	e.json("GET", "/api/git/log"+at(repo), nil, 200, &raw)
	for _, c := range raw.Commits {
		for _, k := range []string{"parents", "refs", "up", "pass", "down"} {
			if !strings.HasPrefix(string(c[k]), "[") {
				t.Fatalf("%s: %s", k, c[k])
			}
		}
	}
	var gr gitx.Graph
	e.json("GET", "/api/git/log"+at(repo), nil, 200, &gr)
	if len(gr.Commits) != 3 || gr.Width != 1 || gr.More || gr.Commits[0].Subject != "이름 바꾸기" ||
		!reflect.DeepEqual(gr.Commits[0].Refs, []gitx.Ref{{Name: "feat", Kind: "branch"}}) ||
		!reflect.DeepEqual(gr.Commits[2].Refs, []gitx.Ref{{Name: "main", Kind: "branch", Current: true}}) {
		t.Fatalf("%+v", gr)
	}
	rename, root := gr.Commits[0].Hash, gr.Commits[2].Hash
	e.json("GET", "/api/git/log"+at(repo)+"&head=1", nil, 200, &gr)
	if len(gr.Commits) != 1 || gr.Commits[0].Hash != root {
		t.Fatalf("HEAD only: %+v", gr)
	}
	e.json("GET", "/api/git/log"+at(repo)+"&limit=2", nil, 200, &gr)
	if len(gr.Commits) != 2 || !gr.More {
		t.Fatalf("limit 2: %+v", gr)
	}
	var none struct {
		Commits json.RawMessage
		Width   int
	}
	e.json("GET", "/api/git/log"+at(empty), nil, 200, &none)
	if string(none.Commits) != "[]" || none.Width != 0 {
		t.Fatalf("no commits: %+v", none)
	}

	var c gitx.Commit
	e.json("GET", "/api/git/commit"+at(repo)+"&rev="+rename, nil, 200, &c)
	if c.Hash != rename || c.Message != "이름 바꾸기" || c.Author != "mori-test" || c.Truncated ||
		!reflect.DeepEqual(c.Files, []gitx.CommitFile{{Path: "읽어 보기.md", Orig: "README.md", Kind: "renamed"}}) {
		t.Fatalf("%+v", c)
	}
	var d struct {
		Diff      string
		Truncated bool
	}
	e.json("GET", "/api/git/diff"+at(repo)+"&rev="+rename+"&file="+url.QueryEscape("읽어 보기.md")+"&orig=README.md", nil, 200, &d)
	if !strings.Contains(d.Diff, "rename from README.md\n") || !strings.Contains(d.Diff, "rename to 읽어 보기.md\n") || d.Truncated {
		t.Fatalf("%+v", d)
	}
	e.json("GET", "/api/git/diff"+at(repo)+"&rev="+root, nil, 200, &d)
	if !strings.Contains(d.Diff, "new file mode") || !strings.Contains(d.Diff, "\n+mori\n") {
		t.Fatalf("root: %+v", d)
	}

	for _, q := range []string{"&limit=0", "&limit=2001", "&limit=-1", "&limit=x", "&head=maybe"} {
		e.expectError("GET", "/api/git/log"+at(repo)+q, nil, 400)
	}
	for _, q := range []string{"", "&rev=", "&rev=main", "&rev=" + rename[:7], "&rev=" + strings.ToUpper(rename), "&rev=--all"} {
		if eb := e.expectError("GET", "/api/git/commit"+at(repo)+q, nil, 400); eb.Error.Kind != "invalid_params" {
			t.Fatal(q, eb)
		}
	}
	for _, q := range []string{
		"&rev=main", "&rev=" + rename + "&staged=1",
		"&orig=README.md&file=x", "&rev=" + rename + "&orig=README.md", "&rev=" + rename + "&file=x&orig=../x",
	} {
		if eb := e.expectError("GET", "/api/git/diff"+at(repo)+q, nil, 400); eb.Error.Kind != "invalid_params" {
			t.Fatal(q, eb)
		}
	}
	// git would refuse the name as well, but this says what a rev must be.
	for _, api := range []string{"commit", "diff"} {
		if eb := e.expectError("GET", "/api/git/"+api+at(repo)+"&rev=main", nil, 400); eb.Error.Message != `rev는 커밋의 전체 해시여야 합니다: "main"` {
			t.Fatal(api, eb)
		}
	}
	zeros := strings.Repeat("0", 40)
	if eb := e.expectError("GET", "/api/git/commit"+at(repo)+"&rev="+zeros, nil, 404); eb.Error.Kind != "not_found" {
		t.Fatal(eb)
	}
	e.expectError("GET", "/api/git/diff"+at(repo)+"&rev="+zeros, nil, 404)
	// Only the worktrees of registered folders, and only their tops.
	for _, p := range []string{"", "rel", realDir(t), filepath.Join(repo, "sub")} {
		e.expectError("GET", "/api/git/log"+at(p), nil, 400)
		e.expectError("GET", "/api/git/commit"+at(p)+"&rev="+rename, nil, 400)
	}
}

// TestGitFetch: a commit pushed from elsewhere shows as behind after a
// fetch, a branch the remote dropped goes, and an unreachable remote is
// git's error (spec §3 #227).
func TestGitFetch(t *testing.T) {
	repo := gittest.Repo(t)
	gittest.Git(t, repo, "branch", "old")
	base := filepath.Dir(repo)
	origin, here, other := filepath.Join(base, "origin.git"), filepath.Join(base, "here"), filepath.Join(base, "other")
	gittest.Git(t, base, "clone", "-q", "--bare", repo, origin)
	gittest.Git(t, base, "clone", "-q", origin, here)
	gittest.Git(t, base, "clone", "-q", origin, other)
	writeFile(t, filepath.Join(other, "README.md"), "mori\nother\n")
	gittest.Git(t, other, "commit", "-q", "-am", "from another device")
	gittest.Git(t, other, "push", "-q", "origin", "main")
	gittest.Git(t, origin, "branch", "-D", "old")

	e := newTestEnv(t)
	e.pair()
	var f FolderView
	e.json("POST", "/api/folders", map[string]any{"path": here}, 201, &f)
	at := "?path=" + url.QueryEscape(here)
	var st gitx.Status
	e.json("GET", "/api/git/status"+at, nil, 200, &st)
	if st.Behind != 0 {
		t.Fatalf("before the fetch: %+v", st)
	}
	e.json("POST", "/api/git/fetch"+at, nil, 204, nil)
	e.json("GET", "/api/git/status"+at, nil, 200, &st)
	if st.Behind != 1 || st.Ahead != 0 {
		t.Fatalf("after the fetch: %+v", st)
	}
	var bs gitx.Branches
	e.json("GET", "/api/folders/"+f.ID+"/branches", nil, 200, &bs)
	for _, b := range bs.Remote {
		if b.Name == "origin/old" {
			t.Fatalf("a branch the remote dropped stays: %+v", bs.Remote)
		}
	}

	gittest.Git(t, here, "remote", "set-url", "origin", filepath.Join(base, "gone"))
	if eb := e.expectError("POST", "/api/git/fetch"+at, nil, 422); eb.Error.Kind != "git_failed" {
		t.Fatalf("%+v", eb)
	}
	e.expectError("POST", "/api/git/fetch?path="+url.QueryEscape(base), nil, 400)
}
