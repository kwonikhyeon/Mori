package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
)

func TestToAPIError(t *testing.T) {
	cases := []struct {
		err                 error
		status              int
		kind, message, hint string
	}{
		{core.ErrUnavailable, 503, "core_unavailable", "core unavailable", ""},
		{fmt.Errorf("terminal.attach: %w", &hc.Error{Code: -32000, Message: "no terminal t9", Data: hc.ErrorData{Kind: "not_found", Hint: "list terminals first"}}),
			404, "not_found", "no terminal t9", "list terminals first"},
		{&hc.Error{Code: -32602, Message: "cols must be positive"}, 400, "invalid_params", "cols must be positive", ""},
		{&hc.Error{Code: -32000, Message: "no machine rohan", Data: hc.ErrorData{Kind: "machine_unknown"}}, 404, "machine_unknown", "no machine rohan", ""},
		{&hc.Error{Code: -32000, Message: "still running", Data: hc.ErrorData{Kind: "live"}}, 409, "live", "still running", ""},
		{&hc.Error{Code: -32000, Message: "restarting", Data: hc.ErrorData{Kind: "unavailable"}}, 503, "unavailable", "restarting", ""},
		{&hc.Error{Code: -32000, Message: "a kind Mori does not know", Data: hc.ErrorData{Kind: "quota"}}, 500, "quota", "a kind Mori does not know", ""},
		{fmt.Errorf("call: %w", hc.ErrClosed), 503, "core_unavailable", "call: hc: connection closed", ""},
		{errors.New("disk full"), 500, "internal", "disk full", ""},
	}
	for _, c := range cases {
		got := toAPIError(c.err)
		if got.Status != c.status || got.Kind != c.kind || got.Message != c.message || got.Hint != c.hint {
			t.Errorf("%v: got %+v", c.err, got)
		}
	}
}

func TestWriteErrorBody(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, &hc.Error{Code: -32000, Message: "waiting for approval", Data: hc.ErrorData{Kind: "blocked", Hint: "answer it first"}})
	var body struct {
		Error map[string]string `json:"error"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if rec.Code != 409 || body.Error["kind"] != "blocked" || body.Error["message"] != "waiting for approval" || body.Error["hint"] != "answer it first" {
		t.Fatalf("%d %v", rec.Code, body.Error)
	}
	rec = httptest.NewRecorder()
	writeError(rec, errors.New("boom"))
	body.Error = nil
	json.NewDecoder(rec.Body).Decode(&body)
	if _, ok := body.Error["hint"]; rec.Code != 500 || ok {
		t.Fatalf("no hint when there is none: %d %v", rec.Code, body.Error)
	}
}
