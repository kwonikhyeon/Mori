package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
)

const (
	// answerHold is how long a question refuses a second answer after the
	// first went in: the program may take a moment to say it moved on.
	answerHold = 2 * time.Second
	// rejectWait is how long a reject waits, after Esc, for the program to
	// put its question away before it types the instruction.
	rejectWait = 5 * time.Second
	rejectPoll = 100 * time.Millisecond
)

var (
	errAskChanged = &apiError{Status: http.StatusConflict, Kind: "changed",
		Message: "질문이 바뀌었습니다. 화면을 보고 다시 고르세요"}
	errAnswered = &apiError{Status: http.StatusConflict, Kind: "answered",
		Message: "이 질문에는 방금 답이 갔습니다"}
	errStillBlocked = &apiError{Status: http.StatusConflict, Kind: "blocked",
		Message: "Esc를 보냈지만 아직 승인 대기입니다. 화면을 보고 키로 응답하세요"}
)

// answers holds the questions being answered, so that two devices do not
// answer one question twice (spec §3 #194): the second answer would land
// on whatever the program asks next.
type answers struct {
	mu   sync.Mutex
	held map[answerKey]heldAnswer
}

type answerKey struct{ addr, ask string }

type heldAnswer struct {
	busy  bool      // its keys are going in
	until time.Time // once they went, another answer is refused until then
}

// take claims k. It is false while another answer to k goes in or has
// just gone.
func (a *answers) take(k answerKey, now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if h, ok := a.held[k]; ok && (h.busy || now.Before(h.until)) {
		return false
	}
	for old, h := range a.held {
		if !h.busy && !now.Before(h.until) {
			delete(a.held, old)
		}
	}
	if a.held == nil {
		a.held = map[answerKey]heldAnswer{}
	}
	a.held[k] = heldAnswer{busy: true}
	return true
}

// done ends the claim on k. An answer that went in holds k a moment
// longer; one that did not lets it go, to be tried again.
func (a *answers) done(k answerKey, sent bool, now time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if sent {
		a.held[k] = heldAnswer{until: now.Add(answerHold)}
	} else {
		delete(a.held, k)
	}
}

// answer presses keys as the answer to ask, the question the device saw
// addr ask. The core's record, not the cache, says what it asks now.
func (s *Server) answer(ctx context.Context, addr, ask string, keys []string) (json.RawMessage, error) {
	k := answerKey{addr, ask}
	if !s.answers.take(k, time.Now()) {
		return nil, errAnswered
	}
	sent := false
	defer func() { s.answers.done(k, sent, time.Now()) }()
	var t hc.Terminal
	if err := s.d.Core.Call(ctx, "terminal.get", map[string]any{"terminal": addr}, &t); err != nil {
		return nil, err
	}
	if t.State != "live" {
		return nil, errorf(http.StatusConflict, "finished", "프로그램이 이미 끝났습니다")
	}
	if core.AskID(t) != ask {
		return nil, errAskChanged
	}
	var res json.RawMessage
	if err := s.d.Core.Call(ctx, "terminal.keys", map[string]any{"terminal": addr, "keys": keys}, &res); err != nil {
		return nil, err
	}
	sent = true
	return res, nil
}

// handleReject answers a question with Esc, waits for the program to put
// it away, then sends text as what to do instead (spec §3 #195).
func (s *Server) handleReject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text   string `json:"text"`
		Expect string `json:"expect"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	switch {
	case strings.TrimSpace(req.Text) == "":
		writeError(w, invalid("보낼 text가 없습니다"))
		return
	case req.Expect == "":
		writeError(w, invalid("거절할 질문(expect)이 없습니다"))
		return
	}
	addr := terminalParam(r)
	if _, err := s.answer(r.Context(), addr, req.Expect, []string{"esc"}); err != nil {
		writeError(w, err)
		return
	}
	if err := s.waitUnblocked(r.Context(), addr); err != nil {
		writeError(w, err)
		return
	}
	s.relay(w, r, "terminal.send", map[string]any{"terminal": addr, "text": req.Text})
}

// waitUnblocked waits until addr no longer asks anything: it answered, it
// exited, or s.unblock passed, which is an error.
func (s *Server) waitUnblocked(ctx context.Context, addr string) error {
	deadline := time.Now().Add(s.unblock)
	for {
		t, err := s.terminal(ctx, addr)
		if err != nil {
			return err
		}
		if t.State != "live" || t.Status == nil || t.Status.State != "blocked" {
			return nil
		}
		if !time.Now().Before(deadline) {
			return errStillBlocked
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(rejectPoll):
		}
	}
}
