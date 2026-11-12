package main

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestClaudeHook(t *testing.T) {
	var got []string
	label := func(terminal, kv string) error {
		got = append(got, terminal+" "+kv)
		return nil
	}
	const id = "3fb3a8e8-f08c-4666-9f7f-faa8caa2f6db"
	in := `{"session_id":"` + id + `","hook_event_name":"SessionStart","source":"clear"}`
	runClaudeHook("t8", strings.NewReader(in), label)
	if len(got) != 1 || got[0] != "t8 mori.claude.session="+id {
		t.Fatal(got)
	}
	// outside a terminal, with no ID, a name that is not an ID or not JSON: nothing
	got = nil
	runClaudeHook("", strings.NewReader(in), label)
	runClaudeHook("t8", strings.NewReader(`{"source":"startup"}`), label)
	runClaudeHook("t8", strings.NewReader(`{"session_id":"x; rm -rf /"}`), label)
	runClaudeHook("t8", strings.NewReader(`not json`), label)
	if len(got) != 0 {
		t.Fatal(got)
	}
}

// TestClaudeSettings: the hook runs this program in exec form, with no shell
// to read its path (spec §3 #241).
func TestClaudeSettings(t *testing.T) {
	path := claudeSettings(t.TempDir())
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var s struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Type, Command string
				Args          []string
			}
		}
	}
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	exe, _ := os.Executable()
	if h := s.Hooks["SessionStart"]; len(h) != 1 || len(h[0].Hooks) != 1 || h[0].Hooks[0].Type != "command" ||
		h[0].Hooks[0].Command != exe || !slices.Equal(h[0].Hooks[0].Args, []string{"claude-hook"}) {
		t.Fatalf("%s", b)
	}
	if claudeSettings(path+"/no") != "" { // a home it cannot write in: no hook
		t.Fatal("wrote")
	}
}
