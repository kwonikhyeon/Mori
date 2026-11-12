// Package auth pairs devices with one-time codes and recognizes them by the
// token in their cookie. Only token hashes are stored.
package auth

import (
	"cmp"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/kwonikhyeon/mori/internal/store"
)

// CookieName is the cookie that carries a device's token.
const CookieName = "mori_device"

var (
	ErrBadCode     = errors.New("auth: invalid or expired pairing code")
	ErrRateLimited = errors.New("auth: too many failed pairing attempts")
	ErrNotFound    = errors.New("auth: device not found")
)

const (
	failWindow  = 10 * time.Minute
	maxFails    = 10
	touchEvery  = time.Minute
	cookieAge   = 400 * 24 * time.Hour
	maxName     = 64
	maxAgent    = 256
	defaultName = "기기"
)

type Options struct {
	Now func() time.Time // for tests; time.Now when nil
}

// Auth holds the pairing codes, which live only in memory, and the
// failed-attempt window.
type Auth struct {
	st  *store.Store
	now func() time.Time

	mu       sync.Mutex
	codes    map[string]Code // by NormalizeCode form
	winStart time.Time       // the window opened by its first failure
	fails    int
	onRevoke []func(deviceID string)
}

func New(st *store.Store, o Options) *Auth {
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Auth{st: st, now: o.Now, codes: map[string]Code{}}
}

// NewCode makes a code that pairs one device within five minutes.
func (a *Auth) NewCode(name string) Code {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	a.pruneLocked(now)
	key := randomCode()
	for a.codes[key].Code != "" {
		key = randomCode()
	}
	c := Code{Code: formatCode(key), Name: cleanName(name), Expires: now.Add(codeTTL)}
	a.codes[key] = c
	return c
}

func (a *Auth) pruneLocked(now time.Time) {
	for k, c := range a.codes {
		if now.After(c.Expires) {
			delete(a.codes, k)
		}
	}
}

// Pair uses code to add a device and returns its new token. After ten
// failures in a window, every attempt fails until the window ends, without
// looking at the code.
func (a *Auth) Pair(code, name, userAgent string) (string, store.Device, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	if a.fails >= maxFails && now.Sub(a.winStart) < failWindow {
		return "", store.Device{}, ErrRateLimited
	}
	key := NormalizeCode(code)
	c, ok := a.codes[key]
	if !ok || now.After(c.Expires) {
		delete(a.codes, key)
		if now.Sub(a.winStart) >= failWindow {
			a.winStart, a.fails = now, 0
		}
		a.fails++
		return "", store.Device{}, ErrBadCode
	}
	tok := newToken()
	dev := store.Device{
		ID:         store.NewID("d_"),
		Name:       cmp.Or(cleanName(name), c.Name, defaultName),
		CreatedMs:  now.UnixMilli(),
		LastSeenMs: now.UnixMilli(),
		UserAgent:  truncate(userAgent, maxAgent),
		TokenHash:  hashToken(tok),
	}
	if err := a.st.Update(func(st *store.State) error {
		st.Devices = append(st.Devices, dev)
		return nil
	}); err != nil {
		return "", store.Device{}, err // the code stays usable
	}
	delete(a.codes, key)
	return tok, dev, nil
}

// Device finds the device whose token is in r's cookie.
func (a *Auth) Device(r *http.Request) (store.Device, string, bool) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return store.Device{}, "", false
	}
	h := []byte(hashToken(c.Value))
	for _, d := range a.st.Devices() {
		if subtle.ConstantTimeCompare([]byte(d.TokenHash), h) == 1 {
			return d, c.Value, true
		}
	}
	return store.Device{}, "", false
}

// Touch records that dev is in use and renews its cookie, at most once a
// minute per device.
func (a *Auth) Touch(w http.ResponseWriter, dev store.Device, token, userAgent string) {
	now := a.now()
	if now.Sub(time.UnixMilli(dev.LastSeenMs)) < touchEvery {
		return
	}
	ua := truncate(userAgent, maxAgent)
	err := a.st.Update(func(st *store.State) error {
		i := slices.IndexFunc(st.Devices, func(d store.Device) bool { return d.ID == dev.ID })
		if i < 0 {
			return ErrNotFound // revoked meanwhile
		}
		st.Devices[i].LastSeenMs = now.UnixMilli()
		if ua != "" {
			st.Devices[i].UserAgent = ua
		}
		return nil
	})
	if err == nil {
		SetCookie(w, token)
	}
}

// Devices lists the paired devices, without their token hashes.
func (a *Auth) Devices() []store.Device {
	ds := a.st.Devices()
	for i := range ds {
		ds[i].TokenHash = ""
	}
	return ds
}

// Revoke removes a device and its push subscriptions, then tells every
// OnRevoke listener, so open connections can close.
func (a *Auth) Revoke(id string) error {
	err := a.st.Update(func(st *store.State) error {
		i := slices.IndexFunc(st.Devices, func(d store.Device) bool { return d.ID == id })
		if i < 0 {
			return ErrNotFound
		}
		st.Devices = slices.Delete(st.Devices, i, i+1)
		st.PushSubs = slices.DeleteFunc(st.PushSubs, func(p store.PushSub) bool { return p.DeviceID == id })
		return nil
	})
	if err != nil {
		return err
	}
	a.mu.Lock()
	fns := slices.Clone(a.onRevoke)
	a.mu.Unlock()
	for _, fn := range fns {
		fn(id)
	}
	return nil
}

// OnRevoke adds a listener for revoked devices. It runs on the revoking
// goroutine and must not block.
func (a *Auth) OnRevoke(fn func(deviceID string)) {
	a.mu.Lock()
	a.onRevoke = append(a.onRevoke, fn)
	a.mu.Unlock()
}

// SetCookie gives the browser its device token. JavaScript cannot read it.
func SetCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: token, Path: "/", MaxAge: int(cookieAge / time.Second),
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	})
}

func ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	})
}

// SameOrigin reports whether the request's Origin names this server: the
// Host header, or the X-Forwarded-Host a proxy put in front of it.
func SameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	if fh := r.Header.Get("X-Forwarded-Host"); fh != "" {
		first, _, _ := strings.Cut(fh, ",") // the client-facing proxy comes first
		return strings.EqualFold(u.Host, strings.TrimSpace(first))
	}
	return false
}

// newToken returns 256 random bits.
func newToken() string {
	var b [32]byte
	rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func hashToken(tok string) string {
	h := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(h[:])
}

// cleanName drops control characters and surrounding space, and keeps at
// most 64 characters.
func cleanName(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	return truncate(strings.TrimSpace(s), maxName)
}

// truncate keeps the first n characters of s.
func truncate(s string, n int) string {
	i := 0
	for j := range s {
		if i == n {
			return s[:j]
		}
		i++
	}
	return s
}
