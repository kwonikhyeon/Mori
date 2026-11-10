package server

import (
	"net/url"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"github.com/kwonikhyeon/mori/internal/commands"
	"github.com/kwonikhyeon/mori/internal/hctest"
	"github.com/kwonikhyeon/mori/internal/store"
)

// The commands of a terminal come from its folder and the Claude Code
// config, next to the built-in ones (spec §3 #197).
func TestTerminalCommands(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	config := t.TempDir()
	mkdirs(t, filepath.Join(config, "commands"))
	writeFile(t, filepath.Join(config, "commands", "mine.md"), "---\ndescription: 내 명령\n---\n")
	dir := t.TempDir()
	mkdirs(t, filepath.Join(dir, ".claude", "commands"))
	writeFile(t, filepath.Join(dir, ".claude", "commands", "hello.md"), "---\nargument-hint: <name>\n---\n# 인사합니다\n")

	c := hctest.Start(t)
	e := newTestEnv(t, withCore(t, c), func(d *Deps) { d.Commands = commands.New(config) })
	e.pair()
	f := e.addFolder(dir)
	e.addPreset(store.Preset{ID: "sh", Name: "sh", Argv: []string{"/bin/sh"}})
	var tv TerminalView
	e.json("POST", "/api/terminals", map[string]any{"folder_id": f.ID, "preset": "sh", "cols": 90, "rows": 30}, 201, &tv)

	var list commands.List
	e.json("GET", "/api/terminals/"+url.PathEscape(tv.Address)+"/commands", nil, 200, &list)
	if list.Partial {
		t.Fatalf("%+v", list)
	}
	find := func(name string) commands.Command {
		t.Helper()
		i := slices.IndexFunc(list.Commands, func(c commands.Command) bool { return c.Name == name })
		if i < 0 {
			t.Fatalf("no %s in %+v", name, list.Commands)
		}
		return list.Commands[i]
	}
	if c := find("hello"); c.Source != commands.SourceProject || c.Hint != "<name>" || c.Desc != "인사합니다" {
		t.Fatalf("%+v", c)
	}
	if c := find("mine"); c.Source != commands.SourceUser || c.Desc != "내 명령" {
		t.Fatalf("%+v", c)
	}
	if c := find("compact"); c.Source != commands.SourceBuiltin {
		t.Fatalf("%+v", c)
	}

	e.expectError("GET", "/api/terminals/nosuch/commands", nil, 404)
}
