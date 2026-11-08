package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/gitx"
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
		{fmt.Errorf("folder git: %w", &gitx.Error{Args: []string{"status"}, Stderr: "fatal: not a git repository\n", Err: errors.New("exit status 128")}),
			422, "git_failed", "fatal: not a git repository", ""},
		{&gitx.Error{Args: []string{"status"}, Err: context.DeadlineExceeded}, 422, "git_failed", "git 명령이 시간 안에 끝나지 않았습니다", ""},
		{&gitx.Error{Args: []string{"status"}, Err: &exec.Error{Name: "git", Err: exec.ErrNotFound}}, 422, "git_failed", "git을 찾을 수 없습니다. 이 호스트에 git을 설치하세요", ""},
		{&gitx.NameError{Name: "-x"}, 400, "invalid_params", `브랜치나 커밋 이름으로 쓸 수 없습니다: "-x"`, ""},
	}
	for _, c := range cases {
		got := toAPIError(c.err)
		if got.Status != c.status || got.Kind != c.kind || got.Message != c.message || got.Hint != c.hint {
			t.Errorf("%v: got %+v", c.err, got)
		}
	}
}

func TestGitMessageIsCut(t *testing.T) {
	long := strings.Repeat("가", 500)
	got := toAPIError(&gitx.Error{Args: []string{"diff"}, Stderr: long, Err: errors.New("exit status 1")}).Message
	if !utf8.ValidString(got) || utf8.RuneCountInString(got) != maxGitMessage+1 || !strings.HasSuffix(got, "…") {
		t.Fatalf("%d runes: %q", utf8.RuneCountInString(got), got)
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
