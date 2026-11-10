package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
)

// Close codes of /ws/attach (spec §7.3), besides 1000, 1001, 1011 and 4401.
const (
	closeBadRequest  websocket.StatusCode = 4400 // the query is wrong
	closeNotFound    websocket.StatusCode = 4404 // no such terminal
	closeUnavailable websocket.StatusCode = 4409 // not now, as while the core brings a keep terminal back
	closeCoreLost    websocket.StatusCode = 4503 // the core is gone; attach again with resumed=1
)

const (
	defaultHistory = 1000
	maxHistory     = 10000
	maxWSMessage   = 1 << 20 // the most a browser may send in one message
	attachWatch    = 256     // core updates an attach socket may fall behind on before it watches again
)

// attachQuery is the query of /ws/attach.
type attachQuery struct {
	terminal         string // an address or a name
	cols, rows       int
	history          int
	observe, resumed bool
}

func parseAttachQuery(r *http.Request) (attachQuery, error) {
	q := attachQuery{terminal: r.URL.Query().Get("t")}
	if q.terminal == "" {
		return q, invalid("t에 터미널 주소가 필요합니다")
	}
	var err error
	if q.cols, err = queryInt(r, "cols", 0); err != nil {
		return q, err
	}
	if q.rows, err = queryInt(r, "rows", 0); err != nil {
		return q, err
	}
	if q.history, err = queryInt(r, "history", defaultHistory); err != nil {
		return q, err
	}
	if q.observe, err = queryBool(r, "observe"); err != nil {
		return q, err
	}
	if q.resumed, err = queryBool(r, "resumed"); err != nil {
		return q, err
	}
	q.cols, q.rows = clampSize(q.cols, defaultCols), clampSize(q.rows, defaultRows)
	q.history = min(q.history, maxHistory)
	return q, nil
}

// The messages of /ws/attach (spec §7.3). Output goes as binary messages.
type (
	attachedMsg struct {
		Type     string       `json:"type"`
		Terminal TerminalView `json:"terminal"`
		Cols     int          `json:"cols"`
		Rows     int          `json:"rows"`
	}
	sizeMsg struct {
		Type string `json:"type"`
		Cols int    `json:"cols"`
		Rows int    `json:"rows"`
	}
	closedMsg struct {
		Type     string `json:"type"`
		Reason   string `json:"reason"`
		ExitCode *int   `json:"exit_code"`
		Signal   *int   `json:"signal"`
	}
)

// attachment is one /ws/attach socket: a browser on a terminal.
type attachment struct {
	s      *Server
	c      *websocket.Conn
	q      attachQuery
	viewer string // this socket in Presence

	sizeMu     sync.Mutex // held while a size goes out, so two never cross
	cols, rows int        // the size the browser was told last
}

func (s *Server) handleAttachWS(w http.ResponseWriter, r *http.Request) {
	c, done, ok := s.acceptWS(w, r)
	if !ok {
		return
	}
	defer done()
	// A browser cannot read why an upgrade was refused, so a bad query is
	// told with a close code too.
	q, err := parseAttachQuery(r)
	if err != nil {
		c.Close(closeBadRequest, wsReason(errMessage(err)))
		return
	}
	c.SetReadLimit(maxWSMessage)
	a := &attachment{s: s, c: c, q: q, viewer: "v" + strconv.FormatInt(s.viewers.Add(1), 10)}
	a.run(r.Context())
}

// run attaches and passes bytes both ways until the browser or the stream
// ends. ctx is the request's, which ends only when the handler returns:
// reads and pings use it, since cancelling either one in flight closes the
// socket, and the socket must stay open to say why the stream ended.
func (a *attachment) run(ctx context.Context) {
	s, q := a.s, a.q
	// Watch before Attach, so no size change falls between them.
	wt := s.d.Core.Watch(attachWatch)
	st, res, err := s.d.Core.Attach(ctx, hc.AttachParams{
		Terminal: q.terminal, Cols: q.cols, Rows: q.rows, History: q.history,
		Observe: q.observe, Resumed: q.resumed,
		// An observer does not set the size, so it needs to hear it in
		// order with the output. The others follow the size events.
		ResizeNotifications: q.observe,
	})
	if err != nil {
		wt.Close()
		a.refuse(ctx, err)
		return
	}
	defer st.Close()
	addr := res.Terminal.Address
	defer s.d.Presence.Remove(addr, a.viewer)
	a.cols, a.rows = q.cols, q.rows
	if res.Terminal.Cols > 0 && res.Terminal.Rows > 0 {
		a.cols, a.rows = res.Terminal.Cols, res.Terminal.Rows
	}
	if err := writeWS(ctx, a.c, attachedMsg{Type: "attached", Terminal: s.view(res.Terminal), Cols: a.cols, Rows: a.rows}); err != nil {
		wt.Close()
		a.c.CloseNow()
		return
	}

	sctx, cancel := context.WithCancel(ctx) // ends when the browser does
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); defer cancel(); a.input(ctx, st, addr) }()
	go func() { defer wg.Done(); a.followSize(sctx, wt, addr) }()
	go func() { defer wg.Done(); keepAlive(ctx, stop, a.c) }()

	err = a.pump(sctx, st)
	switch {
	case errors.Is(err, errBrowser), sctx.Err() != nil:
		a.c.CloseNow() // the browser went away, or the hub is closing the socket
	default:
		code, msg := closeCodeFor(err, res.Terminal.Keep)
		if code == websocket.StatusInternalError {
			s.log.Warn("attach stream failed", "terminal", addr, "err", err)
		}
		a.end(ctx, code, msg, endReason(err))
	}
	close(stop)
	cancel()
	wg.Wait()
}

// errBrowser reports that the browser stopped taking output.
var errBrowser = errors.New("browser stopped reading")

// pump passes output to the browser until the stream ends, and says why
// it ended.
func (a *attachment) pump(ctx context.Context, st *hc.Stream) error {
	for {
		m, err := st.Recv(ctx)
		if err != nil {
			return err
		}
		if m.Size != nil {
			if a.sendSize(ctx, m.Size.Cols, m.Size.Rows) != nil {
				return errBrowser
			}
			continue
		}
		if writeBinary(ctx, a.c, m.Data) != nil {
			return errBrowser
		}
		st.Credit(len(m.Data)) // fails only after the stream has ended, which Recv says next
	}
}

// sendSize tells the browser the terminal's size, unless it knows it.
func (a *attachment) sendSize(ctx context.Context, cols, rows int) error {
	a.sizeMu.Lock()
	defer a.sizeMu.Unlock()
	if cols <= 0 || rows <= 0 || cols == a.cols && rows == a.rows {
		return nil
	}
	a.cols, a.rows = cols, rows
	return writeWS(ctx, a.c, sizeMsg{Type: "size", Cols: cols, Rows: rows})
}

// followSize tells the browser when another viewer changes the size. The
// core reports it as an event, which the core manager passes on.
func (a *attachment) followSize(ctx context.Context, wt *core.Watcher, addr string) {
	defer func() { wt.Close() }()
	for {
		select {
		case <-ctx.Done():
			return
		case <-wt.Lost(): // fell behind: start again from what the cache holds now
			wt.Close()
			wt = a.s.d.Core.Watch(attachWatch)
			for _, t := range wt.Terminals {
				if t.Address == addr && a.sendSize(ctx, t.Cols, t.Rows) != nil {
					return
				}
			}
		case u := <-wt.C:
			if ch := u.Change; ch != nil && ch.Address == addr && ch.New != nil {
				if a.sendSize(ctx, ch.New.Cols, ch.New.Rows) != nil {
					return
				}
			}
		}
	}
}

// input passes what the browser sends to the stream. An observer only
// watches: its keys, sizes and display facts stop here, though its focus
// still counts in Presence. What cannot be read is dropped, and so is a
// write the stream refuses once it has ended.
func (a *attachment) input(ctx context.Context, st *hc.Stream, addr string) {
	for {
		typ, b, err := a.c.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			if !a.q.observe {
				st.Write(b)
			}
			continue
		}
		var m struct {
			Type    string `json:"type"`
			Cols    int    `json:"cols"`
			Rows    int    `json:"rows"`
			Focused bool   `json:"focused"`
			hc.Display
		}
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		switch m.Type {
		case "resize":
			if !a.q.observe && m.Cols > 0 && m.Rows > 0 {
				st.Resize(clampSize(m.Cols, defaultCols), clampSize(m.Rows, defaultRows))
			}
		case "focus":
			a.s.d.Presence.Set(addr, a.viewer, m.Focused)
			if !a.q.observe {
				st.Focus(m.Focused)
			}
		case "display":
			if !a.q.observe {
				st.Facts(m.Display)
			}
		case "ping": // is the socket alive? (spec §3 #178)
			if writeWS(ctx, a.c, map[string]string{"type": "pong"}) != nil {
				return
			}
		}
	}
}

// refuse closes the socket of an attach the core turned down, with the
// code that tells the browser what to do next.
func (a *attachment) refuse(ctx context.Context, err error) {
	switch kind := hc.KindOf(err); {
	case errors.Is(err, core.ErrUnavailable), kind == "core_unavailable":
		a.c.Close(closeCoreLost, "코어에 연결되어 있지 않습니다")
	case kind == "not_found", kind == "machine_unknown":
		a.c.Close(closeNotFound, wsReason(errMessage(err)))
	case kind == "unavailable":
		a.c.Close(closeUnavailable, wsReason(errMessage(err)))
	case kind == "invalid_params":
		a.c.Close(closeBadRequest, wsReason(errMessage(err)))
	case kind == "finished":
		// For good: a keep terminal the core will bring back is refused as
		// unavailable instead.
		reason := "finished"
		t, _ := a.s.finishedRecord(ctx, a.q.terminal)
		if t.Reason != nil {
			reason = *t.Reason
		}
		a.end(ctx, websocket.StatusNormalClosure, &closedMsg{Type: "closed", Reason: reason, ExitCode: t.ExitCode, Signal: t.Signal}, reason)
	default:
		a.s.log.Warn("attach refused", "terminal", a.q.terminal, "err", err)
		a.c.Close(websocket.StatusInternalError, wsReason(errMessage(err)))
	}
}

// finishedRecord is the record of a terminal the core refused as finished.
// The core is asked first, since the cache may not have heard yet.
func (s *Server) finishedRecord(ctx context.Context, addr string) (hc.Terminal, bool) {
	var t hc.Terminal
	if s.d.Core.Call(ctx, "terminal.get", map[string]any{"terminal": addr}, &t) == nil {
		return t, true
	}
	return s.d.Core.Terminal(addr)
}

// end says why the socket closes: msg first when there is one, then code.
func (a *attachment) end(ctx context.Context, code websocket.StatusCode, msg *closedMsg, reason string) {
	if msg != nil {
		if writeWS(ctx, a.c, msg) != nil {
			a.c.CloseNow()
			return
		}
	}
	a.c.Close(code, wsReason(reason))
}

// closeCodeFor is how a socket closes after its stream ended with err
// (spec §6.8). A keep terminal that the core brings back after anything
// but an exit or a kill closes with 4409, and the browser attaches again
// later; any other end of the program is told in a closed message, then
// 1000. A lost core is 4503.
func closeCodeFor(err error, keep bool) (websocket.StatusCode, *closedMsg) {
	var ce *hc.ClosedError
	switch {
	case errors.As(err, &ce):
		if keep && ce.Reason != "exited" && ce.Reason != "killed" {
			return closeUnavailable, nil
		}
		return websocket.StatusNormalClosure, &closedMsg{Type: "closed", Reason: ce.Reason, ExitCode: ce.ExitCode, Signal: ce.Signal}
	case errors.Is(err, hc.ErrClosed), errors.Is(err, core.ErrUnavailable):
		return closeCoreLost, nil
	}
	return websocket.StatusInternalError, nil
}

// endReason is the close reason for a stream that ended with err.
func endReason(err error) string {
	var ce *hc.ClosedError
	switch {
	case errors.As(err, &ce):
		return ce.Reason
	case errors.Is(err, hc.ErrClosed), errors.Is(err, core.ErrUnavailable):
		return "코어와의 연결이 끊겼습니다"
	}
	return "스트림이 끊겼습니다: " + err.Error()
}

// wsReason fits s in a close frame, which has room for 123 bytes.
func wsReason(s string) string {
	const maxReason = 123
	if len(s) <= maxReason {
		return s
	}
	n := maxReason
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
