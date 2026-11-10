package server

import (
	"encoding/base64"
	"net/url"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/hctest"
	"github.com/kwonikhyeon/mori/internal/store"
)

func TestAnswersHold(t *testing.T) { // spec §3 #194
	var a answers
	now := time.UnixMilli(1_700_000_000_000)
	k := answerKey{"t1", "1.0badc0de"}
	other := answerKey{"t1", "2.0badc0de"}
	if !a.take(k, now) {
		t.Fatal("a question no one answers is not taken")
	}
	if a.take(k, now) {
		t.Fatal("taken again while the first answer's keys go in")
	}
	if !a.take(other, now) {
		t.Fatal("another question is held by the first")
	}
	a.done(k, true, now)
	if a.take(k, now.Add(answerHold-time.Millisecond)) {
		t.Fatal("answered again within the hold")
	}
	if !a.take(k, now.Add(answerHold)) {
		t.Fatal("still held once the hold passed")
	}
	a.done(k, false, now.Add(answerHold))
	if !a.take(k, now.Add(answerHold)) {
		t.Fatal("an answer that did not go in holds the question")
	}
	// What has passed its hold is swept; what is going in is not.
	a.done(other, true, now)
	a.done(k, true, now)
	a.take(answerKey{"t2", "1.0badc0de"}, now.Add(answerHold))
	if len(a.held) != 1 {
		t.Fatalf("held %v", a.held)
	}
}

// report is a shell function that reports a status the way agents do
// (OSC 7501, spec §2.3), and the message msg encodes for it.
const report = `r() { printf '\033]7501;%s\007' "$1"; }; `

func msg(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

// asking starts a terminal that runs script under /bin/sh and returns its
// API path and address.
func (e *testEnv) asking(script string) (string, string) {
	e.t.Helper()
	f := e.addFolder(e.t.TempDir())
	e.addPreset(store.Preset{ID: "ask", Name: "ask", Argv: []string{"/bin/sh", "-c", report + script}})
	var tv TerminalView
	e.json("POST", "/api/terminals", map[string]any{"folder_id": f.ID, "preset": "ask", "cols": 80, "rows": 24}, 201, &tv)
	return "/api/terminals/" + url.PathEscape(tv.Address), tv.Address
}

// waitAsk waits until the terminal at path asks ask.
func (e *testEnv) waitAsk(path, ask string) {
	e.t.Helper()
	waitUntil(e.t, "the question "+ask, func() bool {
		var v TerminalView
		e.json("GET", path, nil, 200, &v)
		return v.Ask == ask
	})
}

// waitScreen waits until the terminal at path shows s.
func (e *testEnv) waitScreen(path, s string) {
	e.t.Helper()
	waitUntil(e.t, "the screen to show "+s, func() bool { return strings.Contains(e.screen(path), s) })
}

func (e *testEnv) screen(path string) string {
	e.t.Helper()
	var r struct{ Text string }
	e.json("GET", path+"/text", nil, 200, &r)
	return r.Text
}

// askOf is the ID of the permission question q asked at turn.
func askOf(turn int64, q string) string {
	kind := "permission"
	return core.AskID(hc.Terminal{State: "live", Turn: turn, Status: &hc.Status{State: "blocked", Kind: &kind, Msg: q}})
}

func TestAnswerOnlyTheQuestionSeen(t *testing.T) { // spec §3 #194
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	e := newTestEnv(t, withCore(t, hctest.Start(t)))
	e.pair()
	q := msg("Allow Bash?")
	// The program asks the same question twice, working in between.
	path, _ := e.asking(`r state=working; r "state=blocked:kind=permission:msg=` + q + `"; read -r a; echo "first:$a"; ` +
		`r state=working; r "state=blocked:kind=permission:msg=` + q + `"; read -r b; echo "second:$b"; ` +
		`r state=working; sleep 30`)
	first := askOf(1, "Allow Bash?")
	e.waitAsk(path, first)

	// An answer to a question the program does not ask does not go in.
	if eb := e.expectError("POST", path+"/keys", map[string]any{"keys": []string{"1", "enter"}, "expect": "1.0badc0de"}, 409); eb.Error.Kind != "changed" {
		t.Fatal(eb)
	}
	e.json("POST", path+"/keys", map[string]any{"keys": []string{"2", "enter"}, "expect": first}, 200, nil)
	// A second device's answer to the same question comes too late.
	if eb := e.expectError("POST", path+"/keys", map[string]any{"keys": []string{"1", "enter"}, "expect": first}, 409); eb.Error.Kind != "answered" {
		t.Fatal(eb)
	}
	e.waitScreen(path, "first:2")

	// The same words asked again are another question: the turn moved on.
	second := askOf(2, "Allow Bash?")
	if second == first {
		t.Fatal("the two questions have one ID")
	}
	e.waitAsk(path, second)
	e.s.answers.mu.Lock()
	e.s.answers.held = nil // the hold has passed
	e.s.answers.mu.Unlock()
	if eb := e.expectError("POST", path+"/keys", map[string]any{"keys": []string{"1", "enter"}, "expect": first}, 409); eb.Error.Kind != "changed" {
		t.Fatal(eb)
	}
	e.json("POST", path+"/keys", map[string]any{"keys": []string{"3", "enter"}, "expect": second}, 200, nil)
	e.waitScreen(path, "second:3")
	if s := e.screen(path); strings.Contains(s, "first:1") || strings.Contains(s, "second:1") {
		t.Fatalf("a refused answer went in:\n%s", s)
	}
	// Without expect the keys go as before, asked or not.
	e.waitAsk(path, "")
	e.json("POST", path+"/keys", map[string]any{"keys": []string{"enter"}}, 200, nil)
}

func TestRejectAndInstruct(t *testing.T) { // spec §3 #195
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	e := newTestEnv(t, withCore(t, hctest.Start(t)))
	e.pair()
	// The program reads a key at a time while it asks. It ignores the
	// first Esc and asks something else; the second puts the question
	// away, and it reads a line of what to do instead and works on it (a
	// send waits a moment for the program to start).
	path, _ := e.asking(`stty -icanon -echo min 1 time 0; r state=working; ` +
		`r "state=blocked:kind=permission:msg=` + msg("Allow Bash?") + `"; dd bs=1 count=1 >/dev/null 2>&1; echo ignored-esc; ` +
		`r "state=blocked:kind=permission:msg=` + msg("Allow Edit?") + `"; dd bs=1 count=1 >/dev/null 2>&1; ` +
		`stty icanon echo; r state=idle; read -r line; r state=working; echo "instruction:$line"; sleep 30`)
	first := askOf(1, "Allow Bash?")
	e.waitAsk(path, first)

	e.expectError("POST", path+"/reject", map[string]any{"text": " ", "expect": first}, 400)
	e.expectError("POST", path+"/reject", map[string]any{"text": "reject-me"}, 400)
	if eb := e.expectError("POST", path+"/reject", map[string]any{"text": "reject-me", "expect": "1.0badc0de"}, 409); eb.Error.Kind != "changed" {
		t.Fatal(eb)
	}

	// Esc that does not put the question away sends nothing more.
	e.s.unblock = 300 * time.Millisecond
	if eb := e.expectError("POST", path+"/reject", map[string]any{"text": "reject-me", "expect": first}, 409); eb.Error.Kind != "blocked" {
		t.Fatal(eb)
	}
	e.waitScreen(path, "ignored-esc")

	second := askOf(1, "Allow Edit?")
	e.waitAsk(path, second)
	e.s.unblock = rejectWait
	e.json("POST", path+"/reject", map[string]any{"text": "reject-me", "expect": second}, 200, nil)
	e.waitScreen(path, "instruction:reject-me")
	if s := e.screen(path); strings.Count(s, "instruction:") != 1 {
		t.Fatalf("want one instruction:\n%s", s)
	}
}
