package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hctest"
	"github.com/kwonikhyeon/mori/internal/store"
)

// withManager makes m the server's core manager; m is not started.
func withManager(m *core.Manager) func(*Deps) {
	return func(d *Deps) { d.Core = m }
}

// withCore runs a core manager on c until the test ends and waits until it
// is connected.
func withCore(t *testing.T, c *hctest.Core) func(*Deps) {
	t.Helper()
	m := core.New(core.Options{HC: c.HC, Env: c.Env, MinBackoff: 100 * time.Millisecond, MaxBackoff: 500 * time.Millisecond,
		Logger: slog.New(slog.DiscardHandler)})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	waitUntil(t, "core connected", func() bool { return m.Status().Connected })
	return withManager(m)
}

func waitUntil(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (e *testEnv) eventually(f func() bool) {
	e.t.Helper()
	waitUntil(e.t, "condition", f)
}

// addFolder registers path as a folder straight in the store.
func (e *testEnv) addFolder(path string) store.Folder {
	e.t.Helper()
	f := store.Folder{ID: store.NewID("f_"), Name: filepath.Base(path), Path: path, CreatedMs: time.Now().UnixMilli()}
	if err := e.store.Update(func(st *store.State) error {
		st.Folders = append(st.Folders, f)
		return nil
	}); err != nil {
		e.t.Fatal(err)
	}
	return f
}

// addPreset adds a preset straight in the store.
func (e *testEnv) addPreset(p store.Preset) {
	e.t.Helper()
	if err := e.store.Update(func(st *store.State) error {
		st.Presets = append(st.Presets, p)
		return nil
	}); err != nil {
		e.t.Fatal(err)
	}
}

// json sends a request, fails the test unless the reply has status, and
// decodes the reply into out when out is not nil.
func (e *testEnv) json(method, path string, body any, status int, out any) {
	e.t.Helper()
	res := e.do(method, path, body)
	b, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil {
		e.t.Fatal(err)
	}
	if res.StatusCode != status {
		e.t.Fatalf("%s %s: status %d, want %d: %s", method, path, res.StatusCode, status, b)
	}
	if out != nil {
		if err := json.Unmarshal(b, out); err != nil {
			e.t.Fatalf("%s %s: %v: %s", method, path, err, b)
		}
	}
}

// expectError sends a request and checks it fails with status and an
// error body.
func (e *testEnv) expectError(method, path string, body any, status int) errorBody {
	e.t.Helper()
	var eb errorBody
	e.json(method, path, body, status, &eb)
	if eb.Error.Kind == "" || eb.Error.Message == "" {
		e.t.Fatalf("%s %s: no error body: %+v", method, path, eb)
	}
	return eb
}

// waitTerminal waits until the terminal list shows addr.
func (e *testEnv) waitTerminal(addr string) TerminalView {
	e.t.Helper()
	var found TerminalView
	e.eventually(func() bool {
		var ts []TerminalView
		e.json("GET", "/api/terminals", nil, 200, &ts)
		for _, t := range ts {
			if t.Address == addr {
				found = t
				return true
			}
		}
		return false
	})
	return found
}

// upload posts a multipart body with one part named field.
func (e *testEnv) upload(path, field, name string, data []byte) *http.Response {
	e.t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile(field, name)
	if err != nil {
		e.t.Fatal(err)
	}
	fw.Write(data)
	mw.Close()
	req, err := http.NewRequest("POST", e.srv.URL+path, &body)
	if err != nil {
		e.t.Fatal(err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Origin", e.srv.URL)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: e.token})
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { res.Body.Close() })
	return res
}

func TestRunParams(t *testing.T) {
	f := store.Folder{ID: "f_1", Path: "/repo"}
	p := store.Preset{ID: "claude", Name: "Claude Code", Argv: []string{"claude"}, Task: true}
	got := runParams(f, "/repo", p, createReq{Task: "버그 고쳐줘", Cols: 5, Rows: 5000})
	if !slices.Equal(got.Argv, []string{"claude", "버그 고쳐줘"}) || got.Cwd != "/repo" || !got.Keep || !got.NoParent {
		t.Fatalf("%+v", got)
	}
	if got.Labels["mori"] != "1" || got.Labels["mori.folder"] != "f_1" || got.Labels["mori.preset"] != "claude" || got.Labels["mori.title"] != "버그 고쳐줘" {
		t.Fatal(got.Labels)
	}
	if got.Env["TERM"] != "xterm-256color" || got.Env["COLORTERM"] != "truecolor" || got.Env["TERM_PROGRAM"] != "mori" {
		t.Fatal(got.Env)
	}
	if got.Size.Cols != 10 || got.Size.Rows != 1000 {
		t.Fatal(got.Size)
	}
	if p.Argv[0] != "claude" || len(p.Argv) != 1 {
		t.Fatal("preset argv modified:", p.Argv)
	}

	sh := runParams(f, "/repo", store.Preset{ID: "shell", Name: "셸", Argv: []string{}}, createReq{Task: "ignored"})
	if sh.Argv != nil || sh.Labels["mori.title"] != "셸" || sh.Size.Cols != 80 || sh.Size.Rows != 24 {
		t.Fatalf("%+v", sh)
	}

	long := runParams(f, "/repo/wt", p, createReq{Task: "  첫 줄\n둘째 줄   " + strings.Repeat("가", 50), Title: ""})
	if title := long.Labels["mori.title"]; title != "첫 줄 둘째 줄 "+strings.Repeat("가", 31) || long.Cwd != "/repo/wt" {
		t.Fatalf("%q %q", title, long.Cwd)
	}
	named := runParams(f, "/repo", p, createReq{Task: "x", Title: " 내\t이름 "})
	if named.Labels["mori.title"] != "내 이름" {
		t.Fatal(named.Labels)
	}
	// A preset that takes a task but has no program must not run the task.
	odd := runParams(f, "/repo", store.Preset{ID: "odd", Name: "odd", Task: true}, createReq{Task: "rm -rf x"})
	if odd.Argv != nil {
		t.Fatal(odd.Argv)
	}
	// A task that looks like an option stays the task.
	opt := runParams(f, "/repo", p, createReq{Task: " --dangerously-skip-permissions 해 줘\n"})
	if !slices.Equal(opt.Argv, []string{"claude", " --dangerously-skip-permissions 해 줘"}) || opt.Labels["mori.title"] != "--dangerously-skip-permissions 해 줘" {
		t.Fatalf("%q %q", opt.Argv, opt.Labels["mori.title"])
	}
	if blank := runParams(f, "/repo", p, createReq{Task: " \n "}); !slices.Equal(blank.Argv, []string{"claude"}) || blank.Labels["mori.title"] != "Claude Code" {
		t.Fatalf("%+v", blank)
	}
}

func TestTerminalAddressWithSlash(t *testing.T) { // Review Focus 3
	var got string
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/terminals/{t}", func(w http.ResponseWriter, r *http.Request) { got = terminalParam(r) })
	mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/terminals/rohan%2Ft7", nil))
	if got != "rohan/t7" {
		t.Fatalf("%q", got)
	}

	// Through the whole server it reaches the handler, not the 404 of an
	// unknown path: the core is down, so the handler answers 503.
	e := newTestEnv(t)
	e.pair()
	for _, path := range []string{"/api/terminals/rohan%2Ft7", "/api/terminals/rohan%2Ft7/text"} {
		if eb := e.expectError("GET", path, nil, 503); eb.Error.Kind != "core_unavailable" {
			t.Fatal(path, eb)
		}
	}
}

func TestTerminalLifecycleOverHTTP(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	c := hctest.Start(t)
	e := newTestEnv(t, withCore(t, c))
	e.pair()
	dir := t.TempDir()
	f := e.addFolder(dir)
	e.addPreset(store.Preset{ID: "sh", Name: "sh", Argv: []string{"/bin/sh"}})

	var tv TerminalView
	e.json("POST", "/api/terminals", map[string]any{"folder_id": f.ID, "preset": "sh", "title": "테스트", "cols": 90, "rows": 30}, 201, &tv)
	if tv.Address == "" || tv.State != "live" || tv.DisplayTitle != "테스트" || tv.FolderID != f.ID || tv.Preset != "sh" {
		t.Fatalf("%+v", tv)
	}
	if tv.Labels["mori"] != "1" || tv.Cols != 90 || tv.Rows != 30 || !tv.Keep {
		t.Fatalf("%+v", tv.Terminal)
	}
	listed := e.waitTerminal(tv.Address)
	if listed.FolderID != f.ID || listed.DisplayTitle != "테스트" {
		t.Fatalf("%+v", listed)
	}
	term := "/api/terminals/" + url.PathEscape(tv.Address)

	e.json("POST", term+"/send", map[string]any{"text": "echo hi-$((1+1)) $TERM_PROGRAM"}, 200, nil)
	e.eventually(func() bool {
		var r struct{ Text string }
		e.json("GET", term+"/text", nil, 200, &r)
		return strings.Contains(r.Text, "hi-2 mori")
	})
	e.expectError("GET", term+"/text?lines=-1", nil, 400)
	e.json("POST", term+"/keys", map[string]any{"keys": []string{"enter"}}, 200, nil)
	e.expectError("POST", term+"/keys", map[string]any{"keys": []string{}}, 400)
	if eb := e.expectError("POST", term+"/keys", map[string]any{"keys": []string{"nosuchkey"}}, 400); eb.Error.Kind != "invalid_params" {
		t.Fatal(eb)
	}
	var intr struct{ Outcome string }
	e.json("POST", term+"/interrupt", map[string]any{"timeout": 1}, 200, &intr)
	if intr.Outcome == "" {
		t.Fatal("interrupt gave no outcome")
	}

	res := e.upload(term+"/files", "file", "메모 1.txt", []byte("파일 내용"))
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	put := decode[struct {
		Path  string `json:"path"`
		Bytes int64  `json:"bytes"`
	}](t, res)
	if b, err := os.ReadFile(put.Path); err != nil || string(b) != "파일 내용" || put.Bytes != int64(len("파일 내용")) {
		t.Fatalf("%+v: %q %v", put, b, err)
	}

	e.json("PATCH", term, map[string]any{"title": "새 이름"}, 200, nil)
	e.eventually(func() bool {
		var v TerminalView
		e.json("GET", term, nil, 200, &v)
		return v.DisplayTitle == "새 이름"
	})
	e.expectError("PATCH", term, map[string]any{}, 400)
	var cleared TerminalView
	e.json("PATCH", term, map[string]any{"title": ""}, 200, &cleared)
	if _, ok := cleared.Labels["mori.title"]; ok || cleared.DisplayTitle == "" {
		t.Fatalf("%+v", cleared)
	}

	if eb := e.expectError("DELETE", term, nil, 409); eb.Error.Kind != "live" {
		t.Fatal(eb)
	}
	var killed TerminalView
	e.json("POST", term+"/kill", nil, 200, &killed)
	e.eventually(func() bool {
		var v TerminalView
		e.json("GET", term, nil, 200, &v)
		return v.State == "finished"
	})
	if eb := e.expectError("POST", term+"/send", map[string]any{"text": "x"}, 409); eb.Error.Kind != "finished" {
		t.Fatal(eb)
	}
	var all, recent []TerminalView
	e.json("GET", "/api/terminals?all=1", nil, 200, &all)
	e.json("GET", "/api/terminals", nil, 200, &recent)
	if len(all) != 1 || len(recent) != 1 {
		t.Fatalf("all %d, recent %d: a terminal that just finished is recent", len(all), len(recent))
	}
	e.expectError("GET", "/api/terminals?all=maybe", nil, 400)

	e.json("DELETE", term, nil, 204, nil)
	e.eventually(func() bool {
		var ts []TerminalView
		e.json("GET", "/api/terminals?all=1", nil, 200, &ts)
		return len(ts) == 0
	})
	if eb := e.expectError("GET", "/api/terminals/t999", nil, 404); eb.Error.Kind != "not_found" {
		t.Fatal(eb)
	}

	var ov struct {
		Host struct{ Name, Version string }
		Core struct {
			Connected bool
		}
		Folders   []store.Folder
		Terminals []TerminalView
		Presets   []store.Preset
		Hosts     []store.Host
	}
	e.json("GET", "/api/overview", nil, 200, &ov)
	if ov.Host.Name != "testhost" || ov.Host.Version != "test" || !ov.Core.Connected || len(ov.Folders) != 1 || len(ov.Presets) != 4 || ov.Hosts == nil || ov.Terminals == nil {
		t.Fatalf("%+v", ov)
	}
}

func TestCreateTerminalValidation(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	dir := t.TempDir()
	f := e.addFolder(dir)
	gone := e.addFolder(filepath.Join(dir, "gone"))
	for _, body := range []map[string]any{
		{"preset": "shell"},
		{"folder_id": "f_nope", "preset": "shell"},
		{"folder_id": f.ID},
		{"folder_id": f.ID, "preset": "nope"},
		{"folder_id": f.ID, "preset": "shell", "worktree": "relative/path"},
		{"folder_id": f.ID, "preset": "shell", "worktree": filepath.Join(dir, "missing")},
		{"folder_id": gone.ID, "preset": "shell"},
		{"folder_id": f.ID, "preset": "shell", "title": strings.Repeat("가", maxTitle+1)},
	} {
		if eb := e.expectError("POST", "/api/terminals", body, 400); eb.Error.Kind != "invalid_params" {
			t.Fatal(body, eb)
		}
	}
	// Valid, but the core is down.
	e.expectError("POST", "/api/terminals", map[string]any{"folder_id": f.ID, "preset": "shell"}, 503)
}

func TestCoreDownIs503(t *testing.T) {
	e := newTestEnv(t, withManager(core.New(core.Options{HC: "/nonexistent/hc", Logger: slog.New(slog.DiscardHandler)})))
	e.pair()
	if eb := e.expectError("GET", "/api/terminals/t1/text", nil, 503); eb.Error.Kind != "core_unavailable" {
		t.Fatal(eb)
	}
	e.expectError("POST", "/api/terminals/t1/kill", nil, 503)
	var ts []TerminalView
	e.json("GET", "/api/terminals", nil, 200, &ts)
	if ts == nil || len(ts) != 0 {
		t.Fatal(ts)
	}
	var ov struct {
		Core      struct{ Connected bool }
		Terminals []TerminalView
	}
	e.json("GET", "/api/overview", nil, 200, &ov)
	if ov.Core.Connected || ov.Terminals == nil {
		t.Fatalf("%+v", ov)
	}
}

func TestUploadLimits(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	res := e.upload("/api/terminals/t1/files", "file", "big.bin", make([]byte, maxUpload+1))
	if res.StatusCode != 413 || decode[errorBody](t, res).Error.Kind != "too_large" {
		t.Fatal(res.StatusCode)
	}
	res = e.upload("/api/terminals/t1/files", "other", "a.txt", []byte("x"))
	if res.StatusCode != 400 {
		t.Fatal(res.StatusCode)
	}
	e.expectError("POST", "/api/terminals/t1/files", `{"not":"multipart"}`, 400)
	// Within the limit it gets as far as the core, which is down.
	res = e.upload("/api/terminals/t1/files", "file", "ok.bin", make([]byte, maxUpload))
	if res.StatusCode != 503 {
		t.Fatal(res.StatusCode)
	}
}

func TestUploadName(t *testing.T) {
	for in, want := range map[string]string{
		"a.txt":                  "a.txt",
		`C:\fakepath\사진.png`:     "사진.png",
		"../../etc/passwd":       "passwd",
		"":                       "upload",
		"..":                     "upload",
		" . ":                    "upload",
		"dir/":                   "dir",
		"  공백 이름.md  ":           "공백 이름.md",
		"new\nline.txt":          "new line.txt",
		strings.Repeat("a", 300): strings.Repeat("a", 255),
		`a<b>:c|"d".txt`:         "a_b__c__d_.txt",
		// 255 bytes at most, cut between runes, the extension kept.
		strings.Repeat("가", 200) + ".txt": strings.Repeat("가", 83) + ".txt",
	} {
		if got := uploadName(in); got != want {
			t.Errorf("uploadName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPresetsValidation(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	for _, body := range []any{
		[]map[string]any{{"id": "Bad Id", "name": "x", "argv": []string{}}},
		[]map[string]any{{"id": "a", "name": "x"}, {"id": "a", "name": "y"}},
		[]map[string]any{{"id": "a", "name": " "}},
		[]map[string]any{{"id": "a", "name": "x", "argv": []string{"aider", ""}}},
		[]map[string]any{{"id": "a", "name": "x", "task": true}},
		[]map[string]any{{"id": strings.Repeat("a", 33), "name": "x"}},
		[]map[string]any{},
		map[string]any{"id": "a"},
	} {
		if eb := e.expectError("PUT", "/api/presets", body, 400); eb.Error.Kind != "invalid_params" {
			t.Fatal(body, eb)
		}
	}
	var saved []store.Preset
	e.json("PUT", "/api/presets", []map[string]any{{"id": "aider", "name": " Aider ", "argv": []string{"aider"}, "task": false}, {"id": "sh", "name": "셸"}}, 200, &saved)
	var got []store.Preset
	e.json("GET", "/api/presets", nil, 200, &got)
	if len(got) != 2 || got[0].Name != "Aider" || got[1].Argv == nil || !slices.EqualFunc(got, saved, presetEqual) {
		t.Fatalf("%+v %+v", got, saved)
	}
}

func presetEqual(a, b store.Preset) bool {
	return a.ID == b.ID && a.Name == b.Name && a.Task == b.Task && slices.Equal(a.Argv, b.Argv)
}

func TestHostsValidation(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	for _, body := range []any{
		[]map[string]any{{"name": "", "url": "https://desktop.example.com"}},
		[]map[string]any{{"name": "x", "url": "ftp://desktop.example.com"}},
		[]map[string]any{{"name": "x", "url": "desktop.example.com"}},
		[]map[string]any{{"name": "x", "url": "https://"}},
		[]map[string]any{{"name": "x", "url": "https://user:pw@desktop.example.com"}},
		[]map[string]any{{"name": "x", "url": "javascript:alert(1)"}},
	} {
		if eb := e.expectError("PUT", "/api/hosts", body, 400); eb.Error.Kind != "invalid_params" {
			t.Fatal(body, eb)
		}
	}
	var got []store.Host
	e.json("PUT", "/api/hosts", []map[string]any{{"name": " desktop ", "url": "https://desktop.example.com/"}}, 200, nil)
	e.json("GET", "/api/hosts", nil, 200, &got)
	if len(got) != 1 || got[0].Name != "desktop" || got[0].URL != "https://desktop.example.com" {
		t.Fatal(got)
	}
	e.json("PUT", "/api/hosts", []map[string]any{}, 200, nil)
	e.json("GET", "/api/hosts", nil, 200, &got)
	if got == nil || len(got) != 0 {
		t.Fatal(got)
	}
}
