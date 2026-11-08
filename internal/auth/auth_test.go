package auth

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/store"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newAuth(t *testing.T) (*Auth, *clock, *store.Store) {
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	c := &clock{time.Unix(1_800_000_000, 0)}
	return New(st, Options{Now: c.now}), c, st
}

func withCookie(tok string) *http.Request {
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: tok})
	return r
}

func TestPairOnceAndAuthenticate(t *testing.T) {
	a, _, st := newAuth(t)
	code := a.NewCode("iPhone")
	if !regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$`).MatchString(code.Code) {
		t.Fatal(code.Code)
	}
	tok, dev, err := a.Pair(strings.ToLower(code.Code), "", "UA")
	if err != nil || dev.Name != "iPhone" || dev.UserAgent != "UA" || len(tok) < 40 {
		t.Fatal(dev, err)
	}
	if _, _, err := a.Pair(code.Code, "x", "UA"); !errors.Is(err, ErrBadCode) {
		t.Fatal("code must be single use")
	}
	if strings.Contains(fmt.Sprint(st.Get()), tok) {
		t.Fatal("token stored in clear")
	}
	if d, got, ok := a.Device(withCookie(tok)); !ok || d.ID != dev.ID || got != tok {
		t.Fatal("cookie auth")
	}
	for _, bad := range []string{"", tok + "x", "nope"} {
		if _, _, ok := a.Device(withCookie(bad)); ok {
			t.Errorf("%q must not authenticate", bad)
		}
	}
	if _, _, ok := a.Device(httptest.NewRequest("GET", "/", nil)); ok {
		t.Error("no cookie")
	}
}

func TestDevicesHideTokenHashes(t *testing.T) {
	a, _, _ := newAuth(t)
	a.Pair(a.NewCode("").Code, "pc", "")
	ds := a.Devices()
	if len(ds) != 1 || ds[0].Name != "pc" || ds[0].TokenHash != "" {
		t.Fatalf("%+v", ds)
	}
}

func TestCodeExpires(t *testing.T) {
	a, c, _ := newAuth(t)
	code := a.NewCode("")
	c.t = c.t.Add(5 * time.Minute)
	ok := a.NewCode("")
	if _, _, err := a.Pair(ok.Code, "", ""); err != nil {
		t.Fatal("five minutes is still valid:", err)
	}
	c.t = c.t.Add(time.Second)
	if _, _, err := a.Pair(code.Code, "", ""); !errors.Is(err, ErrBadCode) {
		t.Fatal(err)
	}
}

func TestRateLimitLocksWindow(t *testing.T) {
	a, c, _ := newAuth(t)
	for range 10 {
		if _, _, err := a.Pair("AAAA-AAAA", "", ""); !errors.Is(err, ErrBadCode) {
			t.Fatal(err)
		}
	}
	good := a.NewCode("")
	if _, _, err := a.Pair(good.Code, "", ""); !errors.Is(err, ErrRateLimited) {
		t.Fatal("locked window must refuse even good codes")
	}
	c.t = c.t.Add(10*time.Minute + time.Second)
	if _, _, err := a.Pair(good.Code, "", ""); !errors.Is(err, ErrBadCode) {
		t.Fatal("the window is over, but that code expired:", err)
	}
	good = a.NewCode("")
	if _, _, err := a.Pair(good.Code, "", ""); err != nil {
		t.Fatal(err)
	}
}

func TestFailuresSpreadOverWindowsDoNotLock(t *testing.T) {
	a, c, _ := newAuth(t)
	for range 9 {
		a.Pair("AAAA-AAAA", "", "")
	}
	c.t = c.t.Add(10 * time.Minute)
	a.Pair("AAAA-AAAA", "", "") // opens a new window
	if _, _, err := a.Pair(a.NewCode("").Code, "", ""); err != nil {
		t.Fatal(err)
	}
}

func TestDeviceName(t *testing.T) {
	a, _, _ := newAuth(t)
	_, d, _ := a.Pair(a.NewCode("코드 이름").Code, "  ", "")
	if d.Name != "코드 이름" {
		t.Fatal(d.Name)
	}
	_, d, _ = a.Pair(a.NewCode("").Code, "", "")
	if d.Name != "기기" {
		t.Fatal(d.Name)
	}
	_, d, _ = a.Pair(a.NewCode("x").Code, "폰\n"+strings.Repeat("가", 70), "")
	if d.Name != "폰"+strings.Repeat("가", 63) {
		t.Fatalf("%q: control characters go, 64 characters stay", d.Name)
	}
}

func TestTouchOncePerMinute(t *testing.T) {
	a, c, st := newAuth(t)
	tok, dev, _ := a.Pair(a.NewCode("").Code, "pc", "old")
	c.t = c.t.Add(30 * time.Second)
	rec := httptest.NewRecorder()
	a.Touch(rec, dev, tok, "new")
	if len(rec.Result().Cookies()) != 0 || st.Get().Devices[0].UserAgent != "old" {
		t.Fatal("within a minute nothing changes")
	}
	c.t = c.t.Add(31 * time.Second)
	rec = httptest.NewRecorder()
	a.Touch(rec, dev, tok, "new")
	got := st.Get().Devices[0]
	if got.LastSeenMs != c.t.UnixMilli() || got.UserAgent != "new" || len(rec.Result().Cookies()) != 1 || rec.Result().Cookies()[0].Value != tok {
		t.Fatalf("%+v", got)
	}
}

func TestRevokeNotifies(t *testing.T) {
	a, _, st := newAuth(t)
	tok, dev, _ := a.Pair(a.NewCode("").Code, "pc", "")
	_, other, _ := a.Pair(a.NewCode("").Code, "phone", "")
	st.Update(func(s *store.State) error {
		s.PushSubs = []store.PushSub{{ID: "p1", DeviceID: dev.ID}, {ID: "p2", DeviceID: other.ID}}
		return nil
	})
	var got string
	a.OnRevoke(func(id string) { got = id })
	if err := a.Revoke(dev.ID); err != nil || got != dev.ID {
		t.Fatal(err, got)
	}
	if _, _, ok := a.Device(withCookie(tok)); ok {
		t.Fatal("revoked token still works")
	}
	if s := st.Get(); len(s.Devices) != 1 || len(s.PushSubs) != 1 || s.PushSubs[0].ID != "p2" {
		t.Fatalf("its push subscriptions go with it: %+v", s.PushSubs)
	}
	if err := a.Revoke(dev.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestSameOrigin(t *testing.T) {
	r := httptest.NewRequest("POST", "http://127.0.0.1:7761/api/x", nil)
	r.Host = "macmini.example.ts.net"
	for origin, want := range map[string]bool{
		"https://macmini.example.ts.net": true,
		"https://MacMini.Example.ts.net": true,
		"https://evil.example":           false,
		"null":                           false,
		"":                               false,
	} {
		r.Header.Set("Origin", origin)
		if SameOrigin(r) != want {
			t.Errorf("%q", origin)
		}
	}
	r.Host = "127.0.0.1:7761"
	r.Header.Set("X-Forwarded-Host", "macmini.example.ts.net")
	r.Header.Set("Origin", "https://macmini.example.ts.net")
	if !SameOrigin(r) {
		t.Error("forwarded host")
	}
	r.Header.Set("Origin", "https://evil.example")
	if SameOrigin(r) {
		t.Error("forwarded host must still match")
	}
}

func TestCookieAttributes(t *testing.T) {
	rec := httptest.NewRecorder()
	SetCookie(rec, "tok")
	c := rec.Result().Cookies()[0]
	if c.Name != CookieName || c.Value != "tok" || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.MaxAge != 400*24*3600 {
		t.Fatalf("%+v", c)
	}
	rec = httptest.NewRecorder()
	ClearCookie(rec)
	if c := rec.Result().Cookies()[0]; c.Name != CookieName || c.MaxAge >= 0 {
		t.Fatalf("%+v", c)
	}
}

func TestNormalizeCode(t *testing.T) {
	for in, want := range map[string]string{"abcd-efgh": "ABCDEFGH", " o1il 2345 ": "01112345", "AB-CD\tEF": "ABCDEF"} {
		if got := NormalizeCode(in); got != want {
			t.Errorf("%q: %q want %q", in, got, want)
		}
	}
}
