package server

import (
	"net/http"

	"github.com/kwonikhyeon/mori/internal/push"
	"github.com/kwonikhyeon/mori/internal/store"
)

// pushSubJSON is a subscription as the API shows it to its device: without
// the keys, which only the push service needs.
type pushSubJSON struct {
	ID        string   `json:"id"`
	Endpoint  string   `json:"endpoint"`
	Kinds     []string `json:"kinds"`
	CreatedMs int64    `json:"created_ms"`
}

func pushSubView(s store.PushSub) pushSubJSON {
	return pushSubJSON{ID: s.ID, Endpoint: s.Endpoint, Kinds: push.KindsOf(s), CreatedMs: s.CreatedMs}
}

// needPush answers 503 for a push API on a server that sends no
// notifications.
func (s *Server) needPush(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.d.Push == nil {
			writeError(w, errorf(http.StatusServiceUnavailable, "unavailable", "이 서버는 알림을 보내지 않습니다"))
			return
		}
		h(w, r)
	}
}

// handlePushKey gives the host's VAPID public key, the applicationServerKey
// a browser subscribes with.
func (s *Server) handlePushKey(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"key": s.d.Store.Get().VAPID.Public})
}

// handlePushSubs lists the calling device's subscriptions.
func (s *Server) handlePushSubs(w http.ResponseWriter, r *http.Request) {
	dev, _ := deviceFrom(r.Context())
	out := []pushSubJSON{}
	for _, p := range s.d.Push.Subscriptions(dev.ID) {
		out = append(out, pushSubView(p))
	}
	writeJSON(w, http.StatusOK, out)
}

// handleSubscribe keeps the browser's subscription for the calling device,
// in place of the one it had.
func (s *Server) handleSubscribe(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Subscription *push.Subscription `json:"subscription"`
		Kinds        []push.Kind        `json:"kinds"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	if req.Subscription == nil {
		writeError(w, invalid("subscription이 필요합니다: 브라우저의 PushSubscription.toJSON()을 보내세요"))
		return
	}
	dev, _ := deviceFrom(r.Context())
	p, err := s.d.Push.Subscribe(dev.ID, *req.Subscription, req.Kinds)
	if err != nil {
		writeError(w, err)
		return
	}
	s.log.Info("push subscribed", "device", dev.ID, "subscription", p.ID, "kinds", p.Kinds)
	writeJSON(w, http.StatusCreated, pushSubView(p))
}

// handleUnsubscribe forgets the calling device's subscription to the
// endpoint in the body, or all of them when it names none.
func (s *Server) handleUnsubscribe(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	dev, _ := deviceFrom(r.Context())
	if err := s.d.Push.Unsubscribe(dev.ID, req.Endpoint); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handlePushTest sends a test notification to the calling device and
// waits for the push service's answer, so the UI can say what went wrong.
func (s *Server) handlePushTest(w http.ResponseWriter, r *http.Request) {
	dev, _ := deviceFrom(r.Context())
	n, err := s.d.Push.Test(r.Context(), dev.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"sent": n})
}

func (s *Server) handleGetPushSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.d.Store.Get().Notify)
}

// handlePutPushSettings replaces the host's notification settings, which
// every device shares.
func (s *Server) handlePutPushSettings(w http.ResponseWriter, r *http.Request) {
	var n store.Notify
	if err := readJSON(w, r, &n); err != nil {
		writeError(w, err)
		return
	}
	if err := s.d.Store.Update(func(st *store.State) error {
		st.Notify = n
		return nil
	}); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}
