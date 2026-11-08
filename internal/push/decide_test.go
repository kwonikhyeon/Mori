package push_test

import (
	"encoding/json"
	"testing"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/push"
)

// term is a live terminal at addr whose program last reported state (""
// for never), after turn turns, started inside parent ("" for none).
func term(addr, state string, turn int64, parent string) *hc.Terminal {
	t := &hc.Terminal{Address: addr, State: "live", Turn: turn, Argv: []string{"claude"}}
	if state != "" {
		t.Status = &hc.Status{State: state}
	}
	if parent != "" {
		t.Parent = &parent
	}
	return t
}

// finished is t after its program exited with code.
func finished(t *hc.Terminal, code int) *hc.Terminal {
	c := *t
	c.State, c.Status, c.ExitCode = "finished", nil, &code
	return &c
}

func event(typ, data string) *hc.Event {
	return &hc.Event{Type: typ, Terminal: "t1", Data: json.RawMessage(data)}
}

func TestDecide(t *testing.T) {
	status := event("status", `{}`) // Decide reads the records, not this
	cases := []struct {
		name     string
		c        core.Change
		children bool
		want     push.Kind
	}{
		{"blocked", core.Change{Address: "t1", Old: term("t1", "working", 0, ""), New: term("t1", "blocked", 0, ""), Event: status}, false, push.KindBlocked},
		{"blocked without a status before", core.Change{Address: "t1", Old: term("t1", "", 0, ""), New: term("t1", "blocked", 0, ""), Event: status}, false, push.KindBlocked},
		{"still blocked", core.Change{Address: "t1", Old: term("t1", "blocked", 0, ""), New: term("t1", "blocked", 0, ""), Event: status}, false, ""},
		{"error", core.Change{Address: "t1", Old: term("t1", "working", 0, ""), New: term("t1", "error", 0, ""), Event: status}, false, push.KindError},
		{"working", core.Change{Address: "t1", Old: term("t1", "idle", 0, ""), New: term("t1", "working", 0, ""), Event: status}, false, ""},
		{"done waits for the turn", core.Change{Address: "t1", Old: term("t1", "working", 0, ""), New: term("t1", "done", 0, ""), Event: status}, false, ""},
		{"status gone", core.Change{Address: "t1", Old: term("t1", "blocked", 0, ""), New: term("t1", "", 0, ""), Event: status}, false, ""},
		{"turn done", core.Change{Address: "t1", Old: term("t1", "done", 0, ""), New: term("t1", "done", 1, ""), Event: event("turn", `{"state":"done","turn":1}`)}, false, push.KindWaiting},
		{"turn idle", core.Change{Address: "t1", Old: term("t1", "idle", 2, ""), New: term("t1", "idle", 3, ""), Event: event("turn", `{"state":"idle","turn":3}`)}, false, push.KindWaiting},
		{"turn blocked is not waiting", core.Change{Address: "t1", Old: term("t1", "blocked", 0, ""), New: term("t1", "blocked", 1, ""), Event: event("turn", `{"state":"blocked","turn":1}`)}, false, ""},
		{"turn error is not waiting", core.Change{Address: "t1", Old: term("t1", "error", 0, ""), New: term("t1", "error", 1, ""), Event: event("turn", `{"state":"error","turn":1}`)}, false, ""},
		{"turn without a state reads the record", core.Change{Address: "t1", Old: term("t1", "done", 0, ""), New: term("t1", "done", 1, ""), Event: event("turn", `{"turn":1}`)}, false, push.KindWaiting},
		{"finished", core.Change{Address: "t1", Old: term("t1", "idle", 0, ""), New: finished(term("t1", "idle", 0, ""), 0), Event: event("finished", `{"reason":"exited","exit_code":0}`)}, false, push.KindExited},
		{"lost", core.Change{Address: "t1", Old: term("t1", "idle", 0, ""), New: term("t1", "idle", 0, ""), Event: event("lost", `{"reason":"signaled","signal":9}`)}, false, ""},
		{"child skipped", core.Change{Address: "t2", Old: term("t2", "working", 0, "t1"), New: term("t2", "blocked", 0, "t1"), Event: status}, false, ""},
		{"child allowed", core.Change{Address: "t2", Old: term("t2", "working", 0, "t1"), New: term("t2", "blocked", 0, "t1"), Event: status}, true, push.KindBlocked},
		{"other machine", core.Change{Address: "rohan/t7", Old: term("rohan/t7", "working", 0, ""), New: term("rohan/t7", "blocked", 0, ""), Event: status}, false, ""},
		{"created", core.Change{Address: "t1", New: term("t1", "blocked", 0, ""), Event: event("created", `{}`)}, false, ""},
		{"removed", core.Change{Address: "t1", Old: term("t1", "blocked", 0, ""), Event: event("removed", `{}`)}, false, ""},
		{"snapshot blocked", core.Change{Address: "t1", Old: term("t1", "working", 0, ""), New: term("t1", "blocked", 1, "")}, false, push.KindBlocked},
		{"snapshot turn", core.Change{Address: "t1", Old: term("t1", "working", 1, ""), New: term("t1", "done", 2, "")}, false, push.KindWaiting},
		{"snapshot same turn", core.Change{Address: "t1", Old: term("t1", "done", 2, ""), New: term("t1", "done", 2, "")}, false, ""},
		{"snapshot finished", core.Change{Address: "t1", Old: term("t1", "blocked", 0, ""), New: finished(term("t1", "blocked", 0, ""), 1)}, false, push.KindExited},
		{"snapshot new terminal", core.Change{Address: "t1", New: term("t1", "blocked", 0, "")}, false, ""},
	}
	for _, c := range cases {
		if got := push.Decide(c.c, c.children); got != c.want {
			t.Errorf("%s: Decide = %q, want %q", c.name, got, c.want)
		}
	}
}
