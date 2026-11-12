package main

import (
	"context"
	"encoding/json"
	"io"
	"os/exec"
	"time"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/procutil"
)

// runClaudeHook is `mori claude-hook`, the SessionStart hook Mori gives
// Claude Code in the terminals it starts (spec §3 #230): it writes the ID
// of the conversation Claude Code holds into the terminal's label, from the
// JSON Claude Code passes on stdin, as it starts, clears or resumes one.
// terminal is HC_TERMINAL_ID. It prints nothing, as what the hook prints
// goes to Claude, and never fails Claude Code's start.
func runClaudeHook(terminal string, stdin io.Reader, label func(terminal, kv string) error) {
	var in struct {
		SessionID string `json:"session_id"`
	}
	if terminal == "" || json.NewDecoder(io.LimitReader(stdin, 1<<20)).Decode(&in) != nil || !core.IsSessionID(in.SessionID) {
		return
	}
	_ = label(terminal, core.LabelClaudeSession+"="+in.SessionID)
}

// hcLabel sets one label on a terminal with hc, as its program would.
func hcLabel(terminal, kv string) error {
	path, err := hc.Locate("")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "label", terminal, kv)
	procutil.HideWindow(cmd)
	return cmd.Run()
}
