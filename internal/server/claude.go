package server

import (
	"context"
	"path/filepath"
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

// withHook gives a claude argv the settings file whose SessionStart hook
// runs `mori claude-hook`, unless settings is "" or the argv brings settings
// of its own. A file, not inline JSON, as the quotes in JSON do not survive
// the way to Claude Code on Windows (spec §3 #241).
func withHook(argv []string, settings string) []string {
	if settings == "" || !isClaudeArgv(argv) || slices.Contains(argv, "--settings") {
		return argv
	}
	return append(argv, "--settings", settings)
}

// resumeLine is the command that takes Claude Code's conversation up again
// in t, or "" when t is not a shell that took its place and waits at its
// prompt, or was sent it already. It runs the preset's program, with the
// hook, as the terminal was started. With no conversation noted (a terminal
// started before the hook) it opens Claude Code's list of them instead.
func (s *Server) resumeLine(t hc.Terminal) string {
	// shortcut: on Windows the core names the shell itself as the foreground
	// even while a program runs in it, so there only the resumed label keeps
	// a busy shell from being typed into; check again if the core learns it.
	if t.State != "live" || t.Pid == nil || len(t.Argv) == 0 || isClaudeArgv(t.Argv) ||
		t.Foreground == nil || t.Foreground.Pid != *t.Pid || // something runs in the shell
		t.Labels[core.LabelClaudeResumed] == strconv.Itoa(*t.Pid) {
		return ""
	}
	id := t.Labels[core.LabelClaudeSession]
	argv := []string{"claude"}
	ps := s.d.Store.Get().Presets
	switch i := slices.IndexFunc(ps, func(p store.Preset) bool { return p.ID == t.Labels[core.LabelPreset] }); {
	case i >= 0 && isClaudeArgv(ps[i].Argv):
		argv = slices.Clone(ps[i].Argv)
	case !core.IsSessionID(id):
		return "" // nothing says Claude Code ran here
	}
	argv = append(withHook(argv, s.d.ClaudeSettings), "--resume")
	if core.IsSessionID(id) {
		argv = append(argv, id)
	}
	return shellLine(t.Argv[0], argv)
}

// shellLine is argv as a line typed into shell: PowerShell, which the core
// gives a kept terminal on Windows, takes its call operator and quotes;
// other shells POSIX quotes.
func shellLine(shell string, argv []string) string {
	quote, line := procutil.QuoteArg, ""
	switch strings.ToLower(strings.TrimSuffix(shell[strings.LastIndexAny(shell, `/\`)+1:], ".exe")) {
	case "pwsh", "powershell":
		quote, line = procutil.QuotePSArg, "& "
	}
	words := make([]string, len(argv))
	for i, a := range argv {
		words[i] = quote(a)
	}
	return line + strings.Join(words, " ")
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
