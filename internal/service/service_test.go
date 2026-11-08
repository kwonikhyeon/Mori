package service

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/admin"
)

func TestMain(m *testing.M) {
	if os.Getenv("MORI_TEST_SLEEPER") == "1" { // stands in for a running server
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestLaunchdPlist(t *testing.T) {
	env := map[string]string{"PATH": "/opt/homebrew/bin:/usr/bin", "LANG": "ko_KR.UTF-8"}
	args := []string{"serve", "--home", "/Users/u/Mori"}
	b := LaunchdPlist(Label, "/Users/u/bin/mori", args, env, "/Users/u/Mori/mori.log")
	for _, want := range []string{
		"<key>Label</key>\n\t<string>dev.mori</string>",
		"<string>/Users/u/bin/mori</string>\n\t\t<string>serve</string>",
		"<key>RunAtLoad</key>\n\t<true/>",
		"<key>KeepAlive</key>\n\t<true/>",
		"<key>LANG</key>\n\t\t<string>ko_KR.UTF-8</string>\n\t\t<key>PATH</key>\n\t\t<string>/opt/homebrew/bin:/usr/bin</string>",
		"<key>StandardOutPath</key>\n\t<string>/Users/u/Mori/mori.log</string>",
		"<key>StandardErrorPath</key>\n\t<string>/Users/u/Mori/mori.log</string>",
	} {
		if !bytes.Contains(b, []byte(want)) {
			t.Errorf("missing %q in\n%s", want, b)
		}
	}
	wellFormed(t, b)
	in, err := parsePlist(b)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(in.Args, append([]string{"/Users/u/bin/mori"}, args...)) || !maps.Equal(in.Env, env) {
		t.Fatalf("read back %+v", in)
	}
}

func TestPlistEscapesXML(t *testing.T) {
	b := LaunchdPlist(Label, "/a&b/<mori>", []string{"serve", `"q" 'a'`}, map[string]string{"PATH": "/x&y"}, "/l&og")
	if !bytes.Contains(b, []byte("<string>/a&amp;b/&lt;mori&gt;</string>")) {
		t.Fatalf("not escaped:\n%s", b)
	}
	wellFormed(t, b)
	in, err := parsePlist(b)
	if err != nil || !slices.Equal(in.Args, []string{"/a&b/<mori>", "serve", `"q" 'a'`}) || in.Env["PATH"] != "/x&y" {
		t.Fatal(in, err)
	}
}

func TestParsePlistRefusesOthers(t *testing.T) {
	for name, b := range map[string]string{
		"not XML":    "hello",
		"not plist":  "<html><dict></dict></html>",
		"no command": `<plist version="1.0"><dict><key>Label</key><string>dev.mori</string></dict></plist>`,
		"empty":      `<plist version="1.0"><dict><key>ProgramArguments</key><array></array></dict></plist>`,
	} {
		if in, err := parsePlist([]byte(b)); err == nil {
			t.Errorf("%s: read %+v", name, in)
		}
	}
}

// wellFormed fails unless b parses as XML to the end.
func wellFormed(t *testing.T, b []byte) {
	t.Helper()
	d := xml.NewDecoder(bytes.NewReader(b))
	for {
		_, err := d.Token()
		if err == io.EOF {
			return
		}
		if err != nil {
			t.Fatalf("not XML: %v\n%s", err, b)
		}
	}
}

func TestRunKeyCommand(t *testing.T) {
	got := RunKeyCommand(`C:\Users\u\Mori\moriw.exe`, []string{"serve", "--log", `C:\Users\u\AppData\Roaming\Mori\mori.log`})
	want := `"C:\Users\u\Mori\moriw.exe" serve --log "C:\Users\u\AppData\Roaming\Mori\mori.log"`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

// The Run key command must come back as the same arguments in moriw.exe,
// a Go program, whose os.Args splits the command line by splitWinArgs's
// rules.
func TestRunKeyCommandRoundTrip(t *testing.T) {
	exe := `C:\Program Files\Mori\moriw.exe`
	args := []string{"serve", "", "a b", `a"b`, `a\b`, `a\\"b`, `C:\dir\`, `C:\dir with space\`, "tab\there",
		"한글 경로", "%APPDATA%", "x^&|<>y", `\\server\share\`, `"`, `\`, `""`}
	line := RunKeyCommand(exe, args)
	if got, want := splitWinArgs(line), append([]string{exe}, args...); !slices.Equal(got, want) {
		t.Fatalf("%s\nsplit %q\nwant  %q", line, got, want)
	}
}

// The examples of Microsoft's "Parsing C++ command-line arguments", and
// one where Go parts from today's C runtime.
func TestSplitWinArgs(t *testing.T) {
	for line, want := range map[string][]string{
		`"a b c" d e`:      {"a b c", "d", "e"},
		`"ab\"c" "\\" d`:   {`ab"c`, `\`, "d"},
		`a\\\b d"e f"g h`:  {`a\\\b`, "de fg", "h"},
		`a\\\"b c d`:       {`a\"b`, "c", "d"},
		`a\\\\"b c" d e`:   {`a\\b c`, "d", "e"},
		"  spaced\t\tout ": {"spaced", "out"},
		// Go keeps the rule from before 2008: "" in quotes is a " that
		// ends the quotes. The C runtime now stays in them: [ab" c d].
		`a"b"" c d`: {`ab"`, "c", "d"},
	} {
		if got := splitWinArgs(line); !slices.Equal(got, want) {
			t.Errorf("%s: %q want %q", line, got, want)
		}
	}
}

func TestAgentEnv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("LaunchAgent는 macOS에만 있다")
	}
	got := AgentEnv([]string{
		"PATH=/opt/homebrew/bin::bin:/usr/bin:/opt/homebrew/bin/:/usr/bin",
		"LANG=ko_KR.UTF-8", "LC_ALL=", "LC_CTYPE=UTF-8",
		"XDG_CONFIG_HOME=/Users/u/.config", "XDG_STATE_HOME=relative/state",
		"ANTHROPIC_API_KEY=secret", "HOME=/Users/u", "HC_SESSION=work", "TERM=xterm-256color", "broken",
	})
	want := map[string]string{
		"PATH": "/opt/homebrew/bin:/usr/bin",
		"LANG": "ko_KR.UTF-8", "LC_CTYPE": "UTF-8", "XDG_CONFIG_HOME": "/Users/u/.config",
	}
	if !maps.Equal(got, want) {
		t.Fatalf("got  %v\nwant %v", got, want)
	}
}

func TestCheckExe(t *testing.T) {
	dir := t.TempDir()
	exe := writeExe(t, filepath.Join(dir, "bin", "mori"))
	if err := checkExe(exe, filepath.Join(dir, "tmp")); err != nil {
		t.Fatal(err)
	}
	if err := checkExe(filepath.Join(dir, "bin")); err == nil {
		t.Error("a directory passed")
	}
	if err := checkExe(filepath.Join(dir, "none")); err == nil {
		t.Error("a missing file passed")
	}
	if err := checkExe(exe, dir); err == nil || !strings.Contains(err.Error(), "임시") {
		t.Errorf("an executable in a temporary directory: %v", err)
	}
	// /tmp is a link on macOS, and go run's directory may be reached through one.
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Skip(err)
	}
	if err := checkExe(exe, link); err == nil {
		t.Error("an executable under a linked temporary directory passed")
	}
	if err := checkExe(filepath.Join(link, "bin", "mori"), dir); err == nil {
		t.Error("an executable reached through a link passed")
	}
}

func TestGuiExe(t *testing.T) {
	dir := t.TempDir()
	cli := writeExe(t, filepath.Join(dir, "mori.exe"))
	if _, err := guiExe(cli); err == nil || !strings.Contains(err.Error(), "moriw.exe") {
		t.Fatal("without moriw.exe:", err)
	}
	gui := writeExe(t, filepath.Join(dir, "moriw.exe"))
	if got, err := guiExe(cli); err != nil || got != gui {
		t.Fatal(got, err)
	}
	if got, err := guiExe(gui); err != nil || got != gui {
		t.Fatal(got, err)
	}
}

func TestInstallationFlag(t *testing.T) {
	in := Installation{Args: []string{"/m/mori", "serve", "--home", "/h", "-listen=127.0.0.1:1", "--hc-session", "w", "--public-url"}}
	for name, want := range map[string]string{"home": "/h", "listen": "127.0.0.1:1", "hc-session": "w", "hc": "", "public-url": "", "log": ""} {
		if got := in.Flag(name); got != want {
			t.Errorf("%s: %q want %q", name, got, want)
		}
	}
}

func TestDarwinPlan(t *testing.T) {
	o := Options{Exe: "/Users/u/bin/mori", Home: "/Users/u/Mori", Args: []string{"serve", "--home", "/Users/u/Mori"},
		Env: map[string]string{"PATH": "/usr/bin"}, LogPath: "/Users/u/Mori/mori.log", Out: io.Discard}
	const plist = "/Users/u/Library/LaunchAgents/dev.mori.plist"
	old := &running{socks: []string{"/Users/u/Mori/mori.sock"}}
	steps := darwinInstall(o, "gui/501", plist, old)
	inOrder(t, says(steps), "/Users/u/Mori", "launchctl bootout gui/501/dev.mori", "멈추", plist,
		"launchctl enable gui/501/dev.mori", "launchctl bootstrap gui/501 "+plist, "뜨기를 기다리")
	var file []byte
	for _, s := range steps {
		if s.file != nil {
			file = s.file
		}
	}
	if !bytes.Equal(file, LaunchdPlist(Label, o.Exe, o.Args, o.Env, o.LogPath)) {
		t.Errorf("the plist step writes\n%s", file)
	}
	inOrder(t, says(darwinUninstall(o, "gui/501", plist, old)), "launchctl bootout gui/501/dev.mori", plist, "멈추")
}

func TestWindowsPlan(t *testing.T) {
	var out strings.Builder
	o := Options{Exe: `C:\Mori\mori.exe`, Home: `C:\Users\u\AppData\Roaming\Mori`, Args: []string{"serve", "--home", `C:\Users\u\AppData\Roaming\Mori`},
		LogPath: `C:\Users\u\AppData\Roaming\Mori\mori.log`, Out: &out}
	old := &running{}
	steps := windowsInstall(o, `C:\Mori\moriw.exe`, old)
	value := RunKeyCommand(`C:\Mori\moriw.exe`, []string{"serve", "--home", o.Home, "--log", o.LogPath})
	inOrder(t, says(steps), o.Home, "멈추", "reg add", `CurrentVersion\Run`, "/v Mori /t REG_SZ /d", "moriw.exe", "/f", value, "뜨기를 기다리")
	if out.Len() != 0 {
		t.Errorf("a short command warned: %s", out.String())
	}
	o.Home = `C:\` + strings.Repeat("긴", 200)
	o.Args = []string{"serve", "--home", o.Home}
	windowsInstall(o, `C:\Mori\moriw.exe`, old)
	if !strings.Contains(out.String(), "260") {
		t.Errorf("a long command did not warn: %q", out.String())
	}
	inOrder(t, says(windowsUninstall(o, old)), "reg delete", `CurrentVersion\Run`, "/v Mori /f", "멈추")
}

func TestInstallDryRunChangesNothing(t *testing.T) {
	if !Supported() {
		t.Skip("서비스 설치를 지원하지 않는 OS")
	}
	dir := t.TempDir()
	exe := writeExe(t, filepath.Join(dir, "mori.exe"))
	writeExe(t, filepath.Join(dir, "moriw.exe"))
	saved := tempDirs
	tempDirs = func() []string { return []string{filepath.Join(dir, "tmp")} }
	t.Cleanup(func() { tempDirs = saved })
	home := filepath.Join(dir, "home")
	before, beforeErr := Installed()

	var out strings.Builder
	o := Options{Exe: exe, Home: home, Args: []string{"serve", "--home", home}, Env: map[string]string{"PATH": "/usr/bin"}, DryRun: true, Out: &out}
	if err := Install(o); err != nil {
		t.Fatal(err)
	}
	if err := Uninstall(o); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(home); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("the dry run made the state directory: %v", err)
	}
	if after, afterErr := Installed(); !reflect.DeepEqual(before, after) || fmt.Sprint(beforeErr) != fmt.Sprint(afterErr) {
		t.Errorf("the dry run changed the installation: %+v %v → %+v %v", before, beforeErr, after, afterErr)
	}
	switch runtime.GOOS {
	case "darwin":
		inOrder(t, out.String(), "<plist", "launchctl bootstrap gui/", "launchctl bootout gui/")
	case "windows":
		inOrder(t, out.String(), "reg add", "moriw.exe", "reg delete")
	}
}

func TestInstallRefusesTemporaryExe(t *testing.T) {
	if !Supported() {
		t.Skip("서비스 설치를 지원하지 않는 OS")
	}
	exe := writeExe(t, filepath.Join(t.TempDir(), "mori.exe")) // t.TempDir is in os.TempDir, as go run's files are
	err := Install(Options{Exe: exe, Home: t.TempDir(), DryRun: true})
	if err == nil || !strings.Contains(err.Error(), "임시") {
		t.Fatal(err)
	}
}

func TestRunningStop(t *testing.T) {
	p, exited := sleeper(t)
	sock := serveFake(t, fakeServer{pid: p.Pid, shutdown: func() { p.Kill() }})
	r := &running{socks: []string{sock, filepath.Join(filepath.Dir(sock), "none.sock")}}
	var out strings.Builder
	if err := r.stop(&out, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("stop returned while the server was running")
	}
	if !strings.Contains(out.String(), strconv.Itoa(p.Pid)) {
		t.Errorf("output %q", out.String())
	}
	// The socket still answers, with a pid that has ended: there is
	// nothing to wait for.
	if err := (&running{socks: []string{sock}}).stop(io.Discard, time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestRunningStopWaitsForThePID(t *testing.T) {
	p, _ := sleeper(t)
	sock := serveFake(t, fakeServer{pid: p.Pid}) // answers, but does not stop
	err := (&running{socks: []string{sock}}).stop(io.Discard, 300*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), strconv.Itoa(p.Pid)) {
		t.Fatal(err)
	}
}

func TestWaitUp(t *testing.T) {
	dir := shortDir(t)
	if err := waitUp(filepath.Join(dir, "mori.sock"), 500*time.Millisecond, io.Discard, "로그: X"); err == nil || !strings.Contains(err.Error(), "로그: X") {
		t.Fatal(err)
	}
	var out strings.Builder
	if err := waitUp(serveFake(t, fakeServer{pid: 4242}), 5*time.Second, &out, ""); err != nil || !strings.Contains(out.String(), "4242") {
		t.Fatal(out.String(), err)
	}
}

func writeExe(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func says(steps []step) string {
	var b strings.Builder
	for _, s := range steps {
		b.WriteString(s.say + "\n")
	}
	return b.String()
}

// inOrder fails unless each of wants is in s after the one before it.
func inOrder(t *testing.T, s string, wants ...string) {
	t.Helper()
	rest := s
	for _, w := range wants {
		i := strings.Index(rest, w)
		if i < 0 {
			t.Fatalf("%q missing or out of order in\n%s", w, s)
		}
		rest = rest[i+len(w):]
	}
}

// sleeper starts a process that sleeps, and reaps it when it ends so that
// its pid goes away.
func sleeper(t *testing.T) (*os.Process, <-chan struct{}) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "MORI_TEST_SLEEPER=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	t.Cleanup(func() { cmd.Process.Kill(); <-exited })
	return cmd.Process, exited
}

// shortDir is a temporary directory with a short path: macOS takes 104
// bytes for a socket path, and test directories there are long.
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ms")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// serveFake answers on a new admin socket as a server would.
func serveFake(t *testing.T, h admin.Handler) string {
	t.Helper()
	sock := filepath.Join(shortDir(t), "mori.sock")
	ln, err := admin.Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { admin.Serve(ctx, ln, h); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return sock
}

type fakeServer struct {
	pid      int
	shutdown func()
}

func (f fakeServer) PairCode(string) (string, string, time.Time) { return "", "", time.Time{} }
func (f fakeServer) Devices() []admin.DeviceInfo                 { return nil }
func (f fakeServer) Revoke(string) error                         { return nil }
func (f fakeServer) Status() any {
	return admin.Status{Version: "test", PID: f.pid, Listen: "127.0.0.1:7761"}
}
func (f fakeServer) Shutdown() {
	if f.shutdown != nil {
		f.shutdown()
	}
}
