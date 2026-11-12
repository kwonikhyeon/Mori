package server

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/peer"
)

const (
	// maxRelayBody is the most the hub passes on to a host: a whole upload
	// and its multipart framing (spec §3 #162).
	maxRelayBody = maxUpload + 2<<20

	// closeUnknownHost and closeHostUnreachable refuse a relayed socket
	// (spec §3 #164). A host that no longer takes the hub is
	// closeUnauthorized, as an unpaired phone is.
	closeUnknownHost     websocket.StatusCode = 4404
	closeHostUnreachable websocket.StatusCode = 4502

	// maxCloseReason is the longest reason a close frame has room for.
	maxCloseReason = 123
)

// proxied are the APIs a phone reaches on another host through the hub,
// as /h/<ID><path> (spec §3 #161). Pairing, devices, the host list and
// push subscriptions are the hub's own.
var proxied = []string{
	"GET /api/hello",
	"GET /api/overview",
	"GET /api/folders",
	"POST /api/folders",
	"PATCH /api/folders/{id}",
	"DELETE /api/folders/{id}",
	"GET /api/fs",
	"GET /api/folders/{id}/git",
	"GET /api/folders/{id}/branches",
	"POST /api/folders/{id}/worktrees",
	"DELETE /api/folders/{id}/worktrees",
	"GET /api/git/status",
	"GET /api/git/diff",
	"GET /api/git/log",
	"GET /api/git/commit",
	"POST /api/git/fetch",
	"GET /api/terminals",
	"POST /api/terminals",
	"GET /api/terminals/{t}",
	"PATCH /api/terminals/{t}",
	"DELETE /api/terminals/{t}",
	"POST /api/terminals/{t}/send",
	"POST /api/terminals/{t}/keys",
	"POST /api/terminals/{t}/reject",
	"POST /api/terminals/{t}/interrupt",
	"POST /api/terminals/{t}/kill",
	"POST /api/terminals/{t}/files",
	"GET /api/terminals/{t}/text",
	"GET /api/terminals/{t}/commands",
	"GET /api/terminals/{t}/prompts",
	"GET /api/presets",
	"PUT /api/presets",
	"GET /api/push/settings",
	"PUT /api/push/settings",
	"GET /ws/events",
	"GET /ws/attach",
}

// forwardedHeaders are all a host sees of the phone's request headers, and
// upgradeHeaders a socket's on top of them. The hub sets Cookie, Origin
// and User-Agent itself (spec §3 #162).
var (
	forwardedHeaders = []string{"Accept", "Content-Type"}
	upgradeHeaders   = []string{"Connection", "Upgrade", "Sec-WebSocket-Key", "Sec-WebSocket-Version",
		"Sec-WebSocket-Extensions", "Sec-WebSocket-Protocol"}
)

// droppedHeaders never reach the phone from a host: its cookie, and the
// security headers the hub sets for itself.
var droppedHeaders = []string{"Set-Cookie", "Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy"}

var (
	errUnlinked      = errors.New("host answered 401")
	errHostUnlinked  = errorf(http.StatusConflict, "host_unlinked", "이 호스트와의 연결이 끊겼습니다. 허브에서 다시 연결하세요")
	errRelayTooLarge = errorf(http.StatusRequestEntityTooLarge, "too_large", "요청 본문이 %d MiB를 넘습니다", maxRelayBody>>20)
)

type proxyKey struct{}

// proxyTarget is where one relayed request goes, for the proxy's hooks.
type proxyTarget struct {
	peer.Target
	tw *tunnelWriter
	ws bool
}

func (s *Server) newProxy() *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite:        s.rewrite,
		Transport:      s.d.Links.Transport(),
		ModifyResponse: s.modifyResponse,
		ErrorHandler:   s.proxyError,
		ErrorLog:       slog.NewLogLogger(s.log.Handler(), slog.LevelDebug),
	}
}

// serveProxy relays a request under /h/<ID> to that host, as the hub's
// own device there (spec §3 #161~#164).
func (s *Server) serveProxy(w http.ResponseWriter, r *http.Request) {
	ws := isWS(r.URL.Path)
	if s.proxy == nil {
		refuse(w, r, ws, closeUnknownHost, errorf(http.StatusServiceUnavailable, "unavailable", "이 서버는 다른 호스트로 잇지 않습니다"))
		return
	}
	dev, paired := deviceFrom(r.Context())
	if !paired { // requireDevice lets only sockets through unpaired
		refuseWS(w, r, closeUnauthorized, "페어링되지 않은 기기입니다")
		return
	}
	t, ok := s.d.Links.Target(r.PathValue("host"))
	switch {
	case !ok:
		refuse(w, r, ws, closeUnknownHost, errorf(http.StatusNotFound, "not_found", "그런 호스트가 없습니다: %s", r.PathValue("host")))
		return
	case t.Token == "":
		refuse(w, r, ws, closeUnauthorized, errHostUnlinked)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	tw := &tunnelWriter{ResponseWriter: w}
	if ws {
		// Revoking the device or stopping the hub cuts the tunnel without a
		// close code: the hub has no say inside it.
		remove, ok := s.hub.add(dev.ID, func(websocket.StatusCode, string) { cancel(); tw.close() })
		if !ok {
			refuseWS(w, r, websocket.StatusGoingAway, goingAway)
			return
		}
		defer remove()
		if !s.stillPaired(dev.ID) {
			refuseWS(w, r, closeUnauthorized, "기기가 철회되었습니다")
			return
		}
	}
	if r.ContentLength > maxRelayBody {
		writeError(w, errRelayTooLarge)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRelayBody) // w itself: the connection then closes after the 413
	s.proxy.ServeHTTP(tw, r.WithContext(context.WithValue(ctx, proxyKey{}, &proxyTarget{Target: t, tw: tw, ws: ws})))
}

// rewrite sends the request to the host with the hub's credentials there.
// Of the phone's headers only the content ones go on, and a socket's.
func (s *Server) rewrite(pr *httputil.ProxyRequest) {
	t := pr.In.Context().Value(proxyKey{}).(*proxyTarget)
	p := stripHost(pr.In.URL.EscapedPath())  // keeps %2F in a terminal's address
	pr.Out.URL.Path, _ = url.PathUnescape(p) // an escaped path always unescapes
	pr.Out.URL.RawPath = p
	pr.SetURL(t.Base)
	h := make(http.Header)
	keep := func(names []string) {
		for _, k := range names {
			for _, v := range pr.Out.Header.Values(k) {
				h.Add(k, v)
			}
		}
	}
	keep(forwardedHeaders)
	if t.ws {
		keep(upgradeHeaders)
	}
	h.Set("Cookie", (&http.Cookie{Name: auth.CookieName, Value: t.Token}).String())
	h.Set("Origin", t.Base.Scheme+"://"+t.Base.Host)
	h.Set("User-Agent", s.d.Links.UserAgent())
	pr.Out.Header = h
}

// modifyResponse keeps the host's cookie and security headers from the
// phone. A 401 means the host revoked the hub. A socket the host opened
// ends for the phone as soon as the host ends it.
func (s *Server) modifyResponse(res *http.Response) error {
	for _, k := range droppedHeaders {
		res.Header.Del(k)
	}
	t := res.Request.Context().Value(proxyKey{}).(*proxyTarget)
	if res.StatusCode == http.StatusUnauthorized {
		s.d.Links.MarkUnlinked(t.ID, t.Token)
		return errUnlinked
	}
	if rwc, ok := res.Body.(io.ReadWriteCloser); ok && res.StatusCode == http.StatusSwitchingProtocols {
		res.Body = &tunnelBody{ReadWriteCloser: rwc, tw: t.tw}
	} else if res.Header.Get("Content-Type") != "" {
		// Every relayed route answers JSON. A host that says HTML or script
		// would otherwise run it in the hub's origin, with the hub's cookie (spec §3 #245).
		res.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	return nil
}

// proxyError answers when the hub could not ask the host, or the host
// would not have the hub. r is the request to the host, which still has
// the socket headers, so a socket is refused with a close code.
func (s *Server) proxyError(w http.ResponseWriter, r *http.Request, err error) {
	t := r.Context().Value(proxyKey{}).(*proxyTarget)
	var mbe *http.MaxBytesError
	switch {
	case t.tw.hijacked(): // a tunnel ran and ended; no one is left to answer
		s.log.Debug("relay tunnel ended", "host", t.ID, "err", err)
	case errors.Is(err, context.Canceled) && r.Context().Err() != nil: // the phone left or was cut off
	case errors.Is(err, errUnlinked):
		refuse(w, r, t.ws, closeUnauthorized, errHostUnlinked)
	case errors.As(err, &mbe):
		writeError(w, errRelayTooLarge)
	default:
		s.log.Info("host unreachable", "host", t.ID, "err", err)
		refuse(w, r, t.ws, closeHostUnreachable, errorf(http.StatusBadGateway, "host_unreachable", "%s에 닿지 못했습니다", t.Name))
	}
}

// refuse turns down a relayed request: with an error body, or a socket
// with a close code the UI acts on (spec §3 #164).
func refuse(w http.ResponseWriter, r *http.Request, ws bool, code websocket.StatusCode, e *apiError) {
	if ws {
		refuseWS(w, r, code, e.Message)
		return
	}
	writeError(w, e)
}

func refuseWS(w http.ResponseWriter, r *http.Request, code websocket.StatusCode, reason string) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // requireDevice has checked Origin
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	c.Close(code, closeReason(reason))
}

// closeReason fits msg in a close frame, cut at a rune boundary. A longer
// reason makes Close fail without sending the frame at all.
func closeReason(msg string) string {
	msg = strings.ToValidUTF8(msg, "")
	if len(msg) > maxCloseReason {
		msg = msg[:maxCloseReason]
		for !utf8.ValidString(msg) {
			msg = msg[:len(msg)-1]
		}
	}
	return msg
}

// stripHost is the host's own path for a relayed one: /h/<ID>/api/hello
// is /api/hello there.
func stripHost(p string) string {
	_, rest, ok := strings.Cut(strings.TrimPrefix(p, "/h/"), "/")
	if !ok {
		return "/"
	}
	return "/" + rest
}

// tunnelWriter is the phone's side of a relayed request. close cuts the
// phone's connection once it is hijacked for a tunnel, at once if it
// already is.
type tunnelWriter struct {
	http.ResponseWriter
	mu   sync.Mutex
	conn net.Conn
	done bool
}

func (t *tunnelWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	c, rw, err := http.NewResponseController(t.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.conn = c
	if t.done {
		c.Close()
	}
	return c, rw, nil
}

func (t *tunnelWriter) Unwrap() http.ResponseWriter { return t.ResponseWriter }

func (t *tunnelWriter) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.done = true
	if t.conn != nil {
		t.conn.Close()
	}
}

func (t *tunnelWriter) hijacked() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.conn != nil
}

// tunnelBody is the host's side of a tunnel. When the host ends it, the
// phone's side is cut too, once the host's last bytes (its close frame)
// are on their way. Without this the proxy only half-closes the phone's
// connection and waits for a phone that may never answer. It has no
// CloseWrite, as the body it wraps has none.
type tunnelBody struct {
	io.ReadWriteCloser
	tw  *tunnelWriter
	err error
}

func (b *tunnelBody) Read(p []byte) (int, error) {
	if b.err != nil {
		b.tw.close()
		return 0, b.err
	}
	n, err := b.ReadWriteCloser.Read(p)
	if err != nil && n > 0 {
		b.err = err // hand over the bytes first
		return n, nil
	}
	if err != nil {
		b.tw.close()
	}
	return n, err
}
