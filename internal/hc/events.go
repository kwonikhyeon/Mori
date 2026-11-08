package hc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// SubscribeParams narrow events.subscribe; leaving all empty means every
// terminal.
type SubscribeParams struct {
	ChildrenOf string            `json:"children_of,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"` // terminals carrying all of these
	Terminal   string            `json:"terminal,omitempty"`
}

// Notification is one message on the events channel.
type Notification struct {
	Method   string    // "event", "heartbeat", "missed", or one this client does not know
	Event    *Event    // event
	Seq      int64     // event, heartbeat, missed
	Snapshot *Snapshot // missed: replaces everything; drop later events whose seq is not above it
}

// Events is a subscription. The core writes JSON lines on a channel, and
// sends only as many bytes as were credited back: Recv credits what it
// reads, so a slow reader holds the core back instead of growing a buffer.
type Events struct {
	endpoint
	buf   []byte // received, not yet read
	ahead int    // bytes at the head of buf already credited: a partial line
}

// Subscribe starts an event stream and returns the snapshot it follows.
func (c *Conn) Subscribe(ctx context.Context, p SubscribeParams) (*Events, Snapshot, error) {
	var e *Events
	m, err := c.call(ctx, "events.subscribe", p, func(ch uint32) sink {
		e = &Events{}
		e.init(c, ch, func() { e.buf, e.ahead = nil, 0 })
		return e
	})
	if err != nil {
		return nil, Snapshot{}, err
	}
	var snap Snapshot
	if err := json.Unmarshal(m.Result, &snap); err != nil || e == nil {
		if e != nil {
			e.Close()
		}
		if err == nil {
			err = errors.New("no channel in reply")
		}
		return nil, Snapshot{}, fmt.Errorf("hc: events.subscribe: %w", err)
	}
	if snap.Terminals == nil {
		snap.Terminals = []Terminal{}
	}
	return e, snap, nil
}

func (e *Events) data(p []byte) {
	e.mu.Lock()
	if e.err != nil || e.closing {
		e.mu.Unlock()
		return
	}
	e.buf = append(e.buf, p...)
	over := len(e.buf) > maxBacklog
	e.mu.Unlock()
	if over {
		e.abort(errors.New("hc: events backlog exceeded"))
		return
	}
	e.wake()
}

func (e *Events) resize(int, int) {}

// Recv returns the next notification. Once the subscription has ended it
// first returns the complete lines already received, then why.
func (e *Events) Recv(ctx context.Context) (Notification, error) {
	for {
		line, credit, err := e.next()
		e.credit(credit) // fails only once the channel is gone, which next reports
		if line != nil {
			if line = bytes.TrimSpace(line); len(line) == 0 {
				continue
			}
			n, err := parseNotification(line)
			if err != nil {
				e.abort(err) // out of step: drop the rest; a new subscription starts clean
				return Notification{}, err
			}
			return n, nil
		}
		if err != nil {
			return Notification{}, err
		}
		select {
		case <-e.signal:
		case <-ctx.Done():
			return Notification{}, ctx.Err()
		}
	}
}

// next takes a complete line off the buffer and says how much of it to
// credit. Without a complete line, it credits the partial one, so that a
// message larger than the window can still arrive.
func (e *Events) next() (line []byte, credit int, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closing {
		return nil, 0, ErrDetached
	}
	if i := bytes.IndexByte(e.buf, '\n'); i >= 0 {
		line, credit = e.buf[:i:i], i+1-e.ahead
		e.buf, e.ahead = e.buf[i+1:], 0
		if len(e.buf) == 0 {
			e.buf = nil
		}
		return line, credit, nil
	}
	if e.err != nil {
		return nil, 0, e.err
	}
	credit, e.ahead = len(e.buf)-e.ahead, len(e.buf)
	return nil, credit, nil
}

func parseNotification(line []byte) (Notification, error) {
	var m struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(line, &m); err != nil {
		return Notification{}, fmt.Errorf("hc: events: bad message %.120q: %w", line, err)
	}
	n := Notification{Method: m.Method}
	var err error
	switch m.Method {
	case "event":
		var ev Event
		err = json.Unmarshal(m.Params, &ev)
		n.Event, n.Seq = &ev, ev.Seq
	case "heartbeat":
		var p struct {
			Seq int64 `json:"seq"`
		}
		err = json.Unmarshal(m.Params, &p)
		n.Seq = p.Seq
	case "missed":
		var s Snapshot
		err = json.Unmarshal(m.Params, &s)
		if s.Terminals == nil {
			s.Terminals = []Terminal{}
		}
		n.Seq, n.Snapshot = s.Seq, &s
	}
	if err != nil {
		return Notification{}, fmt.Errorf("hc: events: bad %s %.120q: %w", m.Method, m.Params, err)
	}
	return n, nil
}

// Close ends the subscription, waiting up to two seconds for the core.
func (e *Events) Close() error {
	e.detach()
	return nil
}
