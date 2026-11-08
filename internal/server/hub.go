package server

import (
	"context"
	"net/http"
	"sync"

	"github.com/coder/websocket"
)

// closeUnauthorized tells the browser to pair again (spec §7.3).
const closeUnauthorized websocket.StatusCode = 4401

// goingAway is the reason sockets close with while Mori stops.
const goingAway = "서버를 끄는 중입니다"

// hub knows each device's open WebSockets, so revoking a device closes
// them at once, and so does stopping the server.
type hub struct {
	mu     sync.Mutex
	conns  map[string]map[*hubConn]struct{}
	closed bool
	wg     sync.WaitGroup // one per registered socket
}

type hubConn struct {
	close func(code websocket.StatusCode, reason string)
}

func newHub() *hub { return &hub{conns: map[string]map[*hubConn]struct{}{}} }

// add registers a socket of deviceID; call remove when it ends. It reports
// false once closeAll has run.
func (h *hub) add(deviceID string, close func(code websocket.StatusCode, reason string)) (remove func(), ok bool) {
	c := &hubConn{close: close}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, false
	}
	if h.conns[deviceID] == nil {
		h.conns[deviceID] = map[*hubConn]struct{}{}
	}
	h.conns[deviceID][c] = struct{}{}
	h.wg.Add(1)
	return sync.OnceFunc(func() {
		h.mu.Lock()
		delete(h.conns[deviceID], c)
		if len(h.conns[deviceID]) == 0 {
			delete(h.conns, deviceID)
		}
		h.mu.Unlock()
		h.wg.Done()
	}), true
}

// closeDevice closes every socket of deviceID with 4401. It does not wait
// for the close handshakes, which can take seconds each.
func (h *hub) closeDevice(deviceID string) {
	h.mu.Lock()
	cs := h.conns[deviceID]
	delete(h.conns, deviceID)
	h.mu.Unlock()
	for c := range cs {
		go c.close(closeUnauthorized, "기기가 철회되었습니다")
	}
}

// closeAll closes every socket, refuses new ones, and waits until their
// handlers have ended or ctx is done.
func (h *hub) closeAll(ctx context.Context, code websocket.StatusCode, reason string) {
	h.mu.Lock()
	h.closed = true
	var cs []*hubConn
	for _, m := range h.conns {
		for c := range m {
			cs = append(cs, c)
		}
	}
	h.mu.Unlock()
	for _, c := range cs {
		go c.close(code, reason)
	}
	done := make(chan struct{})
	go func() { h.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// CloseSockets closes every WebSocket with 1001 and refuses new ones, then
// waits until their handlers have ended or ctx is done. Call it before
// stopping the core manager, or attached browsers hear 4503 and wait for a
// core that is not coming back.
func (s *Server) CloseSockets(ctx context.Context) {
	s.hub.closeAll(ctx, websocket.StatusGoingAway, goingAway)
}

// acceptWS upgrades the request and registers the socket with the hub. When
// the device is not paired, or is revoked while this runs, it closes the
// socket with 4401 and reports false; while the server stops, with 1001.
// Call done when the socket ends.
func (s *Server) acceptWS(w http.ResponseWriter, r *http.Request) (c *websocket.Conn, done func(), ok bool) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // requireDevice has checked Origin, X-Forwarded-Host included
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, nil, false // Accept has written the HTTP error
	}
	dev, paired := deviceFrom(r.Context())
	if !paired {
		c.Close(closeUnauthorized, "페어링되지 않은 기기입니다")
		return nil, nil, false
	}
	remove, ok := s.hub.add(dev.ID, func(code websocket.StatusCode, reason string) { c.Close(code, reason) })
	if !ok {
		c.Close(websocket.StatusGoingAway, goingAway)
		return nil, nil, false
	}
	if !s.stillPaired(dev.ID) { // revoked between the cookie check and add
		remove()
		c.Close(closeUnauthorized, "기기가 철회되었습니다")
		return nil, nil, false
	}
	return c, remove, true
}

func (s *Server) stillPaired(id string) bool {
	for _, d := range s.d.Auth.Devices() {
		if d.ID == id {
			return true
		}
	}
	return false
}
