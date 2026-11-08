package core

import (
	"cmp"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"

	"github.com/kwonikhyeon/mori/internal/hc"
)

// Change is one terminal's record before and after an event, or between two
// snapshots.
type Change struct {
	Address string
	Old     *hc.Terminal // nil: it is new
	New     *hc.Terminal // nil: it is gone
	Event   *hc.Event    // the event behind it; nil when two snapshots were compared
}

// Cache holds terminal records by address. A record in it is never changed
// in place: Apply stores a new one, so the records in a Change, and the
// maps and slices inside them, may be shared and must not be modified.
type Cache map[string]*hc.Terminal

// NewCache makes a cache from a snapshot.
func NewCache(ts []hc.Terminal) Cache {
	c := make(Cache, len(ts))
	for _, t := range ts {
		c[t.Address] = &t
	}
	return c
}

// Apply applies ev the way the schema says. It reports false when nothing
// changed: an event for a terminal it does not hold, a doc event, a type
// it does not know, or a value the record already had. Bad data is an error
// and leaves the cache as it was.
func (c Cache) Apply(ev hc.Event) (Change, bool, error) {
	addr := ev.Terminal
	old := c[addr]
	var next *hc.Terminal
	switch ev.Type {
	case "created", "restarted":
		var t hc.Terminal
		if err := decode(ev, &t); err != nil {
			return Change{}, false, err
		}
		if addr == "" {
			addr = t.Address
		}
		if t.Address == "" {
			t.Address = addr
		}
		old = c[addr]
		next = &t
	case "labels":
		var d struct {
			Labels map[string]string `json:"labels"`
			Record *hc.Terminal      `json:"record"`
		}
		if err := decode(ev, &d); err != nil {
			return Change{}, false, err
		}
		switch {
		case d.Record != nil: // it newly matches the subscription
			if d.Record.Address == "" {
				d.Record.Address = addr
			}
			next = d.Record
		case old != nil:
			next = edit(old, func(t *hc.Terminal) { t.Labels = d.Labels })
		}
	case "removed":
		if old == nil {
			return Change{}, false, nil
		}
		delete(c, addr)
		return Change{Address: addr, Old: old, Event: &ev}, true, nil
	default:
		if old == nil {
			return Change{}, false, nil
		}
		var err error
		if next, err = applyPartial(old, ev); err != nil {
			return Change{}, false, err
		}
	}
	if next == nil || (old != nil && reflect.DeepEqual(old, next)) {
		return Change{}, false, nil
	}
	c[addr] = next
	return Change{Address: addr, Old: old, New: next, Event: &ev}, true, nil
}

// applyPartial applies an event that changes some fields of old. It returns
// nil for types it ignores.
func applyPartial(old *hc.Terminal, ev hc.Event) (*hc.Terminal, error) {
	switch ev.Type {
	case "lost", "finished":
		var d struct {
			Reason     *string `json:"reason"`
			ExitCode   *int    `json:"exit_code"`
			Signal     *int    `json:"signal"`
			FinishedMs *int64  `json:"finished_ms"`
		}
		if err := decode(ev, &d); err != nil {
			return nil, err
		}
		return edit(old, func(t *hc.Terminal) {
			t.Reason, t.ExitCode, t.Signal, t.FinishedMs = d.Reason, d.ExitCode, d.Signal, d.FinishedMs
			t.Foreground = nil
			if ev.Type == "lost" {
				t.Pid = nil // a kept terminal stays live, waiting for its new shell
			} else {
				t.State = "finished"
			}
		}), nil
	case "keep":
		var d struct {
			Keep bool `json:"keep"`
		}
		if err := decode(ev, &d); err != nil {
			return nil, err
		}
		return edit(old, func(t *hc.Terminal) { t.Keep = d.Keep }), nil
	case "status":
		var d struct {
			Status   *hc.Status           `json:"status"`
			Records  map[string]hc.Status `json:"records"`
			Reported bool                 `json:"reported"`
		}
		if err := decode(ev, &d); err != nil {
			return nil, err
		}
		return edit(old, func(t *hc.Terminal) { t.Status, t.Records, t.Reported = d.Status, d.Records, d.Reported }), nil
	case "turn":
		var d struct {
			Turn int64 `json:"turn"`
		}
		if err := decode(ev, &d); err != nil {
			return nil, err
		}
		return edit(old, func(t *hc.Terminal) { t.Turn = d.Turn }), nil
	case "title":
		var d struct {
			Title string `json:"title"`
		}
		if err := decode(ev, &d); err != nil {
			return nil, err
		}
		return edit(old, func(t *hc.Terminal) { t.Title = d.Title }), nil
	case "size":
		var d hc.Size
		if err := decode(ev, &d); err != nil {
			return nil, err
		}
		return edit(old, func(t *hc.Terminal) { t.Cols, t.Rows = d.Cols, d.Rows }), nil
	case "foreground":
		var d *hc.Foreground
		if err := decode(ev, &d); err != nil {
			return nil, err
		}
		return edit(old, func(t *hc.Terminal) { t.Foreground = d }), nil
	}
	return nil, nil // doc and types added later
}

// edit returns a copy of old changed by f. f must replace fields, never
// change the maps and slices they hold, which the copy shares with old.
func edit(old *hc.Terminal, f func(*hc.Terminal)) *hc.Terminal {
	t := *old
	f(&t)
	return &t
}

func decode(ev hc.Event, v any) error {
	if err := json.Unmarshal(ev.Data, v); err != nil {
		return fmt.Errorf("core: %s event for %q: %w", ev.Type, ev.Terminal, err)
	}
	return nil
}

// Diff lists what changed from a to b, by address.
func Diff(a, b Cache) []Change {
	var out []Change
	for addr, old := range a {
		if next, ok := b[addr]; !ok {
			out = append(out, Change{Address: addr, Old: old})
		} else if !reflect.DeepEqual(old, next) {
			out = append(out, Change{Address: addr, Old: old, New: next})
		}
	}
	for addr, next := range b {
		if _, ok := a[addr]; !ok {
			out = append(out, Change{Address: addr, New: next})
		}
	}
	slices.SortFunc(out, func(x, y Change) int { return cmp.Compare(x.Address, y.Address) })
	return out
}
