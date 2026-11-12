// Command mori runs the Mori server and the commands that manage it.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"runtime"
	"strings"

	"github.com/kwonikhyeon/mori/internal/version"
)

const usage = `사용법: mori <명령> [옵션]

명령:
  serve     서버를 실행합니다
  service   로그인할 때 서버를 띄우도록 설치하거나 제거합니다 (install, uninstall)
  pair      새 기기를 페어링할 코드와 QR을 만듭니다
  devices   페어링된 기기를 봅니다
  revoke    기기의 페어링을 철회합니다
  hosts     이 허브에 이은 다른 호스트를 보고, 잇고, 끊습니다 (link, unlink)
  doctor    설치와 연결 상태를 점검합니다
  version   버전을 출력합니다
  help      이 도움말을 출력합니다

명령마다 -h로 옵션을 볼 수 있습니다.
`

// errUsage means the user has already been told what was wrong with the
// command line; main only sets the exit code.
var errUsage = errors.New("usage")

// errReported means the command has told the user what failed, as doctor
// does; main only sets the exit code.
var errReported = errors.New("reported")

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "serve":
		err = runServe(args)
	case "service":
		err = runService(args)
	case "pair":
		err = runPair(args)
	case "devices":
		err = runDevices(args)
	case "revoke":
		err = runRevoke(args)
	case "hosts":
		err = runHosts(os.Stdout, args)
	case "doctor":
		err = runDoctor(args)
	case "claude-hook": // Claude Code runs it, not a person (spec §3 #230)
		runClaudeHook(os.Getenv("HC_TERMINAL_ID"), os.Stdin, hcLabel)
	case "version", "-v", "--version":
		fmt.Printf("mori %s (%s/%s, %s)\n", version.Version, runtime.GOOS, runtime.GOARCH, runtime.Version())
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "mori: 알 수 없는 명령 %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	switch {
	case err == nil, errors.Is(err, flag.ErrHelp):
	case errors.Is(err, errUsage):
		os.Exit(2)
	case errors.Is(err, errReported):
		os.Exit(1)
	default:
		fmt.Fprintln(os.Stderr, "mori:", err)
		os.Exit(1)
	}
}

const homeUsage = "상태 디렉터리 (기본: MORI_HOME, 없으면 사용자 설정 디렉터리/Mori)"

// newFlagSet makes a command's flags; -h prints the synopsis and them.
func newFlagSet(name, synopsis string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "사용법: mori %s %s\n\n옵션:\n", name, synopsis)
		fs.PrintDefaults()
	}
	return fs
}

// parseFlags parses args, which must hold the named positional arguments;
// flags may come after them too. A name in brackets, such as "[코드]", is
// optional and goes last. Afterwards fs.Arg gives the positional arguments.
func parseFlags(fs *flag.FlagSet, args []string, positional ...string) error {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return err
			}
			return errUsage // the flag package has printed the problem and the usage
		}
		rest := fs.Args()
		if len(rest) == 0 {
			break
		}
		if n := len(args) - len(rest); n > 0 && args[n-1] == "--" { // all after -- is positional
			pos = append(pos, rest...)
			break
		}
		pos, args = append(pos, rest[0]), rest[1:]
	}
	required := 0
	for _, p := range positional {
		if !strings.HasPrefix(p, "[") {
			required++
		}
	}
	switch {
	case len(pos) > len(positional):
		fmt.Fprintf(fs.Output(), "mori %s: 알 수 없는 인자 %q\n", fs.Name(), pos[len(positional)])
		return errUsage
	case len(pos) < required:
		fmt.Fprintf(fs.Output(), "mori %s: <%s> 인자가 필요합니다\n", fs.Name(), positional[len(pos)])
		return errUsage
	}
	return fs.Parse(append([]string{"--"}, pos...)) // so that fs.Arg gives them
}
