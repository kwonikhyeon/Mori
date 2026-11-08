package paths

import (
	"path/filepath"
	"testing"
)

func TestHomeOrder(t *testing.T) {
	flagDir := filepath.Join(t.TempDir(), "flag")
	envDir := filepath.Join(t.TempDir(), "env")
	t.Setenv("MORI_HOME", envDir)
	if h, _ := Home(flagDir); h != flagDir {
		t.Fatalf("flag: %s", h)
	}
	if h, _ := Home(""); h != envDir {
		t.Fatalf("env: %s", h)
	}
	t.Setenv("MORI_HOME", "")
	h, err := Home("")
	if err != nil || filepath.Base(h) != "Mori" {
		t.Fatalf("default: %s %v", h, err)
	}
}

func TestFilesLiveInHome(t *testing.T) {
	home := filepath.Join("x", "Mori")
	for got, want := range map[string]string{
		State(home):  filepath.Join(home, "state.json"),
		Socket(home): filepath.Join(home, "mori.sock"),
		Log(home):    filepath.Join(home, "mori.log"),
	} {
		if got != want {
			t.Errorf("%s want %s", got, want)
		}
	}
}
