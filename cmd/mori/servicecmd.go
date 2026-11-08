package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/paths"
	"github.com/kwonikhyeon/mori/internal/service"
	"github.com/kwonikhyeon/mori/internal/tailscale"
)

const serviceUsage = `사용법: mori service <명령> [옵션]

명령:
  install     로그인할 때 서버를 띄우도록 설치하고 지금 띄웁니다
  uninstall   설치를 지우고 서버를 멈춥니다. 상태 디렉터리는 남깁니다

명령마다 -h로 옵션을 볼 수 있습니다.
`

func runService(args []string) error {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, serviceUsage)
		return errUsage
	}
	switch args[0] {
	case "install":
		return runServiceInstall(args[1:])
	case "uninstall":
		return runServiceUninstall(args[1:])
	case "help", "-h", "--help":
		fmt.Print(serviceUsage)
		return nil
	}
	fmt.Fprintf(os.Stderr, "mori service: 알 수 없는 명령 %q\n\n%s", args[0], serviceUsage)
	return errUsage
}

const dryRunUsage = "할 일을 보여 주기만 하고 아무것도 바꾸지 않습니다"

func runServiceInstall(args []string) error {
	fs := newFlagSet("service install", "[옵션]")
	homeFlag := fs.String("home", "", homeUsage)
	listen := fs.String("listen", defaultListen, "서버의 수신 주소. 루프백만 허용합니다")
	publicFlag := fs.String("public-url", "", "기기가 서버에 닿는 주소, 페어링 링크에 씁니다 (기본: Tailscale 이름으로 https://<이름>)")
	hcFlag := fs.String("hc", "", "hc 실행 파일 (기본: 서버가 뜰 때마다 PATH, 다음 ~/.local/bin/hc에서 찾습니다)")
	hcSession := fs.String("hc-session", os.Getenv("HC_SESSION"), "herdr-core 세션 (기본: 이 셸의 HC_SESSION, 없으면 hc의 기본 세션)")
	dryRun := fs.Bool("dry-run", false, dryRunUsage)
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if !service.Supported() {
		return service.ErrUnsupported
	}
	if err := checkLoopback(*listen); err != nil {
		return err
	}
	if err := checkPublicURL(*publicFlag); err != nil {
		return err
	}
	hcPath := ""
	if *hcFlag != "" {
		p, err := hc.Locate(*hcFlag)
		if err != nil {
			return fmt.Errorf("--hc %q: %w", *hcFlag, err)
		}
		hcPath = p
	} else if _, err := hc.Locate(""); err != nil {
		fmt.Fprintln(os.Stderr, "주의: hc를 찾지 못했습니다. 서버는 뜨지만, herdr-core를 설치하기 전에는 세션을 다룰 수 없습니다")
	}
	home, err := paths.Home(*homeFlag)
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("이 mori의 경로를 알지 못했습니다: %w", err)
	}
	if exe, err = filepath.Abs(exe); err != nil {
		return err
	}

	out := os.Stdout
	if *dryRun {
		fmt.Fprintln(out, "시험 실행입니다. 아무것도 바꾸지 않습니다.")
	}
	err = service.Install(service.Options{
		Exe:    exe,
		Home:   home,
		Args:   serveArgs(home, *listen, *publicFlag, hcPath, *hcSession),
		Env:    service.AgentEnv(os.Environ()),
		DryRun: *dryRun,
		Out:    out,
	})
	if err != nil || *dryRun {
		return err
	}
	fmt.Fprintln(out, "\n설치했습니다. 로그인할 때마다 서버가 뜹니다.")
	if cmd := serveHint(*listen); cmd != "" {
		fmt.Fprintln(out, "다른 기기에서 열려면 tailscale serve를 켜세요. tailnet 관리 콘솔에서 MagicDNS와 HTTPS 인증서가 켜져 있어야 합니다:")
		fmt.Fprintln(out, "  "+cmd)
	}
	fmt.Fprintln(out, "다음: mori doctor로 점검하고, mori pair로 기기를 페어링하세요.")
	if runtime.GOOS == "darwin" {
		fmt.Fprintln(out, "서버는 지금 이 셸의 PATH로 hc, git과 프리셋의 프로그램을 찾습니다. PATH를 바꾸면 다시 설치하세요.")
	}
	fmt.Fprintln(out, "mori를 옮기거나 새 버전으로 바꾼 뒤에도 mori service install을 다시 실행하세요.")
	return nil
}

// serveArgs is the serve command the service runs. It names the state
// directory and the address, which a service started at login could not
// otherwise know from this shell.
func serveArgs(home, listen, publicURL, hcPath, hcSession string) []string {
	args := []string{"serve", "--home", home, "--listen", listen}
	if publicURL != "" {
		args = append(args, "--public-url", strings.TrimRight(publicURL, "/"))
	}
	if hcPath != "" {
		args = append(args, "--hc", hcPath)
	}
	if hcSession != "" {
		args = append(args, "--hc-session", hcSession)
	}
	return args
}

// serveHint is the tailscale serve command that would open the server on
// listen to the tailnet, or "" when tailscale serve forwards to it
// already. Mori does not change the Tailscale settings itself.
func serveHint(listen string) string {
	targets := serveTargets(listen)
	if len(targets) == 0 {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if cfg, err := tailscale.ServeStatus(ctx); err == nil {
		for _, t := range targets {
			if tailscale.ProxiesTo(cfg, t) {
				return ""
			}
		}
	}
	return "tailscale serve --bg " + targets[0]
}

func runServiceUninstall(args []string) error {
	fs := newFlagSet("service uninstall", "[옵션]")
	homeFlag := fs.String("home", "", "멈출 서버의 상태 디렉터리 (기본: 설치된 서비스의 것, 없으면 MORI_HOME, 그다음 사용자 설정 디렉터리/Mori)")
	dryRun := fs.Bool("dry-run", false, dryRunUsage)
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if !service.Supported() {
		return service.ErrUnsupported
	}
	out := os.Stdout
	in, err := service.Installed()
	installed := err == nil
	switch {
	case errors.Is(err, service.ErrNotInstalled):
		fmt.Fprintln(out, "서비스가 설치되어 있지 않습니다. 돌고 있는 서버만 멈춥니다.")
	case err != nil:
		fmt.Fprintf(out, "주의: 설치된 서비스를 읽지 못했지만 지웁니다: %v\n", err)
	}
	homeArg := *homeFlag
	if homeArg == "" && installed {
		homeArg = in.Flag("home")
	}
	home, err := paths.Home(homeArg)
	if err != nil {
		return err
	}
	if *dryRun {
		fmt.Fprintln(out, "시험 실행입니다. 아무것도 바꾸지 않습니다.")
	}
	if err := service.Uninstall(service.Options{Home: home, DryRun: *dryRun, Out: out}); err != nil || *dryRun {
		return err
	}
	fmt.Fprintln(out)
	if installed {
		fmt.Fprintln(out, "서비스를 지웠습니다.")
	}
	fmt.Fprintf(out, "상태 디렉터리(%s)는 남겨 두었습니다. 모두 지우려면 그 디렉터리를 지우세요. herdr-core와 그 세션도 그대로 둡니다.\n", home)
	return nil
}
