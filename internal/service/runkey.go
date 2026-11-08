package service

import (
	"bytes"
	"cmp"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/kwonikhyeon/mori/internal/procutil"
)

const (
	runKey   = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	runValue = "Mori"
	// "The data value for a key is a command line no longer than 260
	// characters." (Run and RunOnce Registry Keys, Microsoft Learn)
	maxRunCommand = 260
)

// RunKeyCommand is the command line under the Run key that starts exe with
// args: exe in quotes, which a path with spaces needs, and each argument
// quoted so that moriw.exe splits them back as they were.
func RunKeyCommand(exe string, args []string) string {
	var b strings.Builder
	b.WriteString(`"` + exe + `"`)
	for _, a := range args {
		b.WriteString(" " + procutil.QuoteWinArg(a))
	}
	return b.String()
}

// guiExe is moriw.exe beside exe: the build of mori that opens no console
// window, for the Run key to start.
func guiExe(exe string) (string, error) {
	if strings.EqualFold(filepath.Base(exe), "moriw.exe") {
		return exe, nil
	}
	gui := filepath.Join(filepath.Dir(exe), "moriw.exe")
	if fi, err := os.Stat(gui); err == nil && fi.Mode().IsRegular() {
		return gui, nil
	}
	return "", fmt.Errorf("%s 옆에 moriw.exe가 없습니다. 릴리스의 mori.exe와 moriw.exe를 같은 폴더에 두세요", exe)
}

func regExe() string {
	return filepath.Join(cmp.Or(os.Getenv("SystemRoot"), `C:\Windows`), "System32", "reg.exe")
}

// reg runs reg.exe, which writes the registry: package syscall only reads it.
func reg(args ...string) error {
	cmd := exec.Command(regExe(), args...)
	procutil.HideWindow(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("레지스트리를 바꾸지 못했습니다(reg %s): %v: %s", args[0], err, bytes.TrimSpace(out))
	}
	return nil
}

func windowsInstall(o Options, gui string, old *running) []step {
	args := append(slices.Clip(o.Args), "--log", o.LogPath) // moriw.exe has no console to write to
	value := RunKeyCommand(gui, args)
	if n := len(utf16.Encode([]rune(value))); n > maxRunCommand {
		fmt.Fprintf(o.Out, "주의: Run 키 명령이 %d자입니다. Windows는 %d자까지만 실행을 보장하니, 로그인할 때 서버가 뜨지 않을 수 있습니다. mori와 상태 디렉터리를 더 짧은 경로에 두세요\n", n, maxRunCommand)
	}
	add := []string{"add", runKey, "/v", runValue, "/t", "REG_SZ", "/d", value, "/f"}
	return []step{
		mkdirStep(o.Home),
		old.step(),
		{say: "실행: " + shownWin("reg", add...), do: func(io.Writer) error { return reg(add...) }},
		{say: "지금 띄우기: " + value, do: func(out io.Writer) error { return startDetached(out, gui, args, o.Home) }},
		waitStep(o.Home, fmt.Sprintf("로그(%s)를 보세요", o.LogPath)),
	}
}

func windowsUninstall(o Options, old *running) []step {
	del := []string{"delete", runKey, "/v", runValue, "/f"}
	return []step{
		{say: "실행: " + shownWin("reg", del...), do: func(out io.Writer) error {
			if _, err := runKeyValue(); errors.Is(err, ErrNotInstalled) {
				fmt.Fprintln(out, "   Run 키 값이 없습니다")
				return nil
			}
			return reg(del...)
		}},
		old.step(),
	}
}

// splitWinArgs splits a command line as a Go program on Windows splits its
// own into os.Args, as moriw.exe does with the Run key's command. The
// three functions are those of Go's os/exec_windows.go (Copyright 2009
// The Go Authors, BSD license). Go keeps the rule from before 2008 for ""
// in quotes, where today's C runtime differs; RunKeyCommand never writes
// that.
func splitWinArgs(cmd string) []string {
	var args []string
	for len(cmd) > 0 {
		if cmd[0] == ' ' || cmd[0] == '\t' {
			cmd = cmd[1:]
			continue
		}
		var arg []byte
		arg, cmd = readNextArg(cmd)
		args = append(args, string(arg))
	}
	return args
}

func readNextArg(cmd string) (arg []byte, rest string) {
	var b []byte
	var inquote bool
	var nslash int
	for ; len(cmd) > 0; cmd = cmd[1:] {
		c := cmd[0]
		switch c {
		case ' ', '\t':
			if !inquote {
				return appendBSBytes(b, nslash), cmd[1:]
			}
		case '"':
			b = appendBSBytes(b, nslash/2)
			if nslash%2 == 0 {
				// use "Prior to 2008" rule from
				// http://daviddeley.com/autohotkey/parameters/parameters.htm
				// section 5.2 to deal with double double quotes
				if inquote && len(cmd) > 1 && cmd[1] == '"' {
					b = append(b, c)
					cmd = cmd[1:]
				}
				inquote = !inquote
			} else {
				b = append(b, c)
			}
			nslash = 0
			continue
		case '\\':
			nslash++
			continue
		}
		b = appendBSBytes(b, nslash)
		nslash = 0
		b = append(b, c)
	}
	return appendBSBytes(b, nslash), ""
}

func appendBSBytes(b []byte, n int) []byte {
	for ; n > 0; n-- {
		b = append(b, '\\')
	}
	return b
}
