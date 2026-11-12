package main

import (
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
