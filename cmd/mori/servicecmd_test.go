package main

import (
	"slices"
	"testing"
)

func TestServeArgs(t *testing.T) {
	if got, want := serveArgs("/h", "127.0.0.1:7761", "", "", ""), []string{"serve", "--home", "/h", "--listen", "127.0.0.1:7761"}; !slices.Equal(got, want) {
		t.Errorf("%q want %q", got, want)
	}
	got := serveArgs("/h", "[::1]:8000", "https://macmini.example.ts.net/", "/opt/hc", "work")
	want := []string{"serve", "--home", "/h", "--listen", "[::1]:8000", "--public-url", "https://macmini.example.ts.net", "--hc", "/opt/hc", "--hc-session", "work"}
	if !slices.Equal(got, want) {
		t.Errorf("%q want %q", got, want)
	}
}
