package server

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/kwonikhyeon/mori/internal/hctest"
	"github.com/kwonikhyeon/mori/internal/history"
	"github.com/kwonikhyeon/mori/internal/store"
)

type promptList struct {
	Prompts []history.Prompt `json:"prompts"`
	Source  string           `json:"source"`
}

// What was sent in a terminal's folder comes from Claude Code's record, never
// the real ~/.claude (claude-input design §5.1, spec §3 #226).
func TestTerminalPrompts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	config := t.TempDir()
	c := hctest.Start(t)
	e := newTestEnv(t, withCore(t, c), func(d *Deps) { d.ClaudeConfig = config })
	e.pair()
	f := e.addFolder(t.TempDir())
	e.addPreset(store.Preset{ID: "sh", Name: "sh", Argv: []string{"/bin/sh"}})
	var tv TerminalView
	e.json("POST", "/api/terminals", map[string]any{"folder_id": f.ID, "preset": "sh", "cols": 90, "rows": 30}, 201, &tv)
	path := "/api/terminals/" + url.PathEscape(tv.Address) + "/prompts"

	// no record yet
	var got promptList
	e.json("GET", path, nil, 200, &got)
	if got.Source != "none" || got.Prompts == nil || len(got.Prompts) != 0 {
		t.Fatalf("%+v", got)
	}

	var lines []byte
	for i, p := range []struct{ text, project string }{{"첫째", tv.Cwd}, {"다른 곳", "/elsewhere"}, {"둘째", tv.Cwd}} {
		b, _ := json.Marshal(map[string]any{"display": p.text, "pastedContents": map[string]any{}, "timestamp": i + 1, "project": p.project, "sessionId": "s"})
		lines = append(append(lines, b...), '\n')
	}
	if err := os.WriteFile(filepath.Join(config, "history.jsonl"), lines, 0o600); err != nil {
		t.Fatal(err)
	}
	e.json("GET", path+"?limit=1", nil, 200, &got)
	if got.Source != "claude" || len(got.Prompts) != 1 || got.Prompts[0].Text != "둘째" || got.Prompts[0].At != 3 {
		t.Fatalf("%+v", got)
	}
	e.json("GET", path, nil, 200, &got)
	if len(got.Prompts) != 2 || got.Prompts[1].Text != "첫째" {
		t.Fatalf("%+v", got)
	}

	e.expectError("GET", path+"?limit=x", nil, 400)
	e.expectError("GET", "/api/terminals/nosuch/prompts", nil, 404)
}
