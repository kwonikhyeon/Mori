package main

import "testing"

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
