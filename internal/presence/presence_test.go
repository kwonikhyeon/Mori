package presence

import "testing"

func TestFocused(t *testing.T) {
	r := New()
	if r.Focused("t1") {
		t.Fatal("focused before anyone looked")
	}
	r.Set("t1", "v1", true)
	r.Set("t1", "v2", false)
	if !r.Focused("t1") || r.Focused("t2") {
		t.Fatal("one of two viewers has t1 in focus")
	}
	r.Set("t1", "v2", true)
	r.Remove("t1", "v1")
	if !r.Focused("t1") {
		t.Fatal("v2 still has t1 in focus")
	}
	r.Set("t1", "v2", false)
	if r.Focused("t1") {
		t.Fatal("nobody has t1 in focus")
	}
	r.Set("t1", "v3", true)
	r.Remove("t1", "v3")
	r.Remove("t1", "v3") // removing twice is fine
	if r.Focused("t1") {
		t.Fatal("v3 left")
	}
}
