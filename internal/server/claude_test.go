package server

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/hctest"
	"github.com/kwonikhyeon/mori/internal/store"
)

const testSession = "3fb3a8e8-f08c-4666-9f7f-faa8caa2f6db"

func TestWithHook(t *testing.T) {
	got := withHook([]string{"/usr/local/bin/claude", "--dangerously-skip-permissions"}, "/a b/claude-settings.json")
	if !slices.Equal(got, []string{"/usr/local/bin/claude", "--dangerously-skip-permissions", "--settings", "/a b/claude-settings.json"}) {
		t.Fatal(got)
	}
	// not Claude Code, no hook, or settings of its own: as it was
	for _, argv := range [][]string{{"codex"}, {"/bin/zsh"}, {"claude", "--settings", "x.json"}, {}} {
		if g := withHook(slices.Clone(argv), "h"); !slices.Equal(g, argv) {
			t.Fatal(argv, g)
		}
	}
	if g := withHook([]string{"claude"}, ""); !slices.Equal(g, []string{"claude"}) {
		t.Fatal(g)
	}
	// the task stays last
	p := runParams(store.Folder{ID: "f"}, "/repo", store.Preset{ID: "claude", Argv: []string{"claude"}, Task: true}, createReq{Task: "고쳐 줘"}, "h")
	if len(p.Argv) != 4 || p.Argv[1] != "--settings" || p.Argv[3] != "고쳐 줘" {
		t.Fatal(p.Argv)
	}
}

func TestResumeLine(t *testing.T) {
	e := newTestEnv(t, func(d *Deps) { d.ClaudeSettings = "/a b/s.json" })
	e.addPreset(store.Preset{ID: "cc", Name: "cc", Argv: []string{"claude", "--dangerously-skip-permissions"}, Task: true})
	pid := 42
	shell := func(f func(*hc.Terminal)) hc.Terminal {
		t := hc.Terminal{Address: "t1", State: "live", Argv: []string{"/bin/zsh", "-l"}, Pid: &pid,
			Foreground: &hc.Foreground{Pid: pid, Name: "zsh"},
			Labels:     map[string]string{core.LabelPreset: "cc", core.LabelClaudeSession: testSession}}
		if f != nil {
			f(&t)
		}
		return t
	}
	want := `claude --dangerously-skip-permissions --settings '/a b/s.json' --resume ` + testSession
	if got := e.s.resumeLine(shell(nil)); got != want {
		t.Fatalf("%s\n%s", got, want)
	}
	// a preset gone, or no longer Claude Code: claude itself
	if got := e.s.resumeLine(shell(func(t *hc.Terminal) { t.Labels[core.LabelPreset] = "gone" })); !strings.HasPrefix(got, "claude --settings ") {
		t.Fatal(got)
	}
	for name, f := range map[string]func(*hc.Terminal){
		"finished":    func(t *hc.Terminal) { t.State = "finished" },
		"claude runs": func(t *hc.Terminal) { t.Argv = []string{"claude"} },
		"no sign of Claude Code": func(t *hc.Terminal) {
			t.Labels[core.LabelPreset] = "gone"
			delete(t.Labels, core.LabelClaudeSession)
		},
		"busy shell":    func(t *hc.Terminal) { t.Foreground = &hc.Foreground{Pid: 99, Name: "claude"} },
		"no foreground": func(t *hc.Terminal) { t.Foreground = nil },
		"no program":    func(t *hc.Terminal) { t.Pid = nil },
		"sent already":  func(t *hc.Terminal) { t.Labels[core.LabelClaudeResumed] = strconv.Itoa(pid) },
	} {
		if got := e.s.resumeLine(shell(f)); got != "" {
			t.Errorf("%s: %s", name, got)
		}
	}
	// a Claude Code preset with no conversation noted (started before the
	// hook, or a name that is not an ID): Claude Code's own list to pick from
	picker := `claude --dangerously-skip-permissions --settings '/a b/s.json' --resume`
	if got := e.s.resumeLine(shell(func(t *hc.Terminal) { delete(t.Labels, core.LabelClaudeSession) })); got != picker {
		t.Fatal(got)
	}
	if got := e.s.resumeLine(shell(func(t *hc.Terminal) { t.Labels[core.LabelClaudeSession] = "x; rm -rf ~" })); got != picker {
		t.Fatal(got)
	}
	// the shell the core gives on Windows: PowerShell's call and quotes
	if got := e.s.resumeLine(shell(func(t *hc.Terminal) { t.Argv = []string{`C:\Program Files\PowerShell\7\pwsh.exe`} })); got != `& claude --dangerously-skip-permissions --settings '/a b/s.json' --resume `+testSession {
		t.Fatal(got)
	}
	// sent to an earlier shell: this one takes it
	if got := e.s.resumeLine(shell(func(t *hc.Terminal) { t.Labels[core.LabelClaudeResumed] = "7" })); got != want {
		t.Fatal(got)
	}
}

// TestClaudeResume: a Claude Code terminal whose program the core lost
// comes back as a shell, which is sent the command that takes the
// conversation up again as it is opened, once (spec §3 #230).
func TestClaudeResume(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX shell")
	}
	c := hctest.Start(t)
	e := newTestEnv(t, withCore(t, c), func(d *Deps) { d.ClaudeSettings = "/m/claude-settings.json" })
	e.pair()
	dir := t.TempDir()
	f := e.addFolder(dir)
	// a stand-in claude: it notes what it was given and waits
	out := filepath.Join(dir, "args")
	fake := filepath.Join(dir, "bin", "claude")
	if err := os.Mkdir(filepath.Dir(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, fake, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '"+out+"'\nexec sleep 300\n")
	if err := os.Chmod(fake, 0o755); err != nil {
		t.Fatal(err)
	}
	e.addPreset(store.Preset{ID: "cc", Name: "cc", Argv: []string{fake}, Task: true})
	var tv TerminalView
	e.json("POST", "/api/terminals", map[string]any{"folder_id": f.ID, "preset": "cc", "task": "일해 줘"}, 201, &tv)
	addr := tv.Address
	lines := func() []string {
		b, _ := os.ReadFile(out)
		return strings.Split(strings.TrimSpace(string(b)), "\n")
	}
	e.eventually(func() bool { return len(lines()) == 1 && lines()[0] != "" })
	if l := lines()[0]; l != "--settings /m/claude-settings.json 일해 줘" {
		t.Fatal(l)
	}
	// what the hook would write as the conversation starts
	c.Cmd(t, "label", addr, core.LabelClaudeSession+"="+testSession)

	// the core loses the program and gives the terminal a shell
	term := "/api/terminals/" + url.PathEscape(addr)
	get := func() TerminalView {
		var v TerminalView
		e.json("GET", term, nil, 200, &v)
		return v
	}
	if err := syscall.Kill(*get().Pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	var shell TerminalView
	e.eventually(func() bool {
		shell = get()
		return shell.Pid != nil && !isClaudeArgv(shell.Argv) && shell.Foreground != nil && shell.Foreground.Pid == *shell.Pid
	})
	if shell.Labels[core.LabelClaudeSession] != testSession {
		t.Fatal("the label went with the program:", shell.Labels)
	}

	// opened: the shell runs it again, on the conversation
	ws := e.dialWS("/ws/attach?t=" + url.QueryEscape(addr) + "&cols=80&rows=24")
	e.eventually(func() bool { return len(lines()) == 2 })
	if l := lines()[1]; l != "--settings /m/claude-settings.json --resume "+testSession {
		t.Fatal(l)
	}
	if get().Labels[core.LabelClaudeResumed] != strconv.Itoa(*shell.Pid) {
		t.Fatal(get().Labels)
	}
	ws.CloseNow()

	// the program ends, the shell waits again: opened again, it is not sent twice
	e.json("POST", term+"/keys", map[string]any{"keys": []string{"ctrl+c"}}, 200, nil)
	e.eventually(func() bool { v := get(); return v.Foreground != nil && v.Foreground.Pid == *v.Pid })
	ws = e.dialWS("/ws/attach?t=" + url.QueryEscape(addr) + "&cols=80&rows=24")
	defer ws.CloseNow()
	time.Sleep(time.Second)
	if n := len(lines()); n != 2 {
		t.Fatal("sent again:", lines())
	}
}
