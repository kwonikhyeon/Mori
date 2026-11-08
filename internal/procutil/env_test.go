package procutil

import (
	"runtime"
	"slices"
	"testing"
)

func TestWithoutEnv(t *testing.T) {
	env := []string{"A=1", "HC_SESSION=x", "B=2=3", `=C:=C:\x`, "HC_SOCKET", "HC_SOCKETS=keep"}
	got := WithoutEnv(env, "HC_SESSION", "HC_SOCKET", "=C:")
	want := []string{"A=1", "B=2=3", "HC_SOCKETS=keep"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
	if !slices.Equal(env[:2], []string{"A=1", "HC_SESSION=x"}) {
		t.Fatal("input changed")
	}
}

func TestWithoutEnvCase(t *testing.T) {
	got := WithoutEnv([]string{"hc_terminal_id=t1"}, "HC_TERMINAL_ID")
	if runtime.GOOS == "windows" && len(got) != 0 || runtime.GOOS != "windows" && len(got) != 1 {
		t.Fatalf("%s: %q", runtime.GOOS, got)
	}
}
