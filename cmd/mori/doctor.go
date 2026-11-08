package main

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/kwonikhyeon/mori/internal/admin"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/paths"
	"github.com/kwonikhyeon/mori/internal/procutil"
	"github.com/kwonikhyeon/mori/internal/service"
	"github.com/kwonikhyeon/mori/internal/store"
	"github.com/kwonikhyeon/mori/internal/tailscale"
	"github.com/kwonikhyeon/mori/internal/version"
)

const (
	minHC  = "0.1.19" // the herdr-core Mori is built against (spec §2.3)
	minGit = "2.36"   // for git worktree list -z
)

// runDoctor reports what Mori needs on this machine (spec §11). It only
// reads: it starts nothing, the herdr core included, and changes no
// setting; what to run is a hint.
func runDoctor(args []string) error {
	fs := newFlagSet("doctor", "[옵션]")
	homeFlag := fs.String("home", "", homeUsage)
	hcFlag := fs.String("hc", "", "점검할 hc 실행 파일 (기본: 설치된 서비스의 --hc, 없으면 서버가 찾는 순서)")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	home, err := paths.Home(*homeFlag)
	if err != nil {
		return err
	}
	var in *service.Installation
	inErr := service.ErrUnsupported
	if service.Supported() {
		var i service.Installation
		if i, inErr = service.Installed(); inErr == nil {
			in = &i
		}
	}
	look, note := lookFor(in)

	d := &doctor{out: os.Stdout}
	d.ok(fmt.Sprintf("Mori %s (%s/%s, %s)", version.Version, runtime.GOOS, runtime.GOARCH, runtime.Version()))
	d.stateDir(home)
	st, up := d.server(home, in)
	explicit := *hcFlag
	if explicit == "" && in != nil {
		explicit = in.Flag("hc")
	}
	d.hc(explicit, look, note)
	d.git(look, note)
	listen := defaultListen
	switch {
	case up:
		listen = st.Listen
	case in != nil && in.Flag("listen") != "":
		listen = in.Flag("listen")
	}
	d.tailscale(listen)
	d.service(in, inErr, home)
	if presets, err := readPresets(home); err != nil {
		d.fail("프리셋을 읽지 못했습니다: "+err.Error(), "")
	} else {
		d.presets(presets, look, note)
	}
	return d.result()
}

// doctor tells its findings a line each: ✓ for what is right, ! for what
// works less well than it could, ✗ for what keeps Mori from working or
// leaves it open to others. Only a ✗ fails the command.
type doctor struct {
	out          io.Writer
	fails, warns int
}

func (d *doctor) ok(text string) { d.line("✓ ", text, "") }

func (d *doctor) warn(text, hint string) {
	d.warns++
	d.line("! ", text, hint)
}

func (d *doctor) fail(text, hint string) {
	d.fails++
	d.line("✗ ", text, hint)
}

// line tells a finding, and under it what to do about it.
func (d *doctor) line(mark, text, hint string) {
	fmt.Fprintf(d.out, "%s%s\n", mark, text)
	if hint == "" {
		return
	}
	for _, h := range strings.Split(hint, "\n") {
		fmt.Fprintf(d.out, "    %s\n", h)
	}
}

func (d *doctor) result() error {
	if d.fails+d.warns == 0 {
		fmt.Fprintln(d.out, "\n모두 정상입니다")
		return nil
	}
	fmt.Fprintf(d.out, "\n실패 %d개, 주의 %d개\n", d.fails, d.warns)
	if d.fails > 0 {
		return errReported
	}
	return nil
}

// stateDir checks that the state directory, which holds the hashes of the
// device tokens and the push key, is this user's alone.
func (d *doctor) stateDir(home string) {
	fi, err := os.Stat(home)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		d.warn("상태 디렉터리가 아직 없습니다: "+home, "서버가 처음 뜰 때 만듭니다")
		return
	case err != nil:
		d.fail("상태 디렉터리를 보지 못했습니다: "+err.Error(), "")
		return
	case !fi.IsDir():
		d.fail("상태 디렉터리 자리에 파일이 있습니다: "+home, "그 파일을 옮기거나 --home으로 다른 디렉터리를 쓰세요")
		return
	}
	if runtime.GOOS == "windows" { // no mode bits; the profile's ACL applies
		d.ok("상태 디렉터리: " + home)
		return
	}
	fails := d.fails
	if perm := fi.Mode().Perm(); perm&0o077 != 0 {
		d.fail(fmt.Sprintf("상태 디렉터리의 권한이 %#o라서 다른 사용자가 들어올 수 있습니다: %s", uint32(perm), home), "chmod 700 "+procutil.QuoteArg(home))
	}
	state := paths.State(home)
	if fi, err := os.Stat(state); err == nil && fi.Mode().Perm()&0o077 != 0 {
		d.fail(fmt.Sprintf("state.json의 권한이 %#o라서 다른 사용자가 읽을 수 있습니다", uint32(fi.Mode().Perm())), "chmod 600 "+procutil.QuoteArg(state))
	}
	if d.fails == fails {
		d.ok("상태 디렉터리: " + home)
	}
}

// server asks the server on home's admin socket how it is, and with it
// how its herdr core connection is. in, the installed service, says where
// to look when no server answers.
func (d *doctor) server(home string, in *service.Installation) (admin.Status, bool) {
	st, err := admin.Client{Path: paths.Socket(home)}.Status()
	if err != nil {
		hint := "mori service install로 설치하거나 mori serve로 띄우세요"
		if in != nil && filepath.Clean(in.Flag("home")) == filepath.Clean(home) {
			hint = fmt.Sprintf("서비스는 설치되어 있습니다. 로그(%s)를 보세요", cmp.Or(in.Flag("log"), paths.Log(home)))
		}
		if errors.Is(err, admin.ErrNotRunning) {
			d.fail("서버가 돌고 있지 않습니다 (상태 디렉터리 "+home+")", hint)
		} else {
			d.fail("서버에 묻지 못했습니다: "+err.Error(), hint)
		}
		return admin.Status{}, false
	}
	d.ok(fmt.Sprintf("서버: pid %d, %s, 기기 %d대", st.PID, st.Listen, st.Devices))
	if st.Version != version.Version {
		d.warn(fmt.Sprintf("서버의 버전(%s)이 이 mori(%s)와 다릅니다", st.Version, version.Version),
			"mori를 새 버전으로 바꿨다면 mori service install을 다시 실행해 서버를 새로 띄우세요")
	}
	if c := st.Core; c.Connected {
		msg := "herdr-core에 연결됨: 버전 " + c.Version
		if c.Name != "" {
			msg += ", 이름 " + c.Name
		}
		d.ok(msg)
	} else {
		d.fail("서버가 herdr-core에 연결되지 않았습니다: "+cmp.Or(c.Error, "아직 연결하는 중입니다"),
			"아래 hc 항목을 보세요. 서버는 hc connect로 코어에 붙습니다")
	}
	return st, true
}

// lookFor is how the server finds programs. A LaunchAgent's searches the
// PATH that install wrote into its plist. Otherwise doctor can only search
// its own; note, for the hints, says when it searched the service's.
func lookFor(in *service.Installation) (look func(string) (string, error), note string) {
	if runtime.GOOS == "darwin" && in != nil {
		path := in.AgentPath()
		return func(name string) (string, error) { return lookIn(name, path) },
			"서비스의 서버는 설치할 때의 PATH로 찾습니다. PATH를 바꿨다면 mori service install을 다시 실행하세요"
	}
	return exec.LookPath, ""
}

// hc reports the hc that the server runs: explicit, else the first on the
// PATH, else ~/.local/bin's, as hc.Locate finds it. hc --version does not
// touch the core; nothing else of hc is run.
func (d *doctor) hc(explicit string, look func(string) (string, error), note string) {
	p, err := findHC(explicit, look)
	if err != nil {
		d.fail("hc를 찾지 못했습니다", joinHints("herdr-core를 설치하세요. 다른 곳에 두었다면 mori service install --hc <경로>로 알려 주세요", note))
		return
	}
	out, err := commandVersion(p, "--version")
	if err != nil {
		d.fail(fmt.Sprintf("hc --version 실패: %v (%s)", err, p), "")
		return
	}
	if v := firstVersion(out); !versionAtLeast(v, minHC) {
		d.warn(fmt.Sprintf("hc %s 이상이 필요합니다: %s (%s)", minHC, out, p), "herdr-core를 업데이트하세요")
	} else {
		d.ok(fmt.Sprintf("hc %s: %s", v, p))
	}
}

func findHC(explicit string, look func(string) (string, error)) (string, error) {
	if explicit != "" {
		return hc.Locate(explicit)
	}
	if p, err := look("hc"); err == nil {
		return p, nil
	}
	if home, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(home, ".local", "bin", "hc")
		if runtime.GOOS == "windows" {
			p += ".exe"
		}
		if isExec(p) {
			return p, nil
		}
	}
	return "", exec.ErrNotFound
}

// git reports the git that the server runs for the Git views and
// worktrees. Without it the rest of Mori works.
func (d *doctor) git(look func(string) (string, error), note string) {
	p, err := look("git")
	if err != nil {
		d.warn("git을 찾지 못했습니다", joinHints(fmt.Sprintf("브랜치·워크트리·변경 보기를 쓰려면 git %s 이상을 설치하세요", minGit), note))
		return
	}
	out, err := commandVersion(p, "--version")
	if err != nil {
		d.warn(fmt.Sprintf("git --version 실패: %v (%s)", err, p), "")
		return
	}
	if v := firstVersion(out); !versionAtLeast(v, minGit) {
		d.warn(fmt.Sprintf("git %s 이상이 필요합니다: %s (%s)", minGit, out, p), "git을 업데이트하세요")
	} else {
		d.ok(fmt.Sprintf("git %s: %s", v, p))
	}
}

// tailscale reports this machine's name in the tailnet and whether
// tailscale serve forwards to the server, which is how other devices
// reach it. It runs tailscale status and tailscale serve status only.
func (d *doctor) tailscale(listen string) {
	if _, err := tailscale.Find(); err != nil {
		d.warn("Tailscale을 찾지 못했습니다. 이 컴퓨터에서만 Mori를 열 수 있습니다", "다른 기기에서 쓰려면 Tailscale을 설치하고 로그인하세요")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	name, err := tailscale.DNSName(ctx)
	if err != nil {
		d.warn("Tailscale 이름을 알지 못했습니다: "+err.Error(), "tailscale up으로 로그인하고, tailnet 관리 콘솔에서 MagicDNS를 켜세요")
		return
	}
	targets := serveTargets(listen)
	if len(targets) == 0 {
		d.warn("서버의 수신 주소를 알 수 없습니다: "+listen, "")
		return
	}
	cfg, err := tailscale.ServeStatus(ctx)
	if err != nil {
		d.warn("tailscale serve 설정을 읽지 못했습니다: "+err.Error(), "")
		return
	}
	for _, t := range targets {
		if tailscale.ProxiesTo(cfg, t) {
			d.ok(fmt.Sprintf("tailscale serve: https://%s → %s", name, t))
			return
		}
	}
	d.warn(fmt.Sprintf("tailscale serve가 Mori로 넘겨 주지 않아, 다른 기기에서 https://%s 주소로 열 수 없습니다", name),
		"tailscale serve --bg "+targets[0]+"\ntailnet 관리 콘솔에서 MagicDNS와 HTTPS 인증서가 켜져 있어야 합니다")
}

// serveTargets are the tailscale serve targets that reach a server on
// listen, the one to suggest first.
func serveTargets(listen string) []string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return nil
	}
	if host == "localhost" {
		host = "127.0.0.1" // where the server listens: Go listens on a name's IPv4 address
	}
	targets := []string{"http://" + net.JoinHostPort(host, port)}
	if host == "127.0.0.1" || host == "::1" {
		targets = append(targets, "http://"+net.JoinHostPort("localhost", port))
	}
	return targets
}

// service reports the installed service. inErr is why in is nil.
func (d *doctor) service(in *service.Installation, inErr error, home string) {
	switch {
	case errors.Is(inErr, service.ErrUnsupported):
		d.warn(inErr.Error(), "")
		return
	case errors.Is(inErr, service.ErrNotInstalled):
		d.warn("서비스가 설치되어 있지 않습니다", "mori service install로 설치하면 로그인할 때마다 서버가 뜹니다")
		return
	case inErr != nil:
		d.fail("설치된 서비스를 읽지 못했습니다: "+inErr.Error(), "mori service install을 다시 실행하세요")
		return
	}
	if exe := in.Args[0]; !isExec(exe) {
		d.fail("서비스가 실행할 파일이 없습니다: "+exe, "mori를 옮기거나 지웠다면, 둘 곳에 놓고 mori service install을 다시 실행하세요")
	} else {
		d.ok(fmt.Sprintf("서비스: %s (%s)", in.Where, exe))
	}
	if h := in.Flag("home"); h != "" && filepath.Clean(h) != filepath.Clean(home) {
		d.warn("서비스의 서버는 다른 상태 디렉터리를 씁니다: "+h, "그 서버를 점검하려면: mori doctor --home "+quoteShell(h))
	}
}

// presets reports whether the programs of the presets are there to start.
// The core runs them, with the environment of the client that started it:
// at login, the server.
func (d *doctor) presets(presets []store.Preset, look func(string) (string, error), note string) {
	for _, p := range presets {
		if len(p.Argv) == 0 {
			continue // the machine's shell
		}
		if path, err := look(p.Argv[0]); err == nil {
			d.ok(fmt.Sprintf("프리셋 %s: %s", p.Name, path))
		} else {
			d.warn(fmt.Sprintf("프리셋 %s의 실행 파일을 찾지 못했습니다: %s", p.Name, p.Argv[0]),
				joinHints("설치하거나, 쓰지 않으면 설정에서 그 프리셋을 지우세요", note))
		}
	}
}

// readPresets reads the presets from state.json as the server would,
// without opening the store, which would write the file.
func readPresets(home string) ([]store.Preset, error) {
	b, err := os.ReadFile(paths.State(home))
	if errors.Is(err, fs.ErrNotExist) {
		return store.DefaultPresets(), nil
	}
	if err != nil {
		return nil, err
	}
	var st store.State
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, fmt.Errorf("%s: %w", paths.State(home), err)
	}
	if st.Presets == nil {
		return store.DefaultPresets(), nil
	}
	return st.Presets, nil
}

// lookIn finds the program name in the directories of path, as a shell
// does; a name with a slash is taken as it is. Empty and relative entries
// are passed over, as service.AgentEnv drops them.
func lookIn(name, path string) (string, error) {
	if strings.ContainsRune(name, '/') {
		if isExec(name) {
			return name, nil
		}
		return "", exec.ErrNotFound
	}
	for _, dir := range filepath.SplitList(path) {
		if !filepath.IsAbs(dir) {
			continue
		}
		if p := filepath.Join(dir, name); isExec(p) {
			return p, nil
		}
	}
	return "", exec.ErrNotFound
}

func isExec(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular() && (runtime.GOOS == "windows" || fi.Mode().Perm()&0o111 != 0)
}

// commandVersion runs a program's version option and returns what it
// printed. One that hangs is given up on.
func commandVersion(path string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	procutil.HideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

var versionRE = regexp.MustCompile(`\d+(?:\.\d+)+`)

// firstVersion is the first dotted number in s, such as 2.39.5 in "git
// version 2.39.5.windows.1".
func firstVersion(s string) string { return versionRE.FindString(s) }

func versionAtLeast(v, min string) bool { return v != "" && compareVersions(v, min) >= 0 }

// compareVersions compares dotted numbers part by part; a missing part is
// 0.
func compareVersions(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := range max(len(as), len(bs)) {
		var x, y int
		if i < len(as) {
			x, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			y, _ = strconv.Atoi(bs[i])
		}
		if c := cmp.Compare(x, y); c != 0 {
			return c
		}
	}
	return 0
}

func joinHints(hints ...string) string {
	var keep []string
	for _, h := range hints {
		if h != "" {
			keep = append(keep, h)
		}
	}
	return strings.Join(keep, "\n")
}

// quoteShell quotes s for the shell that a hint is typed into.
func quoteShell(s string) string {
	if runtime.GOOS == "windows" {
		return procutil.QuoteWinArg(s)
	}
	return procutil.QuoteArg(s)
}
