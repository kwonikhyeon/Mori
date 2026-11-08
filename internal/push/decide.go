// Package push tells the user's devices when a terminal needs them: it
// waits for approval or for input, failed, or exited (spec §6.5). It keeps
// the host's VAPID key and the devices' Web Push subscriptions in the store.
package push

import (
	"encoding/json"
	"strings"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
)

// Kind is what a notification is about.
type Kind string

const (
	KindBlocked Kind = "blocked" // the program asks for approval
	KindWaiting Kind = "waiting" // its turn ended; it waits for input
	KindError   Kind = "error"   // the program reported an error
	KindExited  Kind = "exited"  // the program exited
)

// Kinds lists every kind in the order the UI shows them.
var Kinds = []Kind{KindBlocked, KindWaiting, KindError, KindExited}

// DefaultKinds are what a subscription that names no kinds receives.
var DefaultKinds = []Kind{KindBlocked, KindWaiting, KindError}

// Label is the kind as the notification title names it.
func (k Kind) Label() string {
	switch k {
	case KindBlocked:
		return "승인 대기"
	case KindWaiting:
		return "입력 대기"
	case KindError:
		return "오류"
	case KindExited:
		return "종료"
	}
	return string(k)
}

// Decide says which notification c calls for, or "" for none. children
// allows terminals that have a parent; without it only their parent's
// state counts, which hc keeps for the agent that started them.
//
// A terminal on another machine (an address with "/") is left to the Mori
// of that machine. A status event notifies when the program enters blocked
// or error. A done or idle turn waits for the turn event that follows the
// status, so a turn that ends notifies once. Two snapshots compared after
// a reconnect notify by the same rules, from the records alone.
func Decide(c core.Change, children bool) Kind {
	if c.Old == nil || c.New == nil || strings.Contains(c.Address, "/") {
		return ""
	}
	if c.New.Parent != nil && *c.New.Parent != "" && !children {
		return ""
	}
	if c.Event == nil {
		if c.New.State == "finished" && c.Old.State != "finished" {
			return KindExited
		}
		if k := entered(c.Old, c.New); k != "" {
			return k
		}
		if c.New.Turn > c.Old.Turn && waiting(state(c.New)) {
			return KindWaiting
		}
		return ""
	}
	switch c.Event.Type {
	case "status":
		return entered(c.Old, c.New)
	case "turn":
		if waiting(turnState(c)) {
			return KindWaiting
		}
	case "finished":
		return KindExited
	}
	return ""
}

// entered is blocked or error when the program has just reported it.
func entered(old, next *hc.Terminal) Kind {
	s := state(next)
	if s == state(old) {
		return ""
	}
	switch s {
	case "blocked":
		return KindBlocked
	case "error":
		return KindError
	}
	return ""
}

func state(t *hc.Terminal) string {
	if t.Status == nil {
		return ""
	}
	return t.Status.State
}

// turnState is the state a turn event ended in. The event names it; the
// record, which the status event before it set, stands in when it does not.
func turnState(c core.Change) string {
	var d struct {
		State string `json:"state"`
	}
	if json.Unmarshal(c.Event.Data, &d) == nil && d.State != "" {
		return d.State
	}
	return state(c.New)
}

func waiting(s string) bool { return s == "done" || s == "idle" }
