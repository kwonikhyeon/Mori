package hc

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ErrClosed reports that the connection to the core is gone.
var ErrClosed = errors.New("hc: connection closed")

// message is a JSON-RPC 2.0 request, response or notification.
type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

// Error is an error reply from the core.
type Error struct {
	Code    int       `json:"code"`
	Message string    `json:"message"`
	Data    ErrorData `json:"data"`
}

// ErrorData carries the core's error kind (not_found, blocked, ...) and a hint.
type ErrorData struct {
	Kind string `json:"kind"`
	Hint string `json:"hint"`
}

// UnmarshalJSON accepts any data value; only an object with kind and hint
// carries meaning.
func (d *ErrorData) UnmarshalJSON(b []byte) error {
	var v struct{ Kind, Hint string }
	if json.Unmarshal(b, &v) == nil {
		d.Kind, d.Hint = v.Kind, v.Hint
	}
	return nil
}

func (e *Error) Error() string {
	if e.Data.Kind != "" {
		return "hc: " + e.Data.Kind + ": " + e.Message
	}
	return fmt.Sprintf("hc: %s (code %d)", e.Message, e.Code)
}

// KindOf classifies err: the core's error kind, "core_unavailable" when the
// connection is gone, or "" for anything else.
func KindOf(err error) string {
	var e *Error
	switch {
	case errors.As(err, &e):
		if e.Data.Kind != "" {
			return e.Data.Kind
		}
		if e.Code == -32602 {
			return "invalid_params"
		}
		return "internal"
	case errors.Is(err, ErrClosed):
		return "core_unavailable"
	}
	return ""
}

// HintOf returns the core's hint for err, if any.
func HintOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Data.Hint
	}
	return ""
}
