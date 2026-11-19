package server

import (
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
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
	// SIGKILL on Unix; os.Process, so the package also builds on Windows
	p, err := os.FindProcess(*get().Pid)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Kill(); err != nil {
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

func TestClaudeMayRun(t *testing.T) {
	pid := 42
	shell := func(f func(*hc.Terminal)) hc.Terminal {
		t := hc.Terminal{Address: "t1", State: "live", Argv: []string{"/bin/zsh", "-l"}, Pid: &pid,
			Foreground: &hc.Foreground{Pid: pid, Name: "zsh"}}
		if f != nil {
			f(&t)
		}
		return t
	}
	report := func(t *hc.Terminal) { t.Status = &hc.Status{App: "claude-code", State: "idle"} }
	// in the shell's foreground: name, then argv
	runs := func(argv ...string) func(*hc.Terminal) {
		return func(t *hc.Terminal) { t.Foreground = &hc.Foreground{Pid: 99, Name: argv[0], Argv: argv[1:]} }
	}
	for name, c := range map[string]struct {
		f    func(*hc.Terminal)
		want bool
	}{
		"a shell":            {nil, false},
		"its program":        {func(t *hc.Terminal) { t.Argv = []string{"claude", "--resume"} }, true},
		"Windows' wrapper":   {func(t *hc.Terminal) { t.Argv = []string{"claude"}; t.Foreground.Name = "cmd.exe" }, true},
		"in the foreground":  {runs("claude"), true},
		"under node":         {runs("node", "node", "/x/bin/claude"), true},
		"something else":     {runs("vim"), false},
		"its report":         {func(t *hc.Terminal) { runs("2.1.328")(t); report(t) }, true},
		"another app's":      {func(t *hc.Terminal) { t.Status = &hc.Status{App: "codex"} }, false},
		"finished":           {func(t *hc.Terminal) { t.Argv = []string{"claude"}; t.State = "finished" }, false},
		"no foreground seen": {func(t *hc.Terminal) { report(t); t.Foreground = nil }, true},
		// a report outlives its program: at the prompt none runs, but on
		// Windows the core names the shell even while one does
		"a report at the prompt": {report, runtime.GOOS == "windows"},
	} {
		if got := claudeMayRun(shell(c.f)); got != c.want {
			t.Errorf("%s: %v", name, got)
		}
	}
}

// TestKillAsksClaudeToExit: Claude Code killed from outside soon after it
// starts counts against fullscreen, so a kill first has it exit by itself
// (spec §3 #258). A stand-in in a shell, as a resumed Claude Code runs:
// it reports as Claude Code does, and exits on the second Ctrl+C.
func TestKillAsksClaudeToExit(t *testing.T) {
	py, sh := "python3", []string{"/bin/sh"}
	if runtime.GOOS == "windows" {
		py, sh = "python", []string{"pwsh.exe", "-NoLogo", "-NoProfile"}
		if _, err := exec.LookPath("pwsh.exe"); err != nil {
			sh[0] = "powershell.exe"
		}
	}
	if p, err := exec.LookPath(py); err != nil || exec.Command(p, "-c", "import signal").Run() != nil {
		t.Skip("no python to stand in for Claude Code")
	}
	c := hctest.Start(t)
	e := newTestEnv(t, withCore(t, c))
	e.pair()
	dir := t.TempDir()
	f := e.addFolder(dir)
	e.addPreset(store.Preset{ID: "sh", Name: "sh", Argv: sh})
	out := filepath.Join(dir, "out")
	fake := filepath.Join(dir, "fake.py")
	writeFile(t, fake, `import os, signal, sys, time
def note(s):
    with open(sys.argv[1], 'a') as f:
        f.write(s + '\n')
n = 0
def hit(*_):
    global n
    n += 1
    if n == 2:
        note('exited')
        os._exit(0)
signal.signal(signal.SIGINT, hit)
sys.stdout.write('\x1b]7501;app=claude-code:state=idle\x07')
sys.stdout.flush()
note('up')
while True:
    time.sleep(0.05)
`)
	var tv TerminalView
	e.json("POST", "/api/terminals", map[string]any{"folder_id": f.ID, "preset": "sh", "cols": 80, "rows": 24}, 201, &tv)
	term := "/api/terminals/" + url.PathEscape(tv.Address)
	get := func() TerminalView {
		var v TerminalView
		e.json("GET", term, nil, 200, &v)
		return v
	}
	e.eventually(func() bool { v := get(); return v.Foreground != nil && v.Foreground.Pid == *v.Pid })
	e.json("POST", term+"/send", map[string]any{"text": shellLine(sh[0], []string{py, "-u", fake, out})}, 200, nil)
	noted := func() string { b, _ := os.ReadFile(out); return strings.ReplaceAll(string(b), "\r", "") }
	e.eventually(func() bool {
		v := get()
		return noted() == "up\n" && v.Status != nil && v.Status.App == "claude-code"
	})

	e.json("POST", term+"/kill", nil, 200, nil)
	if got := noted(); got != "up\nexited\n" {
		t.Fatalf("killed before it exited by itself: %q", got)
	}
	e.eventually(func() bool { return get().State == "finished" })
}
