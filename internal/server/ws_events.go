package server

import (
	"context"
	"encoding/json"
	"maps"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
)

const (
	pingEvery    = 30 * time.Second
	writeTimeout = 10 * time.Second
	watchBuffer  = 1024 // updates an events socket may fall behind before it is closed
)

// The messages of /ws/events (spec §7.2).
type (
	snapshotMsg struct {
		Type      string         `json:"type"`
		Core      core.Status    `json:"core"`
		Folders   []FolderView   `json:"folders"`
		Terminals []TerminalView `json:"terminals"`
	}
	terminalMsg struct {
		Type     string       `json:"type"`
		Terminal TerminalView `json:"terminal"`
	}
	removedMsg struct {
		Type    string `json:"type"`
		Address string `json:"address"`
	}
	foldersMsg struct {
		Type    string       `json:"type"`
		Folders []FolderView `json:"folders"`
	}
	coreMsg struct {
		Type string `json:"type"`
		core.Status
	}
)

// signal wakes whoever subscribed. A subscriber that has not woken yet
// wakes once, however often it fired.
type signal struct {
	mu   sync.Mutex
	subs map[chan struct{}]struct{}
}

func (g *signal) subscribe() (c <-chan struct{}, unsubscribe func()) {
	ch := make(chan struct{}, 1)
	g.mu.Lock()
	if g.subs == nil {
		g.subs = map[chan struct{}]struct{}{}
	}
	g.subs[ch] = struct{}{}
	g.mu.Unlock()
	return ch, func() {
		g.mu.Lock()
		delete(g.subs, ch)
		g.mu.Unlock()
	}
}

func (g *signal) fire() {
	g.mu.Lock()
	defer g.mu.Unlock()
	for ch := range g.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// FoldersChanged tells the event sockets that the folders, or which folder
// or worktree a terminal belongs to, may have changed.
func (s *Server) FoldersChanged() { s.folders.fire() }

// eventFeed makes the messages of one events socket from what the core
// manager reports. It remembers what it has told the browser, so it can
// leave out terminals that finished long ago and see which ones moved.
type eventFeed struct {
	s    *Server
	told map[string]TerminalView
}

func newEventFeed(s *Server) *eventFeed { return &eventFeed{s: s, told: map[string]TerminalView{}} }

func (f *eventFeed) tell(v TerminalView) TerminalView {
	f.told[v.Address] = v
	return v
}

// snapshot is the first message: the live terminals and those that
// finished within recentFinished, as the REST list shows them.
func (f *eventFeed) snapshot(ts []hc.Terminal, st core.Status, now time.Time) snapshotMsg {
	m := snapshotMsg{Type: "snapshot", Core: st, Folders: f.s.folderViews(f.s.d.Store.Folders()), Terminals: []TerminalView{}}
	for _, t := range ts {
		if recent(t, now) {
			m.Terminals = append(m.Terminals, f.tell(f.s.view(t)))
		}
	}
	return m
}

// update is the message for u, or nil when the browser need not hear of
// it: a terminal it was never shown, finished long ago or gone.
func (f *eventFeed) update(u core.Update, now time.Time) any {
	if u.Core != nil {
		return coreMsg{Type: "core", Status: *u.Core}
	}
	ch := u.Change
	if ch == nil {
		return nil
	}
	_, told := f.told[ch.Address]
	switch {
	case ch.New == nil && told:
		delete(f.told, ch.Address)
		return removedMsg{Type: "removed", Address: ch.Address}
	case ch.New != nil && (told || recent(*ch.New, now)):
		return terminalMsg{Type: "terminal", Terminal: f.tell(f.s.view(*ch.New))}
	}
	return nil
}

// foldersChanged is what FoldersChanged sends: the folders, then each
// terminal shown whose folder or worktree is now another.
func (f *eventFeed) foldersChanged() []any {
	out := []any{foldersMsg{Type: "folders", Folders: f.s.folderViews(f.s.d.Store.Folders())}}
	for _, addr := range slices.Sorted(maps.Keys(f.told)) {
		old := f.told[addr]
		if v := f.s.view(old.Terminal); v.FolderID != old.FolderID || v.Worktree != old.Worktree {
			out = append(out, terminalMsg{Type: "terminal", Terminal: f.tell(v)})
		}
	}
	return out
}

// handleEventsWS streams changes to the browser (spec §7.2): a snapshot,
// then each change. The browser sends only pings, each answered with a pong.
func (s *Server) handleEventsWS(w http.ResponseWriter, r *http.Request) {
	c, done, ok := s.acceptWS(w, r)
	if !ok {
		return
	}
	defer done()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	pings := make(chan struct{}, 1)
	go func() { defer cancel(); readPings(ctx, c, pings) }()
	folders, unsubscribe := s.folders.subscribe() // before the snapshot, so no change slips between
	defer unsubscribe()
	wt := s.d.Core.Watch(watchBuffer)
	defer wt.Close()
	stop := make(chan struct{})
	pinged := make(chan struct{})
	go func() { keepAlive(r.Context(), stop, c); close(pinged) }()
	defer func() { close(stop); <-pinged }()

	f := newEventFeed(s)
	if err := writeWS(ctx, c, f.snapshot(wt.Terminals, wt.Core, time.Now())); err != nil {
		c.CloseNow()
		return
	}
	tick := time.NewTicker(pingEvery)
	defer tick.Stop()
	for {
		var msgs []any
		select {
		case <-ctx.Done():
			c.CloseNow()
			return
		case <-wt.Lost():
			c.Close(websocket.StatusTryAgainLater, "이벤트가 밀렸습니다. 다시 연결하세요")
			return
		case u := <-wt.C:
			if m := f.update(u, time.Now()); m != nil {
				msgs = append(msgs, m)
			}
		case <-folders:
			msgs = f.foldersChanged()
		case <-tick.C:
			msgs = append(msgs, map[string]string{"type": "ping"})
		case <-pings:
			msgs = append(msgs, map[string]string{"type": "pong"})
		}
		for _, m := range msgs {
			if err := writeWS(ctx, c, m); err != nil {
				c.CloseNow()
				return
			}
		}
	}
}

// readPings reads what the browser sends on the events socket. A phone back
// from sleep may hold a socket that still says it is open while nothing
// reaches it, so the browser asks with {"type":"ping"} and waits for the
// pong (spec §3 #178). Anything else closes the socket with 1008, as
// CloseRead did. It also keeps the socket read, which keepAlive and Close
// need. It returns when the socket ends.
func readPings(ctx context.Context, c *websocket.Conn, pings chan<- struct{}) {
	for {
		typ, b, err := c.Read(ctx)
		if err != nil {
			return
		}
		var m struct {
			Type string `json:"type"`
		}
		if typ != websocket.MessageText || json.Unmarshal(b, &m) != nil || m.Type != "ping" {
			c.Close(websocket.StatusPolicyViolation, "이벤트 소켓에는 ping만 보냅니다")
			return
		}
		select {
		case pings <- struct{}{}:
		default: // a pong is on its way already
		}
	}
}

// writeWS writes one JSON message, giving up on a browser that stops
// reading.
func writeWS(ctx context.Context, c *websocket.Conn, v any) error {
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return wsjson.Write(ctx, c, v)
}

// writeBinary writes terminal output the same way.
func writeBinary(ctx context.Context, c *websocket.Conn, p []byte) error {
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.Write(ctx, websocket.MessageBinary, p)
}

// keepAlive pings the browser every pingEvery and drops the socket when no
// pong comes within writeTimeout: a phone that went off the network says
// nothing, and its socket would hold on to its viewer for many minutes. It
// needs someone reading c, as both handlers have. ctx must not end before
// the handler does, since a ping cut short closes the socket before the
// handler can say why; stop ends it.
func keepAlive(ctx context.Context, stop <-chan struct{}, c *websocket.Conn) {
	tick := time.NewTicker(pingEvery)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		pctx, cancel := context.WithTimeout(ctx, writeTimeout)
		err := c.Ping(pctx)
		cancel()
		if err != nil {
			c.CloseNow()
			return
		}
	}
}
