package service

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

const launchctl = "/bin/launchctl"

// LaunchdPlist is a LaunchAgent that runs exe with args at login and again
// whenever it ends, with env as its environment and its output in logPath.
func LaunchdPlist(label, exe string, args []string, env map[string]string, logPath string) []byte {
	var b bytes.Buffer
	b.WriteString(xml.Header)
	b.WriteString(`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">` + "\n")
	b.WriteString("<plist version=\"1.0\">\n<dict>\n")
	key := func(indent, k string) { fmt.Fprintf(&b, "%s<key>%s</key>\n", indent, escape(k)) }
	str := func(indent, s string) { fmt.Fprintf(&b, "%s<string>%s</string>\n", indent, escape(s)) }
	key("\t", "Label")
	str("\t", label)
	key("\t", "ProgramArguments")
	b.WriteString("\t<array>\n")
	for _, a := range append([]string{exe}, args...) {
		str("\t\t", a)
	}
	b.WriteString("\t</array>\n")
	if len(env) > 0 {
		key("\t", "EnvironmentVariables")
		b.WriteString("\t<dict>\n")
		for _, k := range slices.Sorted(maps.Keys(env)) {
			key("\t\t", k)
			str("\t\t", env[k])
		}
		b.WriteString("\t</dict>\n")
	}
	key("\t", "RunAtLoad")
	b.WriteString("\t<true/>\n")
	key("\t", "KeepAlive")
	b.WriteString("\t<true/>\n")
	key("\t", "ProcessType") // not throttled as a background job is
	str("\t", "Interactive")
	key("\t", "StandardOutPath")
	str("\t", logPath)
	key("\t", "StandardErrorPath")
	str("\t", logPath)
	b.WriteString("</dict>\n</plist>\n")
	return b.Bytes()
}

func escape(s string) string {
	var b strings.Builder
	xml.EscapeText(&b, []byte(s))
	return b.String()
}

var (
	localeVars = []string{"LANG", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME"}
	xdgVars    = []string{"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"}
)

// AgentEnv picks from environ what the LaunchAgent's server needs of the
// shell that installs it: the PATH that finds hc, git and the presets'
// commands, the locale, and the XDG directories that hc keeps its files
// in. launchd gives HOME, USER, SHELL and TMPDIR itself. All else, tokens
// and keys among it, stays out of the plist, and so out of the herdr core
// the server starts and the sessions in it.
func AgentEnv(environ []string) map[string]string {
	env := map[string]string{}
	seen := map[string]bool{}
	for _, kv := range environ {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || seen[k] {
			continue
		}
		seen[k] = true
		switch {
		case k == "PATH":
			if p := absPath(v); p != "" {
				env[k] = p
			}
		case slices.Contains(localeVars, k):
			if v != "" {
				env[k] = v
			}
		case slices.Contains(xdgVars, k):
			if filepath.IsAbs(v) {
				env[k] = filepath.Clean(v)
			}
		}
	}
	return env
}

// absPath keeps the absolute entries of a PATH, each once: an empty or
// relative one would search the server's working directory.
func absPath(list string) string {
	var keep []string
	for _, dir := range filepath.SplitList(list) {
		if !filepath.IsAbs(dir) {
			continue
		}
		if dir = filepath.Clean(dir); !slices.Contains(keep, dir) {
			keep = append(keep, dir)
		}
	}
	return strings.Join(keep, string(filepath.ListSeparator))
}

// node is any XML element, to walk a plist with.
type node struct {
	XMLName xml.Name
	Text    string `xml:",chardata"`
	Kids    []node `xml:",any"`
}

// parsePlist reads the command and environment back from a LaunchAgent.
func parsePlist(b []byte) (Installation, error) {
	var root node
	if err := xml.Unmarshal(b, &root); err != nil {
		return Installation{}, err
	}
	if root.XMLName.Local != "plist" || len(root.Kids) != 1 || root.Kids[0].XMLName.Local != "dict" {
		return Installation{}, errors.New("LaunchAgent plist가 아닙니다")
	}
	var in Installation
	if a, ok := dictGet(root.Kids[0], "ProgramArguments"); ok && a.XMLName.Local == "array" {
		for _, s := range a.Kids {
			in.Args = append(in.Args, s.Text)
		}
	}
	if len(in.Args) == 0 {
		return Installation{}, errors.New("실행할 명령(ProgramArguments)이 없습니다")
	}
	if e, ok := dictGet(root.Kids[0], "EnvironmentVariables"); ok && e.XMLName.Local == "dict" {
		in.Env = map[string]string{}
		for i := 0; i+1 < len(e.Kids); i += 2 {
			if e.Kids[i].XMLName.Local == "key" {
				in.Env[e.Kids[i].Text] = e.Kids[i+1].Text
			}
		}
	}
	return in, nil
}

// dictGet is the value under key in a plist dict.
func dictGet(d node, key string) (node, bool) {
	for i := 0; i+1 < len(d.Kids); i += 2 {
		if d.Kids[i].XMLName.Local == "key" && d.Kids[i].Text == key {
			return d.Kids[i+1], true
		}
	}
	return node{}, false
}

func plistPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", Label+".plist"), nil
}

// darwinTarget is the launchd domain of this user's login session, and
// the path of the plist.
func darwinTarget() (domain, plist string, err error) {
	uid := os.Getuid()
	if uid == 0 {
		return "", "", errors.New("root로는 설치하거나 지우지 않습니다. sudo 없이 실행하세요")
	}
	if plist, err = plistPath(); err != nil {
		return "", "", err
	}
	return "gui/" + strconv.Itoa(uid), plist, nil
}

func darwinInstall(o Options, domain, plist string, old *running) []step {
	target := domain + "/" + Label
	b := LaunchdPlist(Label, o.Exe, o.Args, o.Env, o.LogPath)
	return []step{
		mkdirStep(o.Home), // launchd opens the log there before it starts the server
		bootoutStep(target, old),
		old.step(),
		{say: "쓰기: " + plist, file: b, do: func(io.Writer) error { return writePlist(plist, b) }},
		{say: "실행: " + shown("launchctl", "enable", target), do: func(io.Writer) error {
			if out, err := exec.Command(launchctl, "enable", target).CombinedOutput(); err != nil {
				return fmt.Errorf("launchctl enable 실패: %v: %s", err, bytes.TrimSpace(out))
			}
			return nil
		}},
		{say: "실행: " + shown("launchctl", "bootstrap", domain, plist), do: func(io.Writer) error {
			return bootstrap(domain, plist, target)
		}},
		waitStep(o.Home, fmt.Sprintf("로그(%s)와 %s의 출력을 보세요", o.LogPath, shown("launchctl", "print", target))),
	}
}

func darwinUninstall(o Options, domain, plist string, old *running) []step {
	return []step{
		bootoutStep(domain+"/"+Label, old),
		{say: "지우기: " + plist, do: func(out io.Writer) error {
			err := os.Remove(plist)
			if errors.Is(err, fs.ErrNotExist) {
				fmt.Fprintln(out, "   plist가 없습니다")
				return nil
			}
			return err
		}},
		old.step(),
	}
}

// bootoutStep takes the loaded service down, with its server. It asks the
// sockets for their servers first: once launchd has stopped one, its
// socket is gone, and old.step must still wait for its process to end.
func bootoutStep(target string, old *running) step {
	return step{say: "실행: " + shown("launchctl", "bootout", target) + " (설치되어 있던 서비스를 내립니다. 없으면 넘어갑니다)", do: func(io.Writer) error {
		old.find()
		exec.Command(launchctl, "bootout", target).Run() // fails when nothing is loaded
		return nil
	}}
}

func writePlist(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return err
	}
	return os.Chmod(path, 0o644) // WriteFile keeps the mode of a file that was there; launchd refuses one others can write
}

// bootstrap loads the plist into the login session. launchd may still be
// taking the old service down, so a refusal is tried again a few times.
func bootstrap(domain, plist, target string) error {
	var out []byte
	var err error
	for i := range 5 {
		if i > 0 {
			time.Sleep(500 * time.Millisecond)
		}
		if out, err = exec.Command(launchctl, "bootstrap", domain, plist).CombinedOutput(); err == nil {
			return nil
		}
	}
	return fmt.Errorf("launchctl bootstrap 실패: %v: %s. 이 사용자로 macOS 화면에 로그인되어 있어야 합니다. 자세한 상태는 %s로 보세요",
		err, bytes.TrimSpace(out), shown("launchctl", "print", target))
}
