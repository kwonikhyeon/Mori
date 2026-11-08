package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"strings"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/gitx"
	"github.com/kwonikhyeon/mori/internal/hc"
)

// apiError is an error with the HTTP status and kind the API reports (spec §7.4).
type apiError struct {
	Status  int
	Kind    string
	Message string
	Hint    string
}

func (e *apiError) Error() string { return e.Kind + ": " + e.Message }

func errorf(status int, kind, format string, args ...any) *apiError {
	return &apiError{Status: status, Kind: kind, Message: fmt.Sprintf(format, args...)}
}

// statusFor maps an error kind to its HTTP status.
func statusFor(kind string) int {
	switch kind {
	case "not_found", "machine_unknown":
		return http.StatusNotFound
	case "invalid_params":
		return http.StatusBadRequest
	case "blocked", "finished", "live", "name_taken", "conflict", "already_added":
		return http.StatusConflict
	case "unavailable", "core_unavailable":
		return http.StatusServiceUnavailable
	case "unauthorized":
		return http.StatusUnauthorized
	case "forbidden_origin":
		return http.StatusForbidden
	case "rate_limited":
		return http.StatusTooManyRequests
	case "git_failed":
		return http.StatusUnprocessableEntity
	case "too_large":
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusInternalServerError
}

func writeError(w http.ResponseWriter, err error) {
	ae := asAPIError(err)
	body := map[string]any{"kind": ae.Kind, "message": ae.Message}
	if ae.Hint != "" {
		body["hint"] = ae.Hint
	}
	writeJSON(w, ae.Status, map[string]any{"error": body})
}

// asAPIError is err as the API reports it.
func asAPIError(err error) *apiError {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae
	}
	return toAPIError(err)
}

// errMessage is the message the API would show for err.
func errMessage(err error) string { return asAPIError(err).Message }

// toAPIError classifies errors from the layers below the API. The core's
// kinds pass through as they are (spec §7.4).
func toAPIError(err error) *apiError {
	if errors.Is(err, core.ErrUnavailable) {
		return &apiError{Status: http.StatusServiceUnavailable, Kind: "core_unavailable", Message: err.Error()}
	}
	if ne := (*gitx.NameError)(nil); errors.As(err, &ne) {
		return errorf(http.StatusBadRequest, "invalid_params", "브랜치나 커밋 이름으로 쓸 수 없습니다: %q", ne.Name)
	}
	if ge := (*gitx.Error)(nil); errors.As(err, &ge) {
		return &apiError{Status: http.StatusUnprocessableEntity, Kind: "git_failed", Message: gitMessage(ge)}
	}
	if kind := hc.KindOf(err); kind != "" {
		msg := err.Error()
		if e := (*hc.Error)(nil); errors.As(err, &e) && e.Message != "" {
			msg = e.Message
		}
		return &apiError{Status: statusFor(kind), Kind: kind, Message: msg, Hint: hc.HintOf(err)}
	}
	return &apiError{Status: http.StatusInternalServerError, Kind: "internal", Message: err.Error()}
}

// maxGitMessage is how much of what git said the API passes on.
const maxGitMessage = 400

// gitMessage is what the API says of a failed git call: the start of what
// git said, or why git said nothing.
func gitMessage(e *gitx.Error) string {
	switch {
	case errors.Is(e.Err, context.DeadlineExceeded):
		return "git 명령이 시간 안에 끝나지 않았습니다"
	case errors.Is(e.Err, exec.ErrNotFound):
		return "git을 찾을 수 없습니다. 이 호스트에 git을 설치하세요"
	}
	s := strings.TrimSpace(e.Stderr)
	if s == "" {
		return "git 명령이 실패했습니다: " + e.Err.Error()
	}
	n := 0
	for i := range s {
		if n == maxGitMessage {
			return s[:i] + "…"
		}
		n++
	}
	return s
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// The status line is already out; nothing better to do than stop.
		return
	}
}
