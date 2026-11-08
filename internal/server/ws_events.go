package server

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	pingEvery    = 30 * time.Second
	writeTimeout = 10 * time.Second
)

// handleEventsWS streams changes to the browser (spec §7.2). The browser
// sends nothing on it.
func (s *Server) handleEventsWS(w http.ResponseWriter, r *http.Request) {
	c, done, ok := s.acceptWS(w, r)
	if !ok {
		return
	}
	defer done()
	ctx := c.CloseRead(r.Context())
	tick := time.NewTicker(pingEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			c.CloseNow()
			return
		case <-tick.C:
			if err := writeWS(ctx, c, map[string]string{"type": "ping"}); err != nil {
				c.CloseNow()
				return
			}
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
