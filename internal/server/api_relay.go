package server

import (
	"crypto/ecdh"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/kwonikhyeon/mori/internal/push"
)

// maxRelayPush is the most a relayed notification may be: webpush pads a
// message to a 4096-byte record (spec §3 #166).
const maxRelayPush = 8 << 10

// handleRelay takes a notification a linked host sent to this hub's relay
// subscription and sends it on to this hub's own subscriptions (spec §3 #166).
// It needs no cookie: the secret path is the credential, so it is never logged.
func (s *Server) handleRelay(w http.ResponseWriter, r *http.Request) {
	var (
		id         string
		key        *ecdh.PrivateKey
		authSecret []byte
		ok         bool
	)
	if s.d.Links != nil {
		id, key, authSecret, ok = s.d.Links.Relay(r.PathValue("secret"))
	}
	if !ok { // 410 makes the host's notifier forget the subscription
		writeError(w, errorf(http.StatusGone, "not_found", "그런 알림 중계가 없습니다"))
		return
	}
	if s.d.Push == nil {
		writeError(w, errorf(http.StatusServiceUnavailable, "unavailable", "이 서버는 알림을 보내지 않습니다"))
		return
	}
	if r.Header.Get("Content-Encoding") != "aes128gcm" {
		writeError(w, errorf(http.StatusBadRequest, "invalid_params", "중계 알림은 Content-Encoding: aes128gcm이어야 합니다"))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRelayPush))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, errorf(http.StatusRequestEntityTooLarge, "too_large", "중계 알림은 %d KiB까지입니다", maxRelayPush>>10))
			return
		}
		writeError(w, errorf(http.StatusBadRequest, "invalid_params", "중계 알림을 읽지 못했습니다"))
		return
	}
	plain, err := push.Decrypt(body, key, authSecret)
	var p push.Payload
	if err == nil {
		err = json.Unmarshal(plain, &p)
	}
	if err != nil {
		s.log.Info("relayed notification unreadable", "host", id)
		writeError(w, errorf(http.StatusBadRequest, "invalid_params", "중계 알림을 풀지 못했습니다"))
		return
	}
	if q, k, ok := push.Relayed(id, p); ok {
		s.d.Push.Forward(k, q)
	}
	w.WriteHeader(http.StatusCreated)
}
