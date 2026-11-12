package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/kwonikhyeon/mori/internal/admin"
	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/folders"
	"github.com/kwonikhyeon/mori/internal/gitx"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/paths"
	"github.com/kwonikhyeon/mori/internal/peer"
	"github.com/kwonikhyeon/mori/internal/presence"
	"github.com/kwonikhyeon/mori/internal/push"
	"github.com/kwonikhyeon/mori/internal/server"
	"github.com/kwonikhyeon/mori/internal/store"
	"github.com/kwonikhyeon/mori/internal/tailscale"
	"github.com/kwonikhyeon/mori/internal/version"
	"github.com/kwonikhyeon/mori/internal/webui"
)

const defaultListen = "127.0.0.1:7761"

// worktreeRefresh is how often the worktrees of every folder are listed
// again, for those made or removed outside Mori (spec §5).
const worktreeRefresh = 30 * time.Second

// pushSubject is the contact push services see in the VAPID token (RFC
// 8292): the project, since each host runs its own Mori.
const pushSubject = "https://github.com/kwonikhyeon/Mori"

func runServe(args []string) error {
	fs := newFlagSet("serve", "[옵션]")
	homeFlag := fs.String("home", "", homeUsage)
	listen := fs.String("listen", defaultListen, "수신 주소. 루프백만 허용합니다")
	publicFlag := fs.String("public-url", "", "기기가 이 서버에 닿는 주소, 페어링 링크에 씁니다 (기본: Tailscale 이름으로 https://<이름>)")
	logPath := fs.String("log", "", "로그 파일 (기본: 표준 오류)")
	hcPath := fs.String("hc", "", "hc 실행 파일 (기본: PATH, 다음 ~/.local/bin/hc)")
	hcSession := fs.String("hc-session", "", "herdr-core 세션 (기본: HC_SESSION, 없으면 hc의 기본 세션)")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if *hcPath != "" { // without the flag hc is looked up on every connect, since an update may move it
		p, err := hc.Locate(*hcPath)
		if err != nil {
			return fmt.Errorf("--hc %q: %w", *hcPath, err)
		}
		*hcPath = p
	}
	if err := checkLoopback(*listen); err != nil {
		return err
	}
	if err := checkPublicURL(*publicFlag); err != nil {
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

	// The admin socket comes first: while it is open, no second server can
	// start on this state directory.
	adminLn, err := admin.Listen(paths.Socket(home))
	if err != nil {
		return err
	}
	defer adminLn.Close()
	st, err := store.Open(paths.State(home))
	if err != nil {
		return fmt.Errorf("상태 파일을 열지 못했습니다: %w", err)
	}
	au := auth.New(st, auth.Options{})
	vapid, err := push.EnsureVAPID(st)
	if err != nil {
		return fmt.Errorf("알림 키를 만들지 못했습니다: %w", err)
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return fmt.Errorf("%s에서 수신하지 못했습니다: %w", *listen, err)
	}
	addr := ln.Addr().String()
	pub := publicURL(*publicFlag, addr, tailscale.DNSName)
	host := hostName(tailscale.DNSName)
	// links pairs this hub with other hosts; the API and the admin socket
	// share it (spec §6.9).
	links := peer.New(peer.Options{Store: st, PublicURL: pub, Listen: addr, HostName: host, Version: version.Version, Logger: logger})
	pres := presence.New()
	notifier := push.New(push.Options{Store: st, Sender: push.NewWebPush(vapid, pushSubject), Focused: pres.Focused, Host: host, Logger: logger})
	// hc connect may not start the core on Windows (spec §15), so there the
	// manager runs hc server start once when the first connect fails.
	cm := core.New(core.Options{HC: *hcPath, Session: *hcSession, StartServer: runtime.GOOS == "windows", Logger: logger,
		OnChange: notifier.OnChange})
	git := gitx.Runner{}
	fr := folders.New(st, git)
	srv := server.New(server.Deps{
		Version:        version.Version,
		HostName:       host,
		Auth:           au,
		Store:          st,
		Core:           cm,
		Folders:        fr,
		Git:            git,
		PublicURL:      pub,
		Names:          serverNames(pub, *publicFlag != "", tailscale.DNSName),
		UI:             webui.Handler(),
		Logger:         logger,
		Presence:       pres,
		Push:           notifier,
		Links:          links,
		ClaudeSettings: claudeSettings(home),
	})
	hs := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, shutdown := context.WithCancel(ctx)
	defer shutdown()
	served := make(chan error, 1)
	go func() { served <- hs.Serve(ln) }()
	// The manager has a context of its own: it stops after the sockets have
	// closed, or attached browsers would hear that the core is lost.
	coreCtx, stopCore := context.WithCancel(context.Background())
	defer stopCore()
	coreDone := make(chan struct{})
	go func() { cm.Run(coreCtx); close(coreDone) }()
	go fr.Run(ctx, worktreeRefresh, logger)
	go admin.Serve(ctx, adminLn, adminHandler{auth: au, links: links, logger: logger, publicURL: pub, shutdown: shutdown, status: func() any {
		cs := cm.Status()
		return admin.Status{
			Version: version.Version, PID: os.Getpid(), Listen: addr, Home: home,
			PublicURL: pub(), Devices: len(au.Devices()),
			Core: admin.CoreStatus{Connected: cs.Connected, Version: cs.Version, Name: cs.Name, Error: cs.Error},
		}
	}})
	logger.Info("listening", "addr", addr, "public_url", pub(), "home", home, "version", version.Version)

	var serveErr error
	select {
	case serveErr = <-served:
	case <-ctx.Done():
		logger.Info("shutting down")
	}
	shutdown()
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// http.Server.Shutdown does not wait for WebSockets, so they go first.
	wctx, wcancel := context.WithTimeout(sctx, 2*time.Second)
	srv.CloseSockets(wctx)
	wcancel()
	if serveErr == nil {
		if err := hs.Shutdown(sctx); !errors.Is(err, context.DeadlineExceeded) {
			serveErr = err
		}
	}
	stopCore()
	select {
	case <-coreDone: // hc connect has ended; the core and its sessions live on
		// No change comes any more, so the notifications under way can be
		// waited for, as long as the time allows.
		sent := make(chan struct{})
		go func() { notifier.Wait(); close(sent) }()
		select {
		case <-sent:
		case <-sctx.Done():
		}
	case <-sctx.Done():
	}
	return serveErr
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

// checkPublicURL accepts an http or https origin. Pairing links go under
// it, and the UI expects to live at its root.
func checkPublicURL(v string) error {
	if v == "" {
		return nil
	}
	u, err := url.Parse(v)
	if err != nil || u.Scheme != "https" && u.Scheme != "http" || u.Host == "" ||
		strings.Trim(u.Path, "/") != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return fmt.Errorf("--public-url %q: https://호스트[:포트] 꼴이어야 합니다", v)
	}
	return nil
}

// publicURL is where devices reach this server, for pairing links: the
// flag, else this machine's Tailscale name, looked up each time because
// Tailscale may come up later, else the listen address, which only this
// machine can open.
func publicURL(flagValue, listen string, dnsName func(context.Context) (string, error)) func() string {
	if flagValue != "" {
		v := strings.TrimRight(flagValue, "/")
		return func() string { return v }
	}
	return func() string {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if name, err := dnsName(ctx); err == nil {
			return "https://" + name
		}
		return "http://" + listen
	}
}

// serverNames are the names a device may reach this server by: its public
// URL's, and its Tailscale name too when --public-url named another, since
// tailscale serve may still forward to it (spec §3 #193).
func serverNames(pub func() string, flagged bool, dnsName func(context.Context) (string, error)) func() []string {
	return func() []string {
		names := []string{pub()}
		if flagged {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if name, err := dnsName(ctx); err == nil {
				names = append(names, name)
			}
		}
		return names
	}
}

// adminHandler answers the mori commands through the admin socket.
type adminHandler struct {
	auth      *auth.Auth
	links     *peer.Manager
	logger    *slog.Logger
	publicURL func() string
	status    func() any
	shutdown  func()
}

func (h adminHandler) PairCode(name string) (string, string, time.Time) {
	c := h.auth.NewCode(name)
	return c.Code, server.PairLink(h.publicURL(), c.Code), c.Expires
}

func (h adminHandler) Devices() []admin.DeviceInfo {
	var out []admin.DeviceInfo
	for _, d := range h.auth.Devices() {
		out = append(out, admin.DeviceInfo{ID: d.ID, Name: d.Name, UserAgent: d.UserAgent, CreatedMs: d.CreatedMs, LastSeenMs: d.LastSeenMs})
	}
	return out
}

func (h adminHandler) Revoke(id string) error {
	err := h.auth.Revoke(id)
	if errors.Is(err, auth.ErrNotFound) {
		return fmt.Errorf("%q: 그런 기기가 없습니다. mori devices로 ID를 확인하세요", id)
	}
	return err
}

func (h adminHandler) Hosts() []admin.HostInfo {
	var out []admin.HostInfo
	for _, v := range h.links.Views() {
		out = append(out, hostInfo(v))
	}
	return out
}

func (h adminHandler) LinkHost(ctx context.Context, rawURL, code, name string) (admin.HostInfo, bool, error) {
	v, created, err := h.links.Link(ctx, rawURL, code, name)
	if err != nil {
		return admin.HostInfo{}, false, err
	}
	h.logger.Info("host linked", "host", v.ID, "url", v.URL, "relay", v.Relay)
	return hostInfo(v), created, nil
}

func (h adminHandler) UnlinkHost(ctx context.Context, idOrName string) (admin.HostInfo, error) {
	v, err := h.links.Lookup(idOrName)
	if err != nil {
		return admin.HostInfo{}, err
	}
	if v, err = h.links.Unlink(ctx, v.ID); err != nil {
		return admin.HostInfo{}, err
	}
	h.logger.Info("host unlinked", "host", v.ID, "url", v.URL)
	return hostInfo(v), nil
}

// hostInfo is what the admin socket says of v.
func hostInfo(v peer.View) admin.HostInfo {
	return admin.HostInfo{ID: v.ID, Name: v.Name, URL: v.URL, Linked: v.Linked, Version: v.Version, Relay: v.Relay, RelayError: v.RelayError}
}

func (h adminHandler) Status() any { return h.status() }
func (h adminHandler) Shutdown()   { h.shutdown() }

// openLogger logs to stderr, or appends to path when one is given. A panic
// or fatal error is then written there as well: moriw.exe, which the
// Windows service runs, has no stderr to write it to.
func openLogger(path string) (*slog.Logger, func(), error) {
	var w io.Writer = os.Stderr
	closeFn := func() {}
	if path != "" {
		if fi, err := os.Stat(path); err == nil && fi.Size() > 10<<20 {
			os.Rename(path, path+".1") // one old file is kept; the log must not grow for good
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return nil, nil, fmt.Errorf("로그 파일을 열지 못했습니다: %w", err)
		}
		if err := debug.SetCrashOutput(f, debug.CrashOptions{}); err != nil { // it keeps a duplicate of f
			f.Close()
			return nil, nil, fmt.Errorf("로그 파일에 크래시 출력을 연결하지 못했습니다: %w", err)
		}
		w, closeFn = f, func() { f.Close() }
	}
	return slog.New(slog.NewTextHandler(w, nil)), closeFn, nil
}

// hostName is how this host introduces itself: its Tailscale machine name,
// which the user chose for the tailnet, else the first label of the OS host
// name, lowercased as Tailscale does. On macOS the OS name comes from the
// computer name and often differs.
func hostName(dnsName func(context.Context) (string, error)) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if name, err := dnsName(ctx); err == nil {
		return firstLabel(name)
	}
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

// claudeSettings writes the settings file Mori gives Claude Code in the
// terminals this server starts (spec §3 #230, #241): a SessionStart hook
// that runs this program's claude-hook in exec form, with no shell (sh, Git
// Bash or PowerShell) to read its path. It returns the file's path, or ""
// when it cannot be written, which starts Claude Code with no hook.
func claudeSettings(home string) string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	type cmd struct {
		Type    string   `json:"type"`
		Command string   `json:"command"`
		Args    []string `json:"args"`
	}
	type matcher struct {
		Hooks []cmd `json:"hooks"`
	}
	b, _ := json.Marshal(map[string]map[string][]matcher{"hooks": {"SessionStart": {{Hooks: []cmd{{"command", exe, []string{"claude-hook"}}}}}}})
	path := filepath.Join(home, "claude-settings.json")
	if os.WriteFile(path, b, 0o644) != nil {
		return ""
	}
	return path
}
