// Package presence knows which terminals a viewer has in focus, so the
// notifier can keep quiet about what the user is looking at (spec §6.5).
package presence

import "sync"

// Registry maps a terminal address to the viewers that have it in focus.
// It is safe for concurrent use.
type Registry struct {
	mu sync.Mutex
	m  map[string]map[string]struct{}
}

func New() *Registry { return &Registry{m: map[string]map[string]struct{}{}} }

// Set records whether viewer has addr in focus.
func (r *Registry) Set(addr, viewer string, focused bool) {
	if !focused {
		r.Remove(addr, viewer)
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.m[addr] == nil {
		r.m[addr] = map[string]struct{}{}
	}
	r.m[addr][viewer] = struct{}{}
}

// Remove forgets viewer on addr, as when its socket ends.
func (r *Registry) Remove(addr, viewer string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.m[addr], viewer)
	if len(r.m[addr]) == 0 {
		delete(r.m, addr)
	}
}

// Focused reports whether any viewer has addr in focus.
func (r *Registry) Focused(addr string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.m[addr]) > 0
}
