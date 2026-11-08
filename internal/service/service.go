// Package service installs Mori as a service of this user that starts at
// login: a LaunchAgent on macOS, a value under the Run key on Windows
// (spec §11). Other systems run mori serve themselves (spec §14).
package service

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/kwonikhyeon/mori/internal/admin"
	"github.com/kwonikhyeon/mori/internal/paths"
	"github.com/kwonikhyeon/mori/internal/procutil"
)

// Label names the LaunchAgent.
const Label = "dev.mori"

const (
	stopTimeout = 10 * time.Second // for the servers an install replaces to end
	upTimeout   = 20 * time.Second // for the installed one to answer
)

// Options is what to install.
type Options struct {
	Exe     string            // the mori executable, absolute
	Home    string            // the state directory, absolute
	Args    []string          // after Exe; serve --home Home by default
	Env     map[string]string // the LaunchAgent's environment; on Windows the server gets the login environment
	LogPath string            // the server's output; paths.Log(Home) by default
	DryRun  bool              // tell the steps and do none of them
	Out     io.Writer         // where the steps are told; io.Discard by default
}

var (
	// ErrNotInstalled means there is no service to read or remove.
	ErrNotInstalled = errors.New("서비스가 설치되지 않았습니다")
	// ErrUnsupported means Mori does not install a service on this OS.
	ErrUnsupported = fmt.Errorf("이 OS(%s)에는 서비스 설치를 아직 지원하지 않습니다. mori serve를 직접 띄우세요", runtime.GOOS)
)

// Supported reports whether Mori installs a service on this OS.
func Supported() bool { return runtime.GOOS == "darwin" || runtime.GOOS == "windows" }

// Installation is the service as installed.
type Installation struct {
	Where string            // the file or registry value that holds it
	Args  []string          // the command, the executable first
	Env   map[string]string // the LaunchAgent's environment
}

// Flag returns what the command gives the flag name, or "".
func (in Installation) Flag(name string) string {
	for i := 1; i < len(in.Args); i++ {
		a, ok := strings.CutPrefix(in.Args[i], "-")
		if !ok {
			continue
		}
		a = strings.TrimPrefix(a, "-")
		if a == name {
			if i+1 < len(in.Args) {
				return in.Args[i+1]
			}
			return ""
		}
		if v, ok := strings.CutPrefix(a, name+"="); ok {
			return v
		}
	}
	return ""
}

// AgentPath is the PATH that the LaunchAgent's server searches, and with
// it a herdr core the server starts.
func (in Installation) AgentPath() string {
	if p := in.Env["PATH"]; p != "" {
		return p
	}
	return "/usr/bin:/bin:/usr/sbin:/sbin" // launchd's own
}

func (o Options) withDefaults() (Options, error) {
	if !filepath.IsAbs(o.Home) {
		return o, fmt.Errorf("상태 디렉터리는 절대 경로여야 합니다: %q", o.Home)
	}
	if len(o.Args) == 0 {
		o.Args = []string{"serve", "--home", o.Home}
	}
	if o.LogPath == "" {
		o.LogPath = paths.Log(o.Home)
	}
	if o.Out == nil {
		o.Out = io.Discard
	}
	return o, nil
}

// Install installs the service, stops the servers it replaces, starts it,
// and waits for it to answer. A dry run checks the same and tells the
// steps instead.
func Install(o Options) error {
	if !Supported() {
		return ErrUnsupported
	}
	o, err := o.withDefaults()
	if err != nil {
		return err
	}
	if !filepath.IsAbs(o.Exe) {
		return fmt.Errorf("실행 파일은 절대 경로여야 합니다: %q", o.Exe)
	}
	if err := checkExe(o.Exe, tempDirs()...); err != nil {
		return err
	}
	old := replaced(o.Home)
	if runtime.GOOS == "darwin" {
		domain, plist, err := darwinTarget()
		if err != nil {
			return err
		}
		return run(o, darwinInstall(o, domain, plist, old))
	}
	gui, err := guiExe(o.Exe)
	if err != nil {
		return err
	}
	return run(o, windowsInstall(o, gui, old))
}

// Uninstall removes the service and stops the servers on its state
// directory and o.Home. It leaves the state directory, and the herdr core
// with its sessions.
func Uninstall(o Options) error {
	if !Supported() {
		return ErrUnsupported
	}
	o, err := o.withDefaults()
	if err != nil {
		return err
	}
	old := replaced(o.Home)
	if runtime.GOOS == "darwin" {
		domain, plist, err := darwinTarget()
		if err != nil {
			return err
		}
		return run(o, darwinUninstall(o, domain, plist, old))
	}
	return run(o, windowsUninstall(o, old))
}

// Installed reads the installed service, or returns ErrNotInstalled.
func Installed() (Installation, error) {
	switch runtime.GOOS {
	case "darwin":
		p, err := plistPath()
		if err != nil {
			return Installation{}, err
		}
		b, err := os.ReadFile(p)
		if errors.Is(err, fs.ErrNotExist) {
			return Installation{}, ErrNotInstalled
		}
		if err != nil {
			return Installation{}, err
		}
		in, err := parsePlist(b)
		if err != nil {
			return Installation{}, fmt.Errorf("%s를 읽지 못했습니다: %w", p, err)
		}
		in.Where = p
		return in, nil
	case "windows":
		v, err := runKeyValue()
		if err != nil {
			return Installation{}, err
		}
		args := splitWinArgs(v)
		if len(args) == 0 {
			return Installation{}, fmt.Errorf("%s의 %s 값이 비어 있습니다", runKey, runValue)
		}
		return Installation{Where: runKey + " (값 " + runValue + ")", Args: args}, nil
	}
	return Installation{}, ErrNotInstalled
}

// replaced is the servers a new installation replaces: the one on home,
// and the one on the state directory that the installed service names.
func replaced(home string) *running {
	r := &running{socks: []string{paths.Socket(home)}}
	if in, err := Installed(); err == nil {
		if h := in.Flag("home"); h != "" && filepath.Clean(h) != filepath.Clean(home) {
			r.socks = append(r.socks, paths.Socket(h))
		}
	}
	return r
}

// step is one thing an install or uninstall does, told before it is done.
type step struct {
	say  string
	file []byte // what the step writes, shown by a dry run
	do   func(out io.Writer) error
}

// run does the steps in order and stops at the first that fails. A dry
// run only tells them.
func run(o Options, steps []step) error {
	for i, s := range steps {
		fmt.Fprintf(o.Out, "%d. %s\n", i+1, s.say)
		if o.DryRun {
			if s.file != nil {
				for _, line := range strings.Split(strings.TrimSuffix(string(s.file), "\n"), "\n") {
					fmt.Fprintf(o.Out, "   %s\n", line)
				}
			}
			continue
		}
		if err := s.do(o.Out); err != nil {
			return err
		}
	}
	return nil
}

func mkdirStep(home string) step {
	return step{say: "상태 디렉터리 만들기: " + home, do: func(io.Writer) error {
		return os.MkdirAll(home, 0o700)
	}}
}

func waitStep(home, hint string) step {
	sock := paths.Socket(home)
	return step{say: fmt.Sprintf("서버가 뜨기를 기다리기 (최대 %g초)", upTimeout.Seconds()), do: func(out io.Writer) error {
		return waitUp(sock, upTimeout, out, hint)
	}}
}

// running is the servers that an install or uninstall stops: those that
// answer on socks, and those that answered there before.
type running struct {
	socks []string
	pids  []int
}

// find asks the sockets for their servers' pids. A server that does not
// answer has none to give.
func (r *running) find() {
	for _, sock := range r.socks {
		st, err := admin.Client{Path: sock}.Status()
		if err == nil && st.PID > 0 && !slices.Contains(r.pids, st.PID) {
			r.pids = append(r.pids, st.PID)
		}
	}
}

// stop asks the servers to shut down and waits until their processes have
// ended, so that the next server can take the port and the socket.
func (r *running) stop(out io.Writer, timeout time.Duration) error {
	r.find()
	for _, sock := range r.socks {
		admin.Client{Path: sock}.Do(admin.Request{Op: "shutdown"}) // a server that is not there has nothing to stop
	}
	if len(r.pids) == 0 {
		fmt.Fprintln(out, "   돌고 있는 서버가 없습니다")
		return nil
	}
	deadline := time.Now().Add(timeout)
	for _, pid := range r.pids {
		if !waitExit(pid, time.Until(deadline)) {
			return fmt.Errorf("이전 Mori 서버(pid %d)가 %g초 안에 끝나지 않았습니다. 그 프로세스를 끝낸 뒤 다시 실행하세요", pid, timeout.Seconds())
		}
		fmt.Fprintf(out, "   멈췄습니다: pid %d\n", pid)
	}
	return nil
}

func (r *running) step() step {
	return step{say: "돌고 있는 Mori 서버를 멈추고 끝나기를 기다리기 (관리 소켓 " + strings.Join(r.socks, ", ") + ")", do: func(out io.Writer) error {
		return r.stop(out, stopTimeout)
	}}
}

// waitUp waits up to timeout for a server to answer on sock and tells
// which one did. hint says where to look when none does.
func waitUp(sock string, timeout time.Duration, out io.Writer, hint string) error {
	deadline := time.Now().Add(timeout)
	for {
		st, err := admin.Client{Path: sock}.Status()
		if err == nil {
			fmt.Fprintf(out, "   서버가 떴습니다: pid %d, %s, 버전 %s\n", st.PID, st.Listen, st.Version)
			return nil
		}
		if time.Now().After(deadline) {
			msg := fmt.Sprintf("서버가 %g초 안에 뜨지 않았습니다", timeout.Seconds())
			if !errors.Is(err, admin.ErrNotRunning) {
				msg += " (" + err.Error() + ")"
			}
			if hint != "" {
				msg += ". " + hint
			}
			return errors.New(msg)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// checkExe makes sure that exe is a file and will stay where it is: a
// service that points into a temporary directory, as go run builds in,
// stops starting once that is cleaned.
func checkExe(exe string, temps ...string) error {
	fi, err := os.Stat(exe)
	if err != nil {
		return fmt.Errorf("실행 파일을 찾지 못했습니다: %w", err)
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("실행 파일이 아닙니다: %s", exe)
	}
	real := resolve(exe)
	userHome, _ := os.UserHomeDir()
	for _, t := range temps {
		if t == "" {
			continue
		}
		dir := resolve(t)
		if dir == filepath.Dir(dir) || userHome != "" && dir == resolve(userHome) {
			continue // a TMPDIR of / or ~ would refuse every place
		}
		if within(dir, real) {
			return fmt.Errorf("실행 파일이 임시 디렉터리(%s) 안에 있습니다: %s. 지워질 수 있으니 계속 둘 곳에 옮긴 뒤 다시 설치하세요. go run으로 띄운 mori로는 설치할 수 없습니다", t, exe)
		}
	}
	return nil
}

// tempDirs is where files may be cleaned away.
var tempDirs = func() []string {
	dirs := []string{os.TempDir()}
	if runtime.GOOS != "windows" {
		dirs = append(dirs, "/tmp", "/var/tmp")
	}
	return dirs
}

// resolve is p absolute, through its links.
func resolve(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	if a, err := filepath.Abs(p); err == nil {
		p = a
	}
	return filepath.Clean(p)
}

// within reports whether path is dir or below it.
func within(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// shown is a command as one would type it in a POSIX shell.
func shown(name string, args ...string) string {
	return joinQuoted(procutil.QuoteArg, name, args)
}

// shownWin is a command as one would type it in cmd.exe.
func shownWin(name string, args ...string) string {
	return joinQuoted(procutil.QuoteWinArg, name, args)
}

func joinQuoted(quote func(string) string, name string, args []string) string {
	var b strings.Builder
	b.WriteString(name)
	for _, a := range args {
		b.WriteString(" " + quote(a))
	}
	return b.String()
}
