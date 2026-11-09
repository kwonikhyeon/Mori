package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"strings"
	"testing"
)

func TestCheckLoopback(t *testing.T) {
	for addr, ok := range map[string]bool{
		"127.0.0.1:7761": true,
		"[::1]:7761":     true,
		"localhost:7761": true,
		"127.0.0.2:80":   true,
		":7761":          false,
		"0.0.0.0:7761":   false,
		"100.64.0.1:80":  false,
		"[::]:7761":      false,
		"example.com:80": false,
		"127.0.0.1":      false,
	} {
		if err := checkLoopback(addr); (err == nil) != ok {
			t.Errorf("%s: err=%v", addr, err)
		}
	}
}

func TestFirstLabel(t *testing.T) {
	for in, want := range map[string]string{
		"macmini.local":   "macmini",
		"IKHYEON-DESKTOP": "ikhyeon-desktop",
		"a.b.c":           "a",
		".odd":            ".odd",
	} {
		if got := firstLabel(in); got != want {
			t.Errorf("%s: %s want %s", in, got, want)
		}
	}
}

func TestCheckPublicURL(t *testing.T) {
	for v, ok := range map[string]bool{
		"":                                 true,
		"https://macmini.example.ts.net":   true,
		"https://macmini.example.ts.net/":  true,
		"http://127.0.0.1:7761":            true,
		"macmini.example.ts.net":           false,
		"ftp://macmini":                    false,
		"https://":                         false,
		"https://h/mori":                   false,
		"https://h/?x=1":                   false,
		"https://user:pass@h":              false,
		"https://macmini.example.ts.net#x": false,
	} {
		if err := checkPublicURL(v); (err == nil) != ok {
			t.Errorf("%q: err=%v", v, err)
		}
	}
}

func TestPublicURL(t *testing.T) {
	name, fail := "", errors.New("no tailscale")
	dns := func(context.Context) (string, error) {
		if name == "" {
			return "", fail
		}
		return name, nil
	}
	if got := publicURL("https://h.example/", "127.0.0.1:7761", dns)(); got != "https://h.example" {
		t.Fatal(got)
	}
	pub := publicURL("", "127.0.0.1:7761", dns)
	if got := pub(); got != "http://127.0.0.1:7761" {
		t.Fatal(got)
	}
	name = "macmini.example.ts.net" // Tailscale came up after the server
	if got := pub(); got != "https://macmini.example.ts.net" {
		t.Fatal(got)
	}
}

func TestOnlyHere(t *testing.T) {
	for link, want := range map[string]bool{
		"http://127.0.0.1:7761/pair#code=X":          true,
		"http://localhost:7761/pair":                 true,
		"http://[::1]:7761/pair":                     true,
		"https://macmini.example.ts.net/pair#code=X": false,
	} {
		if got := onlyHere(link); got != want {
			t.Errorf("%s: %v", link, got)
		}
	}
}

func TestPrintTableCountsWideCharacters(t *testing.T) {
	var b strings.Builder
	printTable(&b, [][]string{{"ID", "이름", "x"}, {"d_1", "아이폰", "y"}, {"d_22", "iPad", "z"}})
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatal(lines)
	}
	for _, l := range lines {
		if i := strings.LastIndexByte(l, ' '); cellWidth(l[:i+1]) != 4+2+6+2 {
			t.Fatalf("misaligned %q", l)
		}
	}
}

func TestParseFlagsPositional(t *testing.T) {
	for _, tc := range []struct {
		args []string
		ok   bool
	}{
		{[]string{"d_1"}, true},
		{[]string{"--home", "/x", "d_1"}, true},
		{[]string{"d_1", "--home", "/x"}, true},
		{nil, false},
		{[]string{"d_1", "d_2"}, false},
	} {
		fs := newFlagSet("revoke", "<기기 ID>")
		fs.SetOutput(io.Discard)
		fs.String("home", "", "")
		if err := parseFlags(fs, tc.args, "기기 ID"); (err == nil) != tc.ok {
			t.Errorf("%q: %v", tc.args, err)
		}
	}
}

func TestParseFlagsLateAndOptional(t *testing.T) {
	fs := newFlagSet("revoke", "<기기 ID>")
	fs.SetOutput(io.Discard)
	home := fs.String("home", "", "")
	if err := parseFlags(fs, []string{"d_1", "--home", "/x"}, "기기 ID"); err != nil || *home != "/x" || fs.Arg(0) != "d_1" {
		t.Fatal(err, *home, fs.Args())
	}

	link := func(args ...string) (*flag.FlagSet, string, error) {
		fs := newFlagSet("hosts link", "[옵션] <주소 또는 페어링 링크> [코드]")
		fs.SetOutput(io.Discard)
		name := fs.String("name", "", "")
		err := parseFlags(fs, args, "주소 또는 페어링 링크", "[코드]")
		return fs, *name, err
	}
	fs, name, err := link("https://desk.example.ts.net", "ABCD-EFGH", "--name", "desk")
	if err != nil || fs.Arg(0) != "https://desk.example.ts.net" || fs.Arg(1) != "ABCD-EFGH" || name != "desk" {
		t.Fatal(err, fs.Args(), name)
	}
	fs, _, err = link("https://desk.example.ts.net/pair#code=ABCD-EFGH")
	if err != nil || fs.NArg() != 1 || fs.Arg(1) != "" {
		t.Fatal(err, fs.Args())
	}
	for _, args := range [][]string{{"a", "b", "c"}, {"--name", "desk"}} {
		if _, _, err := link(args...); !errors.Is(err, errUsage) {
			t.Errorf("%q: %v", args, err)
		}
	}
	if fs, _, err := link("--", "-d"); err != nil || fs.Arg(0) != "-d" {
		t.Fatal(err, fs.Args())
	}
}

func TestHostNamePrefersTailscale(t *testing.T) {
	ts := func(context.Context) (string, error) { return "macmini.example.ts.net", nil }
	if got := hostName(ts); got != "macmini" {
		t.Fatal(got)
	}
	none := func(context.Context) (string, error) { return "", errors.New("no tailscale") }
	if got := hostName(none); got == "" || got != strings.ToLower(got) {
		t.Fatal(got)
	}
}
