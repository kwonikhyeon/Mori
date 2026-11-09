// Package admin is the local socket through which the mori commands reach
// a running server. The socket sits in the state directory, so only the
// user who runs the server can open it. It also keeps a second server off
// the same state directory.
package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"runtime"
	"time"
)

// Request is one command, sent as one JSON line.
type Request struct {
	Op   string `json:"op"`             // pair, devices, revoke, hosts, link_host, unlink_host, status, shutdown
	Name string `json:"name,omitempty"` // pair: the device; link_host: the host
	ID   string `json:"id,omitempty"`   // revoke: a device ID; unlink_host: a host ID or name
	URL  string `json:"url,omitempty"`  // link_host: an origin or a pairing link
	Code string `json:"code,omitempty"` // link_host: the pairing code, when URL has none
}

// Response is the one JSON line that answers a Request.
type Response struct {
	Error     string          `json:"error,omitempty"`
	Code      string          `json:"code,omitempty"`
	URL       string          `json:"url,omitempty"`
	ExpiresMs int64           `json:"expires_ms,omitempty"`
	Devices   []DeviceInfo    `json:"devices,omitempty"`
	Hosts     []HostInfo      `json:"hosts,omitempty"`
	Host      *HostInfo       `json:"host,omitempty"`    // link_host, unlink_host
	Created   bool            `json:"created,omitempty"` // link_host: a new host, not a re-link
	Status    json.RawMessage `json:"status,omitempty"`
}

// Status is what a server says about itself.
type Status struct {
	Version   string     `json:"version"`
	PID       int        `json:"pid"`
	Listen    string     `json:"listen"`
	Home      string     `json:"home"`
	PublicURL string     `json:"public_url"`
	Devices   int        `json:"devices"`
	Core      CoreStatus `json:"core"`
}

// CoreStatus is the server's connection to the herdr core.
type CoreStatus struct {
	Connected bool   `json:"connected"`
	Version   string `json:"version,omitempty"`
	Name      string `json:"name,omitempty"`
	Error     string `json:"error,omitempty"`
}

type DeviceInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	UserAgent  string `json:"user_agent,omitempty"`
	CreatedMs  int64  `json:"created_ms"`
	LastSeenMs int64  `json:"last_seen_ms"`
}

// HostInfo is a host this hub links to (spec §3 #168), without its token.
type HostInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	Linked     bool   `json:"linked"`
	Version    string `json:"version,omitempty"`
	Relay      bool   `json:"relay"`
	RelayError string `json:"relay_error,omitempty"`
}

// Handler does what the requests ask. Its methods run on the connection's
// goroutine. LinkHost and UnlinkHost get a context that ends with the
// request's deadline or the server.
type Handler interface {
	PairCode(name string) (code, url string, expires time.Time)
	Devices() []DeviceInfo
	Revoke(id string) error
	Hosts() []HostInfo
	LinkHost(ctx context.Context, rawURL, code, name string) (host HostInfo, created bool, err error)
	UnlinkHost(ctx context.Context, idOrName string) (HostInfo, error)
	Status() any
	Shutdown()
}

// ErrNotRunning means no server answers on the socket.
var ErrNotRunning = errors.New("Mori 서버가 돌고 있지 않습니다")

const (
	connTimeout   = 10 * time.Second
	clientTimeout = 5 * time.Second
	// slowTimeout bounds link_host and unlink_host, which wait on another
	// host: linking takes up to 30 s (spec §3 #169).
	slowTimeout = 40 * time.Second
	maxRequest  = 64 << 10
)

// timeout is how long op may take: base, or slowTimeout for an op that
// waits on another host.
func timeout(op string, base time.Duration) time.Duration {
	if op == "link_host" || op == "unlink_host" {
		return slowTimeout
	}
	return base
}

// Listen opens the socket at path. It fails when another server answers
// there, and removes a socket file that a crashed server left behind.
func Listen(path string) (net.Listener, error) {
	if err := checkPath(path); err != nil {
		return nil, err
	}
	if c, err := net.DialTimeout("unix", path, time.Second); err == nil {
		c.Close()
		return nil, fmt.Errorf("이 상태 디렉터리를 쓰는 Mori 서버가 이미 돌고 있습니다(%s)", path)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("남은 관리 소켓을 지우지 못했습니다: %w", err)
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("관리 소켓을 열지 못했습니다: %w", err)
	}
	if runtime.GOOS != "windows" { // Windows has no mode bits; the profile's ACL applies
		if err := os.Chmod(path, 0o600); err != nil {
			ln.Close()
			return nil, err
		}
	}
	return ln, nil
}

// maxPath is the longest socket path the OS takes: sun_path holds 104
// bytes on macOS and the BSDs and 108 elsewhere, the last one for NUL.
func maxPath() int {
	switch runtime.GOOS {
	case "darwin", "ios", "freebsd", "netbsd", "openbsd", "dragonfly":
		return 103
	}
	return 107
}

// checkPath explains a path the OS would refuse with a bare EINVAL.
func checkPath(path string) error {
	if n := len(path); n > maxPath() {
		return fmt.Errorf("관리 소켓 경로가 너무 깁니다(%d바이트, 최대 %d): %s. --home이나 MORI_HOME으로 더 짧은 상태 디렉터리를 쓰세요", n, maxPath(), path)
	}
	return nil
}

// Serve answers requests on ln until ctx ends or ln closes. Closing ln
// removes the socket file.
func Serve(ctx context.Context, ln net.Listener, h Handler) {
	stop := context.AfterFunc(ctx, func() { ln.Close() })
	defer stop()
	for {
		c, err := ln.Accept()
		if errors.Is(err, net.ErrClosed) {
			return
		}
		if err != nil {
			time.Sleep(100 * time.Millisecond) // out of file descriptors, say
			continue
		}
		go serveConn(ctx, c, h)
	}
}

func serveConn(ctx context.Context, c net.Conn, h Handler) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(connTimeout))
	var req Request
	if err := json.NewDecoder(io.LimitReader(c, maxRequest)).Decode(&req); err != nil {
		json.NewEncoder(c).Encode(Response{Error: "요청을 읽지 못했습니다: " + err.Error()})
		return
	}
	limit := timeout(req.Op, connTimeout)
	c.SetDeadline(time.Now().Add(limit))
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	res, after := handle(ctx, h, req)
	json.NewEncoder(c).Encode(res)
	if after != nil {
		after() // shutdown answers first
	}
}

func handle(ctx context.Context, h Handler, req Request) (Response, func()) {
	switch req.Op {
	case "pair":
		code, url, exp := h.PairCode(req.Name)
		return Response{Code: code, URL: url, ExpiresMs: exp.UnixMilli()}, nil
	case "devices":
		return Response{Devices: h.Devices()}, nil
	case "revoke":
		if err := h.Revoke(req.ID); err != nil {
			return Response{Error: err.Error()}, nil
		}
		return Response{}, nil
	case "hosts":
		return Response{Hosts: h.Hosts()}, nil
	case "link_host":
		host, created, err := h.LinkHost(ctx, req.URL, req.Code, req.Name)
		if err != nil {
			return Response{Error: err.Error()}, nil
		}
		return Response{Host: &host, Created: created}, nil
	case "unlink_host":
		host, err := h.UnlinkHost(ctx, req.ID)
		if err != nil {
			return Response{Error: err.Error()}, nil
		}
		return Response{Host: &host}, nil
	case "status":
		b, err := json.Marshal(h.Status())
		if err != nil {
			return Response{Error: err.Error()}, nil
		}
		return Response{Status: b}, nil
	case "shutdown":
		return Response{}, h.Shutdown
	}
	return Response{Error: fmt.Sprintf("알 수 없는 요청 %q", req.Op)}, nil
}

// Client talks to the server through its socket.
type Client struct{ Path string }

// Do sends req and waits for the answer. An answer that reports an error
// comes back as that error too.
func (c Client) Do(req Request) (Response, error) {
	if err := checkPath(c.Path); err != nil {
		return Response{}, err
	}
	conn, err := net.DialTimeout("unix", c.Path, clientTimeout)
	if err != nil {
		return Response{}, fmt.Errorf("%w. mori serve나 mori service install로 서버를 먼저 띄우세요(%s에 연결하지 못했습니다)", ErrNotRunning, c.Path)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout(req.Op, clientTimeout)))
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return Response{}, fmt.Errorf("관리 소켓에 쓰지 못했습니다: %w", err)
	}
	var res Response
	if err := json.NewDecoder(conn).Decode(&res); err != nil {
		return Response{}, fmt.Errorf("관리 소켓의 응답을 읽지 못했습니다: %w", err)
	}
	if res.Error != "" {
		return res, errors.New(res.Error)
	}
	return res, nil
}

// Status asks the server for its Status.
func (c Client) Status() (Status, error) {
	res, err := c.Do(Request{Op: "status"})
	if err != nil {
		return Status{}, err
	}
	var st Status
	if err := json.Unmarshal(res.Status, &st); err != nil {
		return Status{}, fmt.Errorf("서버 상태를 읽지 못했습니다: %w", err)
	}
	return st, nil
}
