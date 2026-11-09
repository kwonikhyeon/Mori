package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
)

// Store guards the in-memory state and writes every change to disk before
// it becomes visible.
type Store struct {
	path string
	mu   sync.Mutex
	cur  State
}

// Open loads path, creating its directory (0700) and a default state when
// the file does not exist. A file that does not parse is moved to
// path+".bad" and replaced with a default state; its devices must pair again.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	s := &Store{path: path}
	b, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		s.cur = defaultState()
		return s, writeAtomic(path, s.cur)
	case err != nil:
		return nil, err
	}
	var st State
	if err := json.Unmarshal(b, &st); err != nil {
		bad := path + ".bad"
		if rerr := os.Rename(path, bad); rerr != nil {
			return nil, fmt.Errorf("state %s is corrupt (%v) and could not be moved aside: %w", path, err, rerr)
		}
		slog.Warn("state file corrupt; starting fresh", "path", path, "moved_to", bad, "err", err)
		s.cur = defaultState()
		return s, writeAtomic(path, s.cur)
	}
	needIDs := slices.ContainsFunc(st.Hosts, func(h Host) bool { return h.ID == "" })
	s.cur = normalize(st)
	if needIDs {
		return s, writeAtomic(path, s.cur) // hosts from before IDs keep the ID they get now
	}
	return s, nil
}

// Path is the file the store writes.
func (s *Store) Path() string { return s.path }

// Get returns a deep copy of the current state.
func (s *Store) Get() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return clone(s.cur)
}

// Folders returns a copy of the registered folders, cheaper than Get.
func (s *Store) Folders() []Folder {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Folder{}, s.cur.Folders...)
}

// Hosts returns a copy of the linked hosts, cheaper than Get.
func (s *Store) Hosts() []Host {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Host{}, s.cur.Hosts...)
}

// Update runs fn on a copy of the state, saves the result, and only then
// makes it current. When fn or the save fails nothing changes.
func (s *Store) Update(fn func(*State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := clone(s.cur)
	if err := fn(&next); err != nil {
		return err
	}
	next = normalize(next)
	if err := writeAtomic(s.path, next); err != nil {
		return err
	}
	s.cur = next
	return nil
}

func clone(st State) State {
	b, err := json.Marshal(st)
	if err != nil {
		panic(err) // State holds only strings, numbers and slices of them
	}
	var out State
	if err := json.Unmarshal(b, &out); err != nil {
		panic(err)
	}
	return out
}

// writeAtomic writes st to a temporary file in the same directory, syncs
// it, and renames it over path, so a crash leaves the old or the new file.
func writeAtomic(path string, st State) error {
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".state-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp) // a no-op once the rename has happened
	if runtime.GOOS != "windows" {
		if err := f.Chmod(0o600); err != nil {
			f.Close()
			return err
		}
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	if d, err := os.Open(dir); err == nil { // make the rename durable; unsupported on Windows
		d.Sync()
		d.Close()
	}
	return nil
}
