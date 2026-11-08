package server

import (
	"net/http"
	"sync"

	"github.com/coder/websocket"
)

// closeUnauthorized tells the browser to pair again (spec §7.3).
const closeUnauthorized websocket.StatusCode = 4401

// hub knows each device's open WebSockets, so revoking a device closes
// them at once.
type hub struct {
	mu    sync.Mutex
	conns map[string]map[*hubConn]struct{}
}

type hubConn struct {
	close func(code websocket.StatusCode, reason string)
}

func newHub() *hub { return &hub{conns: map[string]map[*hubConn]struct{}{}} }

// add registers a socket of deviceID; call remove when it ends.
func (h *hub) add(deviceID string, close func(code websocket.StatusCode, reason string)) (remove func()) {
	c := &hubConn{close: close}
	h.mu.Lock()
	if h.conns[deviceID] == nil {
		h.conns[deviceID] = map[*hubConn]struct{}{}
	}
	h.conns[deviceID][c] = struct{}{}
	h.mu.Unlock()
	return func() {
		h.mu.Lock()
		delete(h.conns[deviceID], c)
		if len(h.conns[deviceID]) == 0 {
			delete(h.conns, deviceID)
		}
		h.mu.Unlock()
	}
}

// closeDevice closes every socket of deviceID with 4401. It does not wait
// for the close handshakes, which can take seconds each.
func (h *hub) closeDevice(deviceID string) {
	h.mu.Lock()
	cs := h.conns[deviceID]
	delete(h.conns, deviceID)
	h.mu.Unlock()
	for c := range cs {
		go c.close(closeUnauthorized, "device revoked")
	}
}

// acceptWS upgrades the request and registers the socket with the hub. When
// the device is not paired, or is revoked while this runs, it closes the
// socket with 4401 and reports false. Call done when the socket ends.
func (s *Server) acceptWS(w http.ResponseWriter, r *http.Request) (c *websocket.Conn, done func(), ok bool) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // requireDevice has checked Origin, X-Forwarded-Host included
	})
	if err != nil {
		return nil, nil, false // Accept has written the HTTP error
	}
	dev, paired := deviceFrom(r.Context())
	if !paired {
		c.Close(closeUnauthorized, "not paired")
		return nil, nil, false
	}
	remove := s.hub.add(dev.ID, func(code websocket.StatusCode, reason string) { c.Close(code, reason) })
	if !s.stillPaired(dev.ID) { // revoked between the cookie check and add
		remove()
		c.Close(closeUnauthorized, "device revoked")
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
