package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/admin"
	"github.com/kwonikhyeon/mori/internal/paths"
	"github.com/kwonikhyeon/mori/internal/service"
	"github.com/kwonikhyeon/mori/internal/store"
	"github.com/kwonikhyeon/mori/internal/version"
)

func TestDoctorMarksAndResult(t *testing.T) {
	var b bytes.Buffer
	d := &doctor{out: &b}
	d.ok("a")
	d.warn("b", "h1\nh2")
	d.fail("c", "")
	if err := d.result(); !errors.Is(err, errReported) {
		t.Fatalf("a failure must end in errReported, got %v", err)
	}
	want := "✓ a\n! b\n    h1\n    h2\n✗ c\n\n실패 1개, 주의 1개\n"
	if b.String() != want {
		t.Fatalf("got\n%s\nwant\n%s", b.String(), want)
	}

	b.Reset()
	d = &doctor{out: &b}
	d.warn("b", "")
	if err := d.result(); err != nil || !strings.HasSuffix(b.String(), "실패 0개, 주의 1개\n") {
		t.Fatalf("a warning alone is no failure: %v\n%s", err, b.String())
	}

	b.Reset()
	d = &doctor{out: &b}
	d.ok("a")
	if err := d.result(); err != nil || !strings.HasSuffix(b.String(), "\n모두 정상입니다\n") {
		t.Fatalf("%v\n%s", err, b.String())
	}
}

func TestDoctorStateDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows keeps no mode bits; the profile's ACL applies")
	}
	check := func(home string) (*doctor, string) {
		var b bytes.Buffer
		d := &doctor{out: &b}
		d.stateDir(home)
		return d, b.String()
	}
	mk := func(t *testing.T, dirMode, fileMode os.FileMode) string {
		home := filepath.Join(t.TempDir(), "Mori")
		if err := os.Mkdir(home, dirMode); err != nil {
			t.Fatal(err)
		}
		os.Chmod(home, dirMode) // past the umask
		if fileMode != 0 {
			if err := os.WriteFile(paths.State(home), []byte("{}"), fileMode); err != nil {
				t.Fatal(err)
			}
			os.Chmod(paths.State(home), fileMode)
		}
		return home
	}

	if d, out := check(filepath.Join(t.TempDir(), "none")); d.warns != 1 || d.fails != 0 || !strings.Contains(out, "서버가 처음 뜰 때 만듭니다") {
		t.Errorf("missing directory: %+v\n%s", d, out)
	}
	if d, out := check(mk(t, 0o700, 0o600)); d.warns+d.fails != 0 || !strings.HasPrefix(out, "✓ ") {
		t.Errorf("0700 and 0600 are right: %+v\n%s", d, out)
	}
	if d, out := check(mk(t, 0o700, 0)); d.warns+d.fails != 0 {
		t.Errorf("state.json comes with the first server: %+v\n%s", d, out)
	}
	if d, out := check(mk(t, 0o755, 0o600)); d.fails != 1 || !strings.Contains(out, "chmod 700 ") {
		t.Errorf("a directory others may enter: %+v\n%s", d, out)
	}
	if d, out := check(mk(t, 0o700, 0o644)); d.fails != 1 || !strings.Contains(out, "chmod 600 ") {
		t.Errorf("a state file others may read: %+v\n%s", d, out)
	}
	file := filepath.Join(t.TempDir(), "file")
	os.WriteFile(file, nil, 0o600)
	if d, out := check(file); d.fails != 1 {
		t.Errorf("a file is no state directory: %+v\n%s", d, out)
	}
}

// statusServer answers status on the admin socket of a new state
// directory, as a running server does, and returns the directory.
type statusServer struct{ st admin.Status }

func (s statusServer) PairCode(string) (string, string, time.Time) { return "", "", time.Time{} }
func (s statusServer) Devices() []admin.DeviceInfo                 { return nil }
func (s statusServer) Revoke(string) error                         { return nil }
func (s statusServer) Status() any                                 { return s.st }
func (s statusServer) Shutdown()                                   {}

// shortHome is a state directory whose socket path fits: macOS allows 104
// bytes for one, and test temp directories there are long.
func shortHome(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "md")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func serveStatus(t *testing.T, st admin.Status) string {
	t.Helper()
	home := shortHome(t)
	ln, err := admin.Listen(paths.Socket(home))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { admin.Serve(ctx, ln, statusServer{st}); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return home
}

func TestDoctorServer(t *testing.T) {
	check := func(home string, in *service.Installation) (*doctor, string, bool) {
		var b bytes.Buffer
		d := &doctor{out: &b}
		_, up := d.server(home, in)
		return d, b.String(), up
	}

	home := shortHome(t)
	if d, out, up := check(home, nil); up || d.fails != 1 || !strings.Contains(out, "mori service install") {
		t.Errorf("no server: %v %+v\n%s", up, d, out)
	}
	in := &service.Installation{Args: []string{"/x/mori", "serve", "--home", home}}
	if d, out, _ := check(home, in); d.fails != 1 || !strings.Contains(out, paths.Log(home)) {
		t.Errorf("an installed service that does not answer points at its log: %+v\n%s", d, out)
	}

	st := admin.Status{Version: version.Version, PID: 42, Listen: "127.0.0.1:7761", Devices: 2,
		Core: admin.CoreStatus{Connected: true, Version: "0.1.19", Name: "default"}}
	if d, out, up := check(serveStatus(t, st), nil); !up || d.fails+d.warns != 0 || !strings.Contains(out, "pid 42") || !strings.Contains(out, "0.1.19") {
		t.Errorf("a server with its core: %v %+v\n%s", up, d, out)
	}

	old := st
	old.Version = "v0.0.1"
	if d, out, _ := check(serveStatus(t, old), nil); d.warns != 1 || d.fails != 0 || !strings.Contains(out, "v0.0.1") {
		t.Errorf("another version: %+v\n%s", d, out)
	}

	lost := st
	lost.Core = admin.CoreStatus{Error: "hc not found: install herdr-core or pass --hc"}
	if d, out, _ := check(serveStatus(t, lost), nil); d.fails != 1 || !strings.Contains(out, "hc not found") {
		t.Errorf("no core: %+v\n%s", d, out)
	}
}

func TestFirstVersion(t *testing.T) {
	for in, want := range map[string]string{
		"hc 0.1.19":                          "0.1.19",
		"git version 2.54.0 (Apple Git-157)": "2.54.0",
		"git version 2.39.5.windows.1":       "2.39.5",
		"tool v1.2\nbuilt with 3.4.5":        "1.2",
		"no version here":                    "",
		"hc 7":                               "",
	} {
		if got := firstVersion(in); got != want {
			t.Errorf("%q: %q want %q", in, got, want)
		}
	}
}

func TestVersionAtLeast(t *testing.T) {
	for _, c := range []struct {
		v, min string
		ok     bool
	}{
		{"0.1.19", "0.1.19", true},
		{"0.1.20", "0.1.19", true},
		{"0.2", "0.1.19", true},
		{"0.1.9", "0.1.19", false},
		{"2.36", "2.36", true},
		{"2.36.0", "2.36", true},
		{"2.35.9", "2.36", false},
		{"10.0", "9.9", true},
		{"", "2.36", false},
	} {
		if got := versionAtLeast(c.v, c.min); got != c.ok {
			t.Errorf("%s >= %s: %v", c.v, c.min, got)
		}
	}
}

func TestServeTargets(t *testing.T) {
	for listen, want := range map[string][]string{
		"127.0.0.1:7761": {"http://127.0.0.1:7761", "http://localhost:7761"},
		"localhost:7761": {"http://127.0.0.1:7761", "http://localhost:7761"},
		"[::1]:7761":     {"http://[::1]:7761", "http://localhost:7761"},
		"127.0.0.2:80":   {"http://127.0.0.2:80"},
		"nonsense":       nil,
	} {
		if got := serveTargets(listen); !slices.Equal(got, want) {
			t.Errorf("%s: %q want %q", listen, got, want)
		}
	}
}

func TestReadPresets(t *testing.T) {
	home := t.TempDir()
	if p, err := readPresets(home); err != nil || !slices.EqualFunc(p, store.DefaultPresets(), samePreset) {
		t.Fatalf("no state file yet: %v %v", p, err)
	}
	os.WriteFile(paths.State(home), []byte(`{"version":1,"presets":[{"id":"x","name":"X","argv":["/opt/x","-y"]}]}`), 0o600)
	if p, err := readPresets(home); err != nil || len(p) != 1 || p[0].Argv[0] != "/opt/x" {
		t.Fatalf("%v %v", p, err)
	}
	os.WriteFile(paths.State(home), []byte(`{"version":1}`), 0o600)
	if p, err := readPresets(home); err != nil || len(p) != len(store.DefaultPresets()) {
		t.Fatalf("a state without presets has the defaults, as the server reads it: %v %v", p, err)
	}
	os.WriteFile(paths.State(home), []byte(`{`), 0o600)
	if _, err := readPresets(home); err == nil {
		t.Fatal("a broken state file must be reported")
	}
}

func samePreset(a, b store.Preset) bool {
	return a.ID == b.ID && a.Name == b.Name && slices.Equal(a.Argv, b.Argv) && a.Task == b.Task
}

func TestDoctorPresets(t *testing.T) {
	look := func(name string) (string, error) {
		if name == "claude" {
			return "/bin/claude", nil
		}
		return "", errors.New("not found")
	}
	var b bytes.Buffer
	d := &doctor{out: &b}
	d.presets(store.DefaultPresets(), look, "")
	out := b.String()
	if d.warns != 1 || d.fails != 0 || !strings.Contains(out, "/bin/claude") || !strings.Contains(out, "codex") || strings.Contains(out, "셸") {
		t.Fatalf("claude is there, codex is not, and the shell is no program: %+v\n%s", d, out)
	}
}

func TestLookIn(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("only the LaunchAgent's PATH is searched by hand")
	}
	a, b := t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(b, "tool"), []byte("#!/bin/sh\n"), 0o755)
	os.WriteFile(filepath.Join(a, "data"), nil, 0o644)
	os.Mkdir(filepath.Join(a, "dir"), 0o755)
	path := strings.Join([]string{a, "", "rel", b}, string(filepath.ListSeparator))
	if p, err := lookIn("tool", path); err != nil || p != filepath.Join(b, "tool") {
		t.Errorf("tool: %q %v", p, err)
	}
	for _, name := range []string{"data", "dir", "none"} {
		if p, err := lookIn(name, path); err == nil {
			t.Errorf("%s is no program: %q", name, p)
		}
	}
	if p, err := lookIn(filepath.Join(b, "tool"), ""); err != nil || p != filepath.Join(b, "tool") {
		t.Errorf("a path is taken as it is: %q %v", p, err)
	}
}
