package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/kwonikhyeon/mori/internal/paths"
	"github.com/kwonikhyeon/mori/internal/server"
	"github.com/kwonikhyeon/mori/internal/version"
	"github.com/kwonikhyeon/mori/internal/webui"
)

const defaultListen = "127.0.0.1:7761"

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	homeFlag := fs.String("home", "", "상태 디렉터리 (기본: MORI_HOME, 없으면 사용자 설정 디렉터리/Mori)")
	listen := fs.String("listen", defaultListen, "수신 주소. 루프백만 허용합니다")
	logPath := fs.String("log", "", "로그 파일 (기본: 표준 오류)")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if err := checkLoopback(*listen); err != nil {
		return err
	}
	home, err := paths.Home(*homeFlag)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("상태 디렉터리를 만들지 못했습니다: %w", err)
	}
	logger, closeLog, err := openLogger(*logPath)
	if err != nil {
		return err
	}
	defer closeLog()
	slog.SetDefault(logger)

	srv := server.New(server.Deps{
		Version:  version.Version,
		HostName: hostName(),
		UI:       webui.Handler(),
		Logger:   logger,
	})
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return fmt.Errorf("%s에서 수신하지 못했습니다: %w", *listen, err)
	}
	hs := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	served := make(chan error, 1)
	go func() { served <- hs.Serve(ln) }()
	logger.Info("listening", "addr", ln.Addr().String(), "home", home, "version", version.Version)

	select {
	case err := <-served:
		return err
	case <-ctx.Done():
	}
	logger.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := hs.Shutdown(sctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return nil
}

// checkLoopback refuses addresses other machines could reach. Remote access
// goes through tailscale serve, which proxies to the loopback address.
func checkLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("--listen %q: %w", addr, err)
	}
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return nil
	}
	return fmt.Errorf("--listen %q: 루프백 주소(127.0.0.1, ::1, localhost)만 허용합니다. 외부 접속은 tailscale serve로 엽니다", addr)
}

// openLogger logs to stderr, or appends to path when one is given.
func openLogger(path string) (*slog.Logger, func(), error) {
	var w io.Writer = os.Stderr
	closeFn := func() {}
	if path != "" {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return nil, nil, fmt.Errorf("로그 파일을 열지 못했습니다: %w", err)
		}
		w, closeFn = f, func() { f.Close() }
	}
	return slog.New(slog.NewTextHandler(w, nil)), closeFn, nil
}

// hostName is how this host introduces itself: the first label of the OS
// host name, lowercased to match Tailscale machine names.
func hostName() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "mori"
	}
	return firstLabel(h)
}

func firstLabel(h string) string {
	if i := strings.IndexByte(h, '.'); i > 0 {
		h = h[:i]
	}
	return strings.ToLower(h)
}
