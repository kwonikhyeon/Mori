package store

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestOpenCreatesDefaultsWith0600(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "state.json")
	s, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	st := s.Get()
	if st.Version != SchemaVersion || len(st.Presets) != 3 || st.Presets[0].ID != "claude" || !st.Presets[0].Task || st.Presets[2].Task {
		t.Fatalf("%+v", st)
	}
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("file perm %v", fi.Mode().Perm())
		}
		di, _ := os.Stat(filepath.Dir(p))
		if di.Mode().Perm() != 0o700 {
			t.Fatalf("dir perm %v", di.Mode().Perm())
		}
	}
}

func TestEmptyListsAreArraysNotNull(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state.json")
	if _, err := Open(p); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	for _, key := range []string{`"folders": []`, `"hosts": []`, `"devices": []`, `"push_subscriptions": []`, `"argv": []`} {
		if !strings.Contains(string(b), key) {
			t.Errorf("missing %s in\n%s", key, b)
		}
	}
}

func TestUpdatePersistsAndGetIsCopy(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state.json")
	s, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Update(func(st *State) error {
		st.Folders = append(st.Folders, Folder{ID: "f_1", Name: "a", Path: "/a"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	got := s.Get()
	got.Folders[0].Name = "changed"
	got.Presets[0].Argv[0] = "changed"
	if cur := s.Get(); cur.Folders[0].Name != "a" || cur.Presets[0].Argv[0] != "claude" {
		t.Fatal("Get must return a deep copy")
	}
	s2, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if f := s2.Get().Folders; len(f) != 1 || f[0].Path != "/a" {
		t.Fatalf("not persisted: %+v", f)
	}
}

func TestFoldersIsACopy(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if f := s.Folders(); f == nil || len(f) != 0 {
		t.Fatalf("a fresh state has no folders, as []: %#v", f)
	}
	if err := s.Update(func(st *State) error {
		st.Folders = []Folder{{ID: "f_1", Name: "a", Path: "/a"}, {ID: "f_2", Name: "b", Path: "/b"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	got := s.Folders()
	got[0].Name = "changed"
	if cur := s.Folders(); len(cur) != 2 || cur[0].Name != "a" || cur[1].ID != "f_2" {
		t.Fatalf("Folders must return a copy: %+v", cur)
	}
}

func TestUpdateErrorChangesNothing(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state.json")
	s, _ := Open(p)
	before, _ := os.ReadFile(p)
	err := s.Update(func(st *State) error {
		st.Hosts = []Host{{Name: "x"}}
		return errors.New("no")
	})
	if err == nil || len(s.Get().Hosts) != 0 {
		t.Fatal("rollback failed")
	}
	if after, _ := os.ReadFile(p); string(after) != string(before) {
		t.Fatal("file changed on a failed update")
	}
}

func TestCorruptFileMovedAside(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state.json")
	os.WriteFile(p, []byte("{not json"), 0o600)
	s, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Get().Presets) != 3 {
		t.Fatal("fresh state expected")
	}
	if b, _ := os.ReadFile(p + ".bad"); string(b) != "{not json" {
		t.Fatal("bad copy missing")
	}
	if _, err := Open(p); err != nil {
		t.Fatalf("fresh file must load: %v", err)
	}
}

func TestOldFileIsNormalized(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state.json")
	os.WriteFile(p, []byte(`{"folders":[{"id":"f_1","name":"a","path":"/a"}]}`), 0o600)
	s, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	st := s.Get()
	if st.Version != SchemaVersion || len(st.Presets) != 3 || st.Hosts == nil || st.Devices == nil || len(st.Folders) != 1 {
		t.Fatalf("%+v", st)
	}
}

func TestNoTempFilesLeft(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(filepath.Join(dir, "state.json"))
	for i := 0; i < 3; i++ {
		s.Update(func(st *State) error { st.Notify.Children = !st.Notify.Children; return nil })
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("leftovers: %v", entries)
	}
}

func TestConcurrentUpdates(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "state.json"))
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.Update(func(st *State) error { st.Hosts = append(st.Hosts, Host{}); return nil })
			s.Get()
		}()
	}
	wg.Wait()
	if n := len(s.Get().Hosts); n != 20 {
		t.Fatal(n)
	}
}

func TestNewID(t *testing.T) {
	a, b := NewID("f_"), NewID("f_")
	if len(a) != 10 || !strings.HasPrefix(a, "f_") || a == b {
		t.Fatalf("%s %s", a, b)
	}
}
