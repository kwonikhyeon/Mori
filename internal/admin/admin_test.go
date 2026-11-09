package admin

import (
	"cmp"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type fakeHandler struct {
	revoked  string
	shutdown chan struct{}
}

func (f *fakeHandler) PairCode(name string) (string, string, time.Time) {
	return "ABCD-EFGH", "https://h/pair#code=ABCD-EFGH", time.Unix(100, 0)
}
func (f *fakeHandler) Devices() []DeviceInfo { return []DeviceInfo{{ID: "d_1", Name: "iPhone"}} }
func (f *fakeHandler) Revoke(id string) error {
	if id != "d_1" {
		return errors.New("no such device")
	}
	f.revoked = id
	return nil
}
func (f *fakeHandler) Status() any { return map[string]bool{"ok": true} }
func (f *fakeHandler) Shutdown()   { close(f.shutdown) }

func (f *fakeHandler) Hosts() []HostInfo {
	return []HostInfo{{ID: "h_1", Name: "desk", URL: "https://desk.example.ts.net", Linked: true, Relay: true}}
}

// LinkHost fails unless the server gave it time to wait on the host.
func (f *fakeHandler) LinkHost(ctx context.Context, rawURL, code, name string) (HostInfo, bool, error) {
	if d, ok := ctx.Deadline(); !ok || time.Until(d) < 30*time.Second {
		return HostInfo{}, false, errors.New("a link needs 30 s")
	}
	if code != "ABCD-EFGH" {
		return HostInfo{}, false, errors.New("코드가 맞지 않습니다")
	}
	return HostInfo{ID: "h_1", Name: cmp.Or(name, "desk"), URL: rawURL, Linked: true}, true, nil
}

func (f *fakeHandler) UnlinkHost(ctx context.Context, idOrName string) (HostInfo, error) {
	if idOrName != "h_1" && idOrName != "desk" {
		return HostInfo{}, errors.New("no such host")
	}
	return HostInfo{ID: "h_1", Name: "desk", URL: "https://desk.example.ts.net"}, nil
}

// socketPath is short: macOS allows 104 bytes for a socket path, and test
// temp directories there are long.
func socketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ma")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "mori.sock")
}

func serve(t *testing.T, path string, h Handler) (stop func()) {
	t.Helper()
	ln, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { Serve(ctx, ln, h); close(done) }()
	stop = func() {
		cancel()
		<-done
	}
	t.Cleanup(func() {
		if ctx.Err() == nil {
			stop()
		}
	})
	return stop
}

func TestAdminRoundTrip(t *testing.T) {
	path := socketPath(t)
	if err := os.WriteFile(path, nil, 0o600); err != nil { // left behind by a crash
		t.Fatal(err)
	}
	h := &fakeHandler{shutdown: make(chan struct{})}
	stop := serve(t, path, h)
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(path)
		if err != nil || fi.Mode().Perm() != 0o600 {
			t.Fatal(fi.Mode(), err)
		}
	}
	c := Client{Path: path}
	r, err := c.Do(Request{Op: "pair", Name: "iPhone"})
	if err != nil || r.Code != "ABCD-EFGH" || r.URL == "" || r.ExpiresMs != 100000 {
		t.Fatal(r, err)
	}
	if r, err := c.Do(Request{Op: "devices"}); err != nil || len(r.Devices) != 1 || r.Devices[0].Name != "iPhone" {
		t.Fatal(r, err)
	}
	if _, err := c.Do(Request{Op: "revoke", ID: "d_1"}); err != nil || h.revoked != "d_1" {
		t.Fatal("revoke", err)
	}
	if _, err := c.Do(Request{Op: "revoke", ID: "d_2"}); err == nil || err.Error() != "no such device" {
		t.Fatal(err)
	}
	if r, err := c.Do(Request{Op: "hosts"}); err != nil || len(r.Hosts) != 1 || r.Hosts[0].ID != "h_1" || !r.Hosts[0].Relay {
		t.Fatal(r, err)
	}
	r, err = c.Do(Request{Op: "link_host", URL: "https://desk.example.ts.net", Code: "ABCD-EFGH", Name: "책상"})
	if err != nil || r.Host == nil || r.Host.Name != "책상" || !r.Created {
		t.Fatal(r, err)
	}
	if _, err := c.Do(Request{Op: "link_host", URL: "https://desk.example.ts.net", Code: "WXYZ-WXYZ"}); err == nil || err.Error() != "코드가 맞지 않습니다" {
		t.Fatal(err)
	}
	if r, err := c.Do(Request{Op: "unlink_host", ID: "desk"}); err != nil || r.Host == nil || r.Host.ID != "h_1" {
		t.Fatal(r, err)
	}
	if r, err := c.Do(Request{Op: "status"}); err != nil || string(r.Status) != `{"ok":true}` {
		t.Fatal(r, err)
	}
	if r, err := c.Do(Request{Op: "nope"}); err == nil || r.Error == "" {
		t.Fatal("unknown op must error")
	}
	if _, err := c.Do(Request{Op: "shutdown"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-h.shutdown:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown not called")
	}

	stop()
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket left behind: %v", err)
	}
	if _, err := c.Do(Request{Op: "status"}); !errors.Is(err, ErrNotRunning) {
		t.Fatal(err)
	}
}

func TestSecondServerRefused(t *testing.T) {
	path := socketPath(t)
	serve(t, path, &fakeHandler{})
	_, err := Listen(path)
	if err == nil || !strings.Contains(err.Error(), "이미 돌고 있습니다") {
		t.Fatal(err)
	}
	if _, err := (Client{Path: path}).Do(Request{Op: "devices"}); err != nil {
		t.Fatal("first server must keep its socket:", err)
	}
}

func TestLongSocketPathExplained(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, strings.Repeat("d", 120), "mori.sock")
	_, err := Listen(path)
	if err == nil || !strings.Contains(err.Error(), "너무 깁니다") || !strings.Contains(err.Error(), "--home") {
		t.Fatal(err)
	}
	if _, err := (Client{Path: path}).Do(Request{Op: "status"}); err == nil || !strings.Contains(err.Error(), "너무 깁니다") {
		t.Fatal(err)
	}
}

type statusHandler struct {
	*fakeHandler
	status any
}

func (h statusHandler) Status() any { return h.status }

func TestClientStatus(t *testing.T) {
	path := socketPath(t)
	want := Status{Version: "v1", PID: 42, Listen: "127.0.0.1:7761", Home: "/h", PublicURL: "https://macmini.example.ts.net",
		Devices: 2, Core: CoreStatus{Connected: true, Version: "0.1.19", Name: "mori"}}
	serve(t, path, statusHandler{&fakeHandler{}, want})
	if got, err := (Client{Path: path}).Status(); err != nil || got != want {
		t.Fatal(got, err)
	}

	odd := socketPath(t)
	serve(t, odd, statusHandler{&fakeHandler{}, "not a status"})
	if _, err := (Client{Path: odd}).Status(); err == nil || !strings.Contains(err.Error(), "서버 상태") {
		t.Fatal(err)
	}

	_, err := (Client{Path: filepath.Join(filepath.Dir(path), "none.sock")}).Status()
	if !errors.Is(err, ErrNotRunning) || !strings.Contains(err.Error(), "mori service install") {
		t.Fatal(err)
	}
}

func TestSlowOpsWaitLonger(t *testing.T) {
	if timeout("link_host", clientTimeout) != slowTimeout || timeout("unlink_host", connTimeout) != slowTimeout {
		t.Fatal("linking waits on another host")
	}
	if timeout("devices", clientTimeout) != clientTimeout {
		t.Fatal("other ops keep their deadline")
	}
}
