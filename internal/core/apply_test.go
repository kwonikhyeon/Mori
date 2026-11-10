package core

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/hc"
)

func ev(typ, addr, data string) hc.Event {
	return hc.Event{Type: typ, Terminal: addr, Data: json.RawMessage(data)}
}

func TestApplyTable(t *testing.T) {
	c := NewCache(nil)
	ch, ok, _ := c.Apply(ev("created", "t1", `{"address":"t1","state":"live","argv":["sh"],"cwd":"/w","labels":{},"cols":80,"rows":24,"pid":10,"foreground":{"pid":11,"name":"vim","argv":["vim"],"cwd":"/w"}}`))
	if !ok || ch.Old != nil || ch.New.Address != "t1" || ch.Event == nil || ch.Event.Type != "created" {
		t.Fatal(ch)
	}
	c.Apply(ev("status", "t1", `{"status":{"state":"blocked","app":"claude-code"},"records":{},"reported":true}`))
	if c["t1"].Status.State != "blocked" || !c["t1"].Reported {
		t.Fatal("status")
	}
	ch, _, _ = c.Apply(ev("turn", "t1", `{"turn":2,"state":"done"}`))
	if c["t1"].Turn != 2 || ch.Old.Turn != 0 {
		t.Fatal("turn")
	}
	c.Apply(ev("size", "t1", `{"cols":120,"rows":40}`))
	c.Apply(ev("title", "t1", `{"title":"hello"}`))
	c.Apply(ev("labels", "t1", `{"labels":{"mori.title":"작업"}}`))
	c.Apply(ev("keep", "t1", `{"keep":true}`))
	c.Apply(ev("lost", "t1", `{"reason":"signaled","exit_code":null,"signal":9,"finished_ms":null}`))
	tt := c["t1"]
	if tt.Cols != 120 || tt.Rows != 40 || tt.Title != "hello" || tt.Labels["mori.title"] != "작업" || !tt.Keep ||
		tt.State != "live" || tt.Pid != nil || tt.Foreground != nil || *tt.Reason != "signaled" || *tt.Signal != 9 {
		t.Fatalf("%+v", tt)
	}
	c.Apply(ev("restarted", "t1", `{"address":"t1","state":"live","argv":["/bin/zsh","-l"],"pid":12,"keep":true,"labels":{"mori.title":"작업"}}`))
	if c["t1"].Pid == nil || *c["t1"].Pid != 12 || c["t1"].Reason != nil {
		t.Fatalf("restarted replaces the record: %+v", c["t1"])
	}
	c.Apply(ev("finished", "t1", `{"reason":"exited","exit_code":0,"signal":null,"finished_ms":5}`))
	if c["t1"].State != "finished" || *c["t1"].FinishedMs != 5 || *c["t1"].ExitCode != 0 || c["t1"].Signal != nil {
		t.Fatal("finished")
	}
	ch, ok, _ = c.Apply(ev("removed", "t1", `{}`))
	if !ok || ch.New != nil || ch.Old.Address != "t1" || len(c) != 0 {
		t.Fatal("removed")
	}
	if _, ok, _ := c.Apply(ev("title", "t9", `{"title":"x"}`)); ok {
		t.Fatal("unknown terminal must be ignored")
	}
	if _, ok, _ := c.Apply(hc.Event{Type: "doc", Data: json.RawMessage(`{"name":"x","version":1}`)}); ok {
		t.Fatal("doc ignored")
	}
	if _, ok, err := c.Apply(ev("future", "t1", `{}`)); ok || err != nil {
		t.Fatal("unknown types are ignored")
	}
}

func TestApplyDoesNotMutateOld(t *testing.T) {
	c := NewCache([]hc.Terminal{{Address: "t1", State: "live", Turn: 1, Labels: map[string]string{"a": "1"}}})
	ch, _, _ := c.Apply(ev("turn", "t1", `{"turn":2,"state":"idle"}`))
	if ch.Old.Turn != 1 || ch.New.Turn != 2 {
		t.Fatal("old must be a copy")
	}
	ch, _, _ = c.Apply(ev("labels", "t1", `{"labels":{"b":"2"}}`))
	if ch.Old.Labels["a"] != "1" || ch.Old.Labels["b"] != "" || ch.New.Labels["b"] != "2" || ch.New.Labels["a"] != "" {
		t.Fatal("labels are replaced, not merged, and old keeps its own")
	}
}

func TestApplyLabelsWithRecord(t *testing.T) {
	c := NewCache(nil)
	ch, ok, err := c.Apply(ev("labels", "t4", `{"labels":{"mori":"1"},"record":{"address":"t4","state":"live","labels":{"mori":"1"}}}`))
	if err != nil || !ok || ch.Old != nil || c["t4"] == nil || c["t4"].Labels["mori"] != "1" {
		t.Fatal("a record that newly matches is added:", ch, ok, err)
	}
}

func TestApplyForeground(t *testing.T) {
	c := NewCache([]hc.Terminal{{Address: "t1", State: "live"}})
	c.Apply(ev("foreground", "t1", `{"pid":7,"name":"claude","argv":["claude"],"cwd":"/w"}`))
	if c["t1"].Foreground == nil || c["t1"].Foreground.Name != "claude" {
		t.Fatal("set")
	}
	if _, ok, _ := c.Apply(ev("foreground", "t1", `{"pid":7,"name":"claude","argv":["claude"],"cwd":"/w"}`)); ok {
		t.Fatal("the same value again is no change")
	}
	if _, ok, _ := c.Apply(ev("foreground", "t1", `null`)); !ok || c["t1"].Foreground != nil {
		t.Fatal("null clears it")
	}
}

func TestApplyBadData(t *testing.T) {
	c := NewCache([]hc.Terminal{{Address: "t1", State: "live", Cols: 80}})
	if _, ok, err := c.Apply(ev("size", "t1", `{"cols":"wide"}`)); err == nil || ok || c["t1"].Cols != 80 {
		t.Fatal("bad data must fail and leave the record alone:", err)
	}
}

func TestNewCacheCopies(t *testing.T) {
	ts := []hc.Terminal{{Address: "t1"}}
	c := NewCache(ts)
	ts[0].Title = "changed"
	if c["t1"].Title != "" {
		t.Fatal("cache must not alias the input")
	}
}

func TestDiff(t *testing.T) {
	a := NewCache([]hc.Terminal{{Address: "t1", Turn: 1}, {Address: "t2"}})
	b := NewCache([]hc.Terminal{{Address: "t1", Turn: 2}, {Address: "t3"}})
	got := Diff(a, b)
	if len(got) != 3 || got[0].Address != "t1" || got[0].Old.Turn != 1 || got[0].New.Turn != 2 ||
		got[1].Address != "t2" || got[1].New != nil || got[2].Address != "t3" || got[2].Old != nil || got[0].Event != nil {
		t.Fatalf("%+v", got)
	}
	if len(Diff(b, NewCache([]hc.Terminal{{Address: "t1", Turn: 2}, {Address: "t3"}}))) != 0 {
		t.Fatal("same snapshot must have no changes")
	}
}

func TestDisplayTitle(t *testing.T) {
	cases := []struct {
		t    hc.Terminal
		want string
	}{
		{hc.Terminal{Labels: map[string]string{"mori.title": "리뷰"}, Title: "x"}, "리뷰"},
		{hc.Terminal{Labels: map[string]string{"mori.title": "  "}, Title: "vim a.go"}, "vim a.go"},
		{hc.Terminal{Title: "vim a.go"}, "vim a.go"},
		{hc.Terminal{Foreground: &hc.Foreground{Name: "codex"}, Argv: []string{"zsh"}}, "codex"},
		{hc.Terminal{Argv: []string{"/opt/bin/claude", "-p"}}, "claude"},
		{hc.Terminal{Argv: []string{`C:\Program Files\PowerShell\7\pwsh.EXE`}}, "pwsh"},
		{hc.Terminal{}, "셸"},
	}
	for _, c := range cases {
		if got := DisplayTitle(c.t); got != c.want {
			t.Errorf("%q want %q", got, c.want)
		}
	}
}

func TestApplyStampsStatusWord(t *testing.T) { // spec §3 #189
	ms := int64(7)
	c := NewCache([]hc.Terminal{{Address: "t1", State: "live", StatusMs: &ms, Status: &hc.Status{State: "working"}}})
	c.Apply(ev("status", "t1", `{"status":{"state":"working","progress":50},"records":{},"reported":true}`))
	if *c["t1"].StatusMs != 7 {
		t.Fatal("progress alone moved status_ms")
	}
	before := time.Now().UnixMilli()
	c.Apply(ev("status", "t1", `{"status":{"state":"blocked","msg":"Allow?"},"records":{},"reported":true}`))
	stamped := *c["t1"].StatusMs
	if stamped < before || stamped > time.Now().UnixMilli() {
		t.Fatalf("status_ms %d, want the time the word changed", stamped)
	}
	if ms != 7 {
		t.Fatal("the old record changed")
	}
	c.Apply(ev("status", "t1", `{"status":{"state":"blocked","msg":"Allow this?"},"records":{},"reported":true}`))
	c.Apply(ev("status", "t1", `{"status":null,"records":{},"reported":true}`))
	if *c["t1"].StatusMs != stamped {
		t.Fatal("a new message or an exit moved status_ms")
	}
	fresh := NewCache([]hc.Terminal{{Address: "t2", State: "live"}})
	fresh.Apply(ev("status", "t2", `{"status":{"state":"idle"},"records":{},"reported":true}`))
	if fresh["t2"].StatusMs == nil {
		t.Fatal("a first word has no status_ms")
	}
}

func TestAskID(t *testing.T) { // spec §3 #194
	perm := "permission"
	ask := func(state, msg string, kind *string, turn int64) string {
		return AskID(hc.Terminal{State: "live", Turn: turn, Status: &hc.Status{State: state, Msg: msg, Kind: kind}})
	}
	a := ask("blocked", "Allow Bash?", &perm, 3)
	if a == "" || a != ask("blocked", "Allow Bash?", &perm, 3) {
		t.Fatalf("%q: the same question must have the same ID", a)
	}
	for _, other := range []string{
		ask("blocked", "Allow Edit?", &perm, 3),
		ask("blocked", "Allow Bash?", nil, 3),
		ask("blocked", "Allow Bash?", &perm, 4),
	} {
		if other == a || other == "" {
			t.Fatalf("%q and %q: a different question must differ", a, other)
		}
	}
	if ask("working", "Allow Bash?", &perm, 3) != "" || AskID(hc.Terminal{State: "live"}) != "" {
		t.Fatal("only a blocked program asks")
	}
	if AskID(hc.Terminal{State: "finished", Status: &hc.Status{State: "blocked"}}) != "" {
		t.Fatal("a finished program asks nothing")
	}
}
