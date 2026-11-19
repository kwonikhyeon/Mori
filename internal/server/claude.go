package server

import (
	"context"
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
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	// Read again under the lock: another viewer's resume may have set the
	// label since t was read at attach.
	if err := s.d.Core.Call(ctx, "terminal.get", map[string]any{"terminal": t.Address}, &t); err != nil {
		return
	}
	line := s.resumeLine(t)
	if line == "" {
		return
	}
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

// Claude Code (2.1.328) notes each fullscreen start, and counts one whose
// process is gone within 10 s of its first frame, without exiting by
// itself, as a failed start: after two it turns fullscreen off on the
// machine for that version (fullscreenAutoDisabled in ~/.claude.json), and
// Mori does not cover the classic screen (spec §3 #217). A kill is such an
// end, as the core ends the program from outside, so a kill first asks
// Claude Code to exit with two Ctrl+C (spec §3 #258).
//
// On Windows, Claude Code killed 1.5 s after it started took its note away
// within 0.5 s of the keys and was gone after 2.0 to 2.5 s; one running a
// while left in 0.7 s.
const (
	claudeExitGap  = 150 * time.Millisecond // between the two Ctrl+C
	claudeExitWait = 3 * time.Second        // for it to go, once they are pressed
	claudeExitMax  = 7 * time.Second        // all of it, the keys held by the core's quiet rule included
	claudeExitPoll = 100 * time.Millisecond
)

// shellWaits says whether t's own program, a shell, has the foreground. On
// Windows the core names the shell even while a program runs in it.
func shellWaits(t hc.Terminal) bool {
	return t.Foreground != nil && t.Pid != nil && t.Foreground.Pid == *t.Pid
}

// claudeMayRun says whether Claude Code may run in t: its program, the
// foreground, or what it reported last. A report outlives the program that
// made it, so a shell seen waiting at its prompt has none running, but on
// Windows the core cannot tell.
func claudeMayRun(t hc.Terminal) bool {
	if t.State != "live" {
		return false
	}
	if isClaudeArgv(t.Argv) {
		return true
	}
	if fg := t.Foreground; fg != nil && !shellWaits(t) &&
		(isClaudeArgv([]string{fg.Name}) || isClaudeArgv(fg.Argv) || len(fg.Argv) > 1 && isClaudeArgv(fg.Argv[1:])) {
		return true
	}
	if t.Status == nil || t.Status.App != "claude-code" {
		return false
	}
	return runtime.GOOS == "windows" || !shellWaits(t)
}

// endClaude asks Claude Code in t to exit by itself, and waits a little for
// it to: until the terminal ends or, where the core can tell, its shell has
// the foreground again. On Windows a shell's Claude Code cannot be seen to
// go, so the wait runs out. What is left, the kill ends.
func (s *Server) endClaude(ctx context.Context, t hc.Terminal) {
	if !claudeMayRun(t) {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, claudeExitMax)
	defer cancel()
	press := func() bool {
		return s.d.Core.Call(ctx, "terminal.keys", map[string]any{"terminal": t.Address, "keys": []string{"ctrl+c"}}, nil) == nil
	}
	pause := func(d time.Duration) bool {
		select {
		case <-time.After(d):
			return true
		case <-ctx.Done():
			return false
		}
	}
	if !press() || !pause(claudeExitGap) || !press() {
		return
	}
	// a shell that had Claude Code in the foreground has it back once it went
	watch := !isClaudeArgv(t.Argv) && !shellWaits(t)
	gone := false
	for until := time.Now().Add(claudeExitWait); !gone && time.Now().Before(until) && pause(claudeExitPoll); {
		var now hc.Terminal
		if s.d.Core.Call(ctx, "terminal.get", map[string]any{"terminal": t.Address}, &now) != nil {
			break
		}
		gone = now.State != "live" || watch && shellWaits(now)
	}
	s.log.Info("claude asked to exit", "terminal", t.Address, "seen_gone", gone)
}
