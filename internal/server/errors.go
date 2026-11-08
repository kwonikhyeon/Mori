package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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
	case "not_found":
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
	var ae *apiError
	if !errors.As(err, &ae) {
		ae = toAPIError(err)
	}
	body := map[string]any{"kind": ae.Kind, "message": ae.Message}
	if ae.Hint != "" {
		body["hint"] = ae.Hint
	}
	writeJSON(w, ae.Status, map[string]any{"error": body})
}

// toAPIError classifies errors from the layers below the API.
func toAPIError(err error) *apiError {
	return &apiError{Status: http.StatusInternalServerError, Kind: "internal", Message: err.Error()}
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
