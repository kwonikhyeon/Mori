package server

import (
	"context"
	"encoding/json"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/procutil"
	"github.com/kwonikhyeon/mori/internal/store"
)

// Claude Code in the terminals Mori starts (spec §3 #230): a SessionStart
// hook writes the ID of the conversation it holds into the terminal's label,
// and a terminal that lost Claude Code to a shell (the core gives a kept
// terminal one, spec §2.3) takes that conversation up again when it is
// opened.

// isClaudeArgv says whether argv runs Claude Code.
func isClaudeArgv(argv []string) bool {
	return len(argv) > 0 && strings.TrimSuffix(filepath.Base(argv[0]), ".exe") == "claude"
}

// withHook gives a claude argv the settings whose SessionStart hook runs
// hook, unless hook is "" or the argv brings settings of its own.
func withHook(argv []string, hook string) []string {
	if hook == "" || !isClaudeArgv(argv) || slices.Contains(argv, "--settings") {
		return argv
	}
	type cmd struct {
		Type    string `json:"type"`
		Command string `json:"command"`
	}
	type matcher struct {
		Hooks []cmd `json:"hooks"`
	}
	b, _ := json.Marshal(map[string]map[string][]matcher{"hooks": {"SessionStart": {{Hooks: []cmd{{"command", hook}}}}}})
	return append(argv, "--settings", string(b))
}

// resumeLine is the command that takes Claude Code's conversation up again
// in t, or "" when t is not a shell that took its place and waits at its
// prompt, or was sent it already. It runs the preset's program, with the
// hook, as the terminal was started.
func (s *Server) resumeLine(t hc.Terminal) string {
	id := t.Labels[core.LabelClaudeSession]
	switch {
	case runtime.GOOS == "windows", // the shell the core gives is not a POSIX one
		t.State != "live", t.Pid == nil, isClaudeArgv(t.Argv), !core.IsSessionID(id),
		t.Foreground == nil || t.Foreground.Pid != *t.Pid, // something runs in the shell
		t.Labels[core.LabelClaudeResumed] == strconv.Itoa(*t.Pid):
		return ""
	}
	argv := []string{"claude"}
	ps := s.d.Store.Get().Presets
	if i := slices.IndexFunc(ps, func(p store.Preset) bool { return p.ID == t.Labels[core.LabelPreset] }); i >= 0 && isClaudeArgv(ps[i].Argv) {
		argv = slices.Clone(ps[i].Argv)
	}
	argv = append(withHook(argv, s.d.ClaudeHook), "--resume", id)
	words := make([]string, len(argv))
	for i, a := range argv {
		words[i] = procutil.QuoteArg(a)
	}
	return strings.Join(words, " ")
}

// resumeClaude sends t's shell the command that takes its conversation up
// again, once for each shell: the shell's pid goes into a label first, so
// another viewer, or Mori started again, does not send it twice.
func (s *Server) resumeClaude(ctx context.Context, t hc.Terminal) {
	s.resumeMu.Lock()
	defer s.resumeMu.Unlock()
	line := s.resumeLine(t)
	if line == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	labels := map[string]string{core.LabelClaudeResumed: strconv.Itoa(*t.Pid)}
	if err := s.d.Core.Call(ctx, "terminal.label", map[string]any{"terminal": t.Address, "labels": labels}, nil); err != nil {
		s.log.Warn("claude resume", "terminal", t.Address, "err", err)
		return
	}
	if err := s.d.Core.Call(ctx, "terminal.send", map[string]any{"terminal": t.Address, "text": line}, nil); err != nil {
		s.log.Warn("claude resume", "terminal", t.Address, "err", err)
		return
	}
	s.log.Info("claude resumed", "terminal", t.Address, "session", t.Labels[core.LabelClaudeSession])
}
