// Command mori runs the Mori server and the commands that manage it.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"runtime"

	"github.com/kwonikhyeon/mori/internal/version"
)

const usage = `사용법: mori <명령> [옵션]

명령:
  serve     서버를 실행합니다
  version   버전을 출력합니다
  help      이 도움말을 출력합니다

명령마다 -h로 옵션을 볼 수 있습니다.
`

// errUsage means the user has already been told what was wrong with the
// command line; main only sets the exit code.
var errUsage = errors.New("usage")

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
	case "version", "-v", "--version":
		fmt.Printf("mori %s (%s/%s)\n", version.Version, runtime.GOOS, runtime.GOARCH)
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
	default:
		fmt.Fprintln(os.Stderr, "mori:", err)
		os.Exit(1)
	}
}

// parseFlags parses args and rejects leftover positional arguments.
func parseFlags(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return err
		}
		return errUsage // the flag package has printed the problem and the usage
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(fs.Output(), "mori %s: 알 수 없는 인자 %q\n", fs.Name(), fs.Arg(0))
		return errUsage
	}
	return nil
}
