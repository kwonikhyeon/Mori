package core

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/procutil"
)

// ErrUnavailable reports that Mori is not connected to the core right now.
var ErrUnavailable = errors.New("core unavailable")

const (
	dialTimeout  = 20 * time.Second // hc connect may have to start the core first
	startTimeout = 15 * time.Second
	maxResyncs   = 3 // events channel restarts in a row before reconnecting
)

// Options say how the manager reaches its core.
type Options struct {
	HC                     string   // the hc binary; empty means Locate on every attempt, since an update may move it
	Session                string   // the hc session; empty leaves it to HC_SESSION
	Env                    []string // hc's environment; nil means os.Environ()
	StartServer            bool     // run `hc server start` once after the first failed attempt (Windows)
	MinBackoff, MaxBackoff time.Duration
	Logger                 *slog.Logger
	// OnChange hears every change in event order, from one goroutine. It is
	// not called for the first snapshot, only for events and for what a
	// later snapshot (reconnect, missed) shows has changed. It must not block.
	OnChange func(Change)
}

// Status is the connection to the core as the UI shows it.
type Status struct {
	Connected bool   `json:"connected"`
	Version   string `json:"version,omitempty"`
	Name      string `json:"name,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Update is one thing a Watcher hears: a terminal changed, or the
// connection did.
type Update struct {
	Change *Change
	Core   *Status
}

// Manager keeps one connection to the core, a cache of its terminals, and
// the watchers that follow them. The cache keeps its last state while the
// core is away.
type Manager struct {
	o   Options
	log *slog.Logger

	mu       sync.Mutex
	conn     *hc.Conn // nil while disconnected
	cache    Cache
	synced   bool // a snapshot has been taken before
	status   Status
	watchers map[*Watcher]struct{}
}

func New(o Options) *Manager {
	if o.MinBackoff <= 0 {
		o.MinBackoff = 500 * time.Millisecond
	}
	if o.MaxBackoff <= 0 {
		o.MaxBackoff = 10 * time.Second
	}
	o.MaxBackoff = max(o.MaxBackoff, o.MinBackoff)
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	return &Manager{o: o, log: o.Logger, cache: Cache{}, watchers: map[*Watcher]struct{}{}}
}

// Run connects to the core and keeps reconnecting, with backoff, until ctx
// ends. Call it once.
func (m *Manager) Run(ctx context.Context) {
	backoff := m.o.MinBackoff
	triedStart := false
	lastErr := ""
	for {
		connected, err := m.connectOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		if connected {
			backoff = m.o.MinBackoff
		} else if m.o.StartServer && !triedStart {
			triedStart = true
			m.startServer(ctx)
		}
		if msg := err.Error(); msg != lastErr || connected {
			m.log.Warn("core connection", "err", msg, "retry_in", backoff.String())
			lastErr = msg
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, m.o.MaxBackoff)
	}
}

// connectOnce connects, follows the events until something ends them, and
// reports whether it got as far as a snapshot.
func (m *Manager) connectOnce(ctx context.Context) (bool, error) {
	c, ev, snap, err := m.dial(ctx)
	if err != nil {
		m.down(err)
		return false, err
	}
	defer c.Close()
	m.up(c, snap)
	err = m.follow(ctx, c, ev, snap.Seq)
	m.down(err)
	return true, err
}

func (m *Manager) dial(ctx context.Context) (*hc.Conn, *hc.Events, hc.Snapshot, error) {
	path := m.o.HC
	if path == "" {
		p, err := hc.Locate("")
		if err != nil {
			return nil, nil, hc.Snapshot{}, err
		}
		path = p
	}
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	c, err := hc.Dial(dctx, hc.Options{Path: path, Session: m.o.Session, Env: m.o.Env, Stderr: logWriter{m.log}})
	if err != nil {
		return nil, nil, hc.Snapshot{}, err
	}
	ev, snap, err := c.Subscribe(dctx, hc.SubscribeParams{})
	if err != nil {
		c.Close()
		return nil, nil, hc.Snapshot{}, fmt.Errorf("events.subscribe: %w", err)
	}
	return c, ev, snap, nil
}

// follow applies events until the connection ends. A broken events channel
// on a live connection is subscribed again, which brings a fresh snapshot.
func (m *Manager) follow(ctx context.Context, c *hc.Conn, ev *hc.Events, seq int64) error {
	resyncs := 0
	for {
		n, err := ev.Recv(ctx)
		if err == nil && n.Method == "event" && n.Event != nil && n.Seq > seq {
			seq = n.Seq
			if err = m.apply(*n.Event); err == nil {
				resyncs = 0
			}
		}
		if err != nil {
			ev.Close()
			if ctx.Err() != nil || errors.Is(err, hc.ErrClosed) {
				return err
			}
			if resyncs++; resyncs > maxResyncs {
				return fmt.Errorf("events keep failing: %w", err)
			}
			m.log.Warn("events: subscribing again", "err", err)
			var snap hc.Snapshot
			if ev, snap, err = c.Subscribe(ctx, hc.SubscribeParams{}); err != nil {
				return fmt.Errorf("events.subscribe: %w", err)
			}
			seq = snap.Seq
			m.replace(snap)
			continue
		}
		switch n.Method {
		case "missed": // fell behind: the snapshot replaces what was skipped
			if n.Snapshot != nil {
				seq = n.Seq
				m.replace(*n.Snapshot)
			}
		case "heartbeat":
			seq = max(seq, n.Seq)
		}
	}
}

func (m *Manager) up(c *hc.Conn, snap hc.Snapshot) {
	h := c.Hello()
	m.mu.Lock()
	first := !m.synced
	m.conn, m.synced = c, true
	m.setStatusLocked(Status{Connected: true, Version: h.Version, Name: h.Core.Name})
	changes := m.replaceLocked(snap)
	m.mu.Unlock()
	if !first { // what changed while we were away
		m.notify(changes)
	}
}

func (m *Manager) down(err error) {
	m.mu.Lock()
	m.conn = nil
	m.setStatusLocked(Status{Error: err.Error()})
	m.mu.Unlock()
}

func (m *Manager) apply(ev hc.Event) error {
	m.mu.Lock()
	ch, ok, err := m.cache.Apply(ev)
	if ok {
		m.broadcastLocked(Update{Change: &ch})
	}
	m.mu.Unlock()
	if ok {
		m.notify([]Change{ch})
	}
	return err
}

func (m *Manager) replace(snap hc.Snapshot) {
	m.mu.Lock()
	changes := m.replaceLocked(snap)
	m.mu.Unlock()
	m.notify(changes)
}

func (m *Manager) replaceLocked(snap hc.Snapshot) []Change {
	next := NewCache(snap.Terminals)
	changes := Diff(m.cache, next)
	m.cache = next
	for i := range changes {
		m.broadcastLocked(Update{Change: &changes[i]})
	}
	return changes
}

func (m *Manager) setStatusLocked(st Status) {
	if st == m.status {
		return
	}
	m.status = st
	m.broadcastLocked(Update{Core: &st})
}

func (m *Manager) notify(changes []Change) {
	if m.o.OnChange == nil {
		return
	}
	for _, ch := range changes {
		m.o.OnChange(ch)
	}
}

// startServer runs `hc server start`, for systems where hc connect does
// not start the core by itself.
func (m *Manager) startServer(ctx context.Context) {
	path := m.o.HC
	if path == "" {
		p, err := hc.Locate("")
		if err != nil {
			return
		}
		path = p
	}
	sctx, cancel := context.WithTimeout(ctx, startTimeout)
	defer cancel()
	cmd := exec.CommandContext(sctx, path, "server", "start")
	env := m.o.Env
	if env == nil {
		env = os.Environ()
	}
	env = procutil.WithoutEnv(env, "HC_TERMINAL_ID")
	if m.o.Session != "" { // server start has no --session flag
		env = append(procutil.WithoutEnv(env, "HC_SESSION"), "HC_SESSION="+m.o.Session)
	}
	cmd.Env = env
	cmd.WaitDelay = time.Second
	procutil.HideWindow(cmd)
	out, err := cmd.CombinedOutput()
	m.log.Info("hc server start", "err", err, "output", strings.TrimSpace(string(out)))
}

// Status is the connection as it is now.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

// Terminals lists the cached terminals, oldest first. The records share
// their maps and slices with the cache and must not be modified.
func (m *Manager) Terminals() []hc.Terminal {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listLocked()
}

func (m *Manager) listLocked() []hc.Terminal {
	out := make([]hc.Terminal, 0, len(m.cache))
	for _, t := range m.cache {
		out = append(out, *t)
	}
	slices.SortFunc(out, func(a, b hc.Terminal) int {
		return cmp.Or(cmp.Compare(a.CreatedMs, b.CreatedMs), cmp.Compare(a.Address, b.Address))
	})
	return out
}

// Terminal is the cached record of addr; see Terminals about sharing.
func (m *Manager) Terminal(addr string) (hc.Terminal, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.cache[addr]
	if !ok {
		return hc.Terminal{}, false
	}
	return *t, true
}

func (m *Manager) current() *hc.Conn {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.conn
}

// Call calls the core, or fails with ErrUnavailable while disconnected.
func (m *Manager) Call(ctx context.Context, method string, params, result any) error {
	c := m.current()
	if c == nil {
		return ErrUnavailable
	}
	return c.Call(ctx, method, params, result)
}

// Attach attaches to a terminal; the stream ends with hc.ErrClosed when
// the connection does.
func (m *Manager) Attach(ctx context.Context, p hc.AttachParams) (*hc.Stream, hc.AttachResult, error) {
	c := m.current()
	if c == nil {
		return nil, hc.AttachResult{}, ErrUnavailable
	}
	return c.Attach(ctx, p)
}

// Watcher follows the manager: Terminals and Core are the state when the
// watch began, and C carries every update after it, in order. A watcher
// that falls more than its buffer behind is dropped and Lost closes; start
// a new watch for a fresh state.
type Watcher struct {
	C         <-chan Update
	Terminals []hc.Terminal
	Core      Status

	c    chan Update
	lost chan struct{}
	m    *Manager
}

// Watch starts a watcher that buffers up to buf updates.
func (m *Manager) Watch(buf int) *Watcher {
	c := make(chan Update, max(buf, 1))
	w := &Watcher{C: c, c: c, lost: make(chan struct{}), m: m}
	m.mu.Lock()
	defer m.mu.Unlock()
	w.Terminals, w.Core = m.listLocked(), m.status
	m.watchers[w] = struct{}{}
	return w
}

// Close stops the watcher. C is never closed.
func (w *Watcher) Close() {
	w.m.mu.Lock()
	delete(w.m.watchers, w)
	w.m.mu.Unlock()
}

// Lost is closed when the watcher was dropped for falling behind.
func (w *Watcher) Lost() <-chan struct{} { return w.lost }

// broadcastLocked never blocks: a full watcher is dropped instead.
func (m *Manager) broadcastLocked(u Update) {
	for w := range m.watchers {
		select {
		case w.c <- u:
		default:
			delete(m.watchers, w)
			close(w.lost)
		}
	}
}

// logWriter logs what hc writes to stderr, a line at a time.
type logWriter struct{ log *slog.Logger }

func (w logWriter) Write(p []byte) (int, error) {
	for line := range strings.SplitSeq(string(p), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			w.log.Warn("hc connect", "stderr", line)
		}
	}
	return len(p), nil
}
