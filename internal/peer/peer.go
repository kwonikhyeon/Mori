// Package peer links this Mori, the hub, to other hosts' Mori (spec §3
// #158~#171). It pairs with each host as a device, keeps the token in
// state.json, and holds one push subscription there that sends the host's
// notifications back to the hub.
package peer

import (
	"bytes"
	"cmp"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/store"
)

// Error is a failure the hub's API reports as it is. Kind is an error kind
// of spec §7.4.
type Error struct{ Kind, Message string }

func (e *Error) Error() string { return e.Message }

func errorf(kind, format string, args ...any) *Error {
	return &Error{Kind: kind, Message: fmt.Sprintf(format, args...)}
}

var errNotLinked = &Error{Kind: "host_unlinked", Message: "이 호스트와 연결되어 있지 않습니다. 허브에서 다시 연결하세요"}

// errStale stops a write that a newer link or relay setup has overtaken.
var errStale = errors.New("a newer link or relay setup replaced this one")

var enc = base64.RawURLEncoding

const (
	linkTimeout   = 30 * time.Second // one link or relay setup, spec §3 #159
	dialTimeout   = 5 * time.Second  // connect and TLS, spec §3 #163
	logoutTimeout = 5 * time.Second
	pubTTL        = time.Minute // how long the hub's public URL is kept
	maxBody       = 64 << 10    // what the hub reads of a host's answer
	maxName       = 100
)

// relayKinds are what the relay subscription asks for: every kind, since
// the hub's own subscriptions choose (spec §3 #165). They are the kinds
// every Mori knows, so a host of another version takes them.
var relayKinds = []string{"blocked", "waiting", "error", "exited"}

// Options configures a Manager.
type Options struct {
	Store     *store.Store
	PublicURL func() string    // the hub's public URL; nil: none
	Listen    string           // the hub's listen address, never linked to
	HostName  string           // the hub pairs as "<HostName> 허브"
	Version   string           // sent as User-Agent mori-hub/<Version>
	TLS       *tls.Config      // nil: the system's roots
	Logger    *slog.Logger     // nil: slog.Default()
	Now       func() time.Time // nil: time.Now
}

// Manager links the hub to other hosts and finds them for the proxy and
// the relay.
type Manager struct {
	o      Options
	tr     *http.Transport
	client *http.Client

	mu       sync.Mutex
	pub      string
	pubUntil time.Time

	busy sync.Map // origin → chan struct{} of cap 1, held while that host is linked or its relay set up
}

// New makes a Manager over o.Store.
func New(o Options) *Manager {
	if o.Store == nil {
		panic("peer: Options.Store is nil")
	}
	if o.PublicURL == nil {
		o.PublicURL = func() string { return "" }
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	tc := &tls.Config{}
	if o.TLS != nil {
		tc = o.TLS.Clone()
	}
	tc.NextProtos = []string{"http/1.1"} // a WebSocket upgrade needs HTTP/1.1
	protos := new(http.Protocols)
	protos.SetHTTP1(true)
	tr := &http.Transport{
		// No Proxy: a host is reached on the tailnet, never through one.
		DialContext:         (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:     tc,
		TLSHandshakeTimeout: dialTimeout,
		Protocols:           protos,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
		// No ResponseHeaderTimeout: an interrupt waits up to 60 s (spec §3 #163).
	}
	return &Manager{o: o, tr: tr, client: &http.Client{
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// UserAgent is what the hub sends to the hosts as User-Agent.
func (m *Manager) UserAgent() string { return "mori-hub/" + m.o.Version }

// Transport is how the hub reaches the hosts, for the proxy.
func (m *Manager) Transport() http.RoundTripper { return m.tr }

// publicURL is the hub's public URL without a trailing slash, read at most
// once a minute. Never call it inside a Store.Update function.
func (m *Manager) publicURL() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if now := m.o.Now(); now.After(m.pubUntil) {
		m.pub, m.pubUntil = strings.TrimRight(m.o.PublicURL(), "/"), now.Add(pubTTL)
	}
	return m.pub
}

// lockHost holds the host at origin while it is linked or its relay set up:
// two at once leave the hub holding one relay secret while the host sends
// to the other. It gives up when ctx ends.
func (m *Manager) lockHost(ctx context.Context, origin string) (unlock func(), err error) {
	v, _ := m.busy.LoadOrStore(origin, make(chan struct{}, 1))
	ch := v.(chan struct{})
	select {
	case ch <- struct{}{}:
		return func() { <-ch }, nil
	case <-ctx.Done():
		return nil, errorf("conflict", "이 호스트의 연결이나 알림 중계 설정이 아직 끝나지 않았습니다. 잠시 뒤 다시 하세요")
	}
}

// View is what the API shows of a host (spec §3 #168). It never holds the
// token, the keys or the relay secret.
type View struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	Linked     bool   `json:"linked"`
	Version    string `json:"version"`
	Relay      bool   `json:"relay"`
	RelayError string `json:"relay_error,omitempty"`
	LinkedMs   int64  `json:"linked_ms,omitempty"`
}

// Views shows hs. pub is the hub's public URL now: a relay made from
// another one is off (spec §3 #165). With pub "" that is not checked.
func Views(hs []store.Host, pub string) []View {
	out := make([]View, 0, len(hs))
	for _, h := range hs {
		out = append(out, view(h, pub))
	}
	return out
}

func view(h store.Host, pub string) View {
	v := View{ID: h.ID, Name: h.Name, URL: h.URL, Linked: h.Link.Token != ""}
	if !v.Linked {
		return v
	}
	v.Version, v.LinkedMs = h.Link.Version, h.Link.LinkedMs
	switch r := h.Link.Relay; {
	case pub != "" && r.Base != "" && r.Base != pub:
		v.RelayError = "허브 주소가 바뀌었습니다. 알림 중계를 다시 하세요"
	case r.OK:
		v.Relay = true
	default:
		v.RelayError = r.Error
	}
	return v
}

// Views shows the linked hosts.
func (m *Manager) Views() []View { return Views(m.o.Store.Hosts(), m.publicURL()) }

// Lookup finds a host by its ID, or else by a name only one host has.
func (m *Manager) Lookup(idOrName string) (View, error) {
	hs, pub := m.o.Store.Hosts(), m.publicURL()
	if i := slices.IndexFunc(hs, func(h store.Host) bool { return h.ID == idOrName }); i >= 0 {
		return view(hs[i], pub), nil
	}
	var ids []string
	var hit store.Host
	for _, h := range hs {
		if h.Name == idOrName {
			ids, hit = append(ids, h.ID), h
		}
	}
	switch len(ids) {
	case 0:
		return View{}, errorf("not_found", "그런 호스트가 없습니다: %s. mori hosts로 ID를 확인하세요", idOrName)
	case 1:
		return view(hit, pub), nil
	}
	return View{}, errorf("invalid_params", "이름이 같은 호스트가 여럿입니다. ID로 고르세요: %s", strings.Join(ids, ", "))
}

// Target is where the proxy sends one host's requests.
type Target struct {
	ID, Name string
	Base     *url.URL // the host's origin
	Token    string   // "" when the hub is not linked
}

// Target finds the host id.
func (m *Manager) Target(id string) (Target, bool) {
	for _, h := range m.o.Store.Hosts() {
		if h.ID != id {
			continue
		}
		t := Target{ID: h.ID, Name: h.Name, Token: h.Link.Token, Base: &url.URL{}}
		if u, err := url.Parse(h.URL); err == nil && u.Host != "" {
			t.Base = &url.URL{Scheme: u.Scheme, Host: u.Host}
		} else {
			t.Token = "" // a hand-edited URL: not linked
		}
		return t, true
	}
	return Target{}, false
}

// Relay finds the host whose relay subscription has secret, with the key
// and auth secret its notifications are encrypted to. It answers before
// the relay is confirmed: the host's test notification comes back while
// SetupRelay waits.
func (m *Manager) Relay(secret string) (id string, key *ecdh.PrivateKey, authSecret []byte, ok bool) {
	if secret == "" {
		return "", nil, nil, false
	}
	for _, h := range m.o.Store.Hosts() {
		r := h.Link.Relay
		if h.Link.Token == "" || r.Secret == "" || subtle.ConstantTimeCompare([]byte(r.Secret), []byte(secret)) != 1 {
			continue
		}
		b, err := enc.DecodeString(r.Key)
		if err != nil {
			return "", nil, nil, false
		}
		k, err := ecdh.P256().NewPrivateKey(b)
		if err != nil {
			return "", nil, nil, false
		}
		a, err := enc.DecodeString(r.Auth)
		if err != nil || len(a) != 16 {
			return "", nil, nil, false
		}
		return h.ID, k, a, true
	}
	return "", nil, nil, false
}

// ParseTarget reads what a person gives as a host (spec §3 #160): an
// origin, or a pairing link <origin>/pair#code=XXXX-XXXX. origin is
// lower-cased and has no default port.
func ParseTarget(raw string) (origin, code string, err error) {
	bad := errorf("invalid_params", "호스트 주소 %q: https://호스트[:포트] 꼴이거나 페어링 링크여야 합니다", raw)
	u, perr := url.Parse(strings.TrimSpace(raw))
	if perr != nil || u.Scheme != "https" && u.Scheme != "http" || u.Host == "" || u.Hostname() == "" ||
		u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Opaque != "" {
		return "", "", bad
	}
	switch u.Path {
	case "", "/": // a fragment here is the UI's own route (/#/t/…), copied from the address bar
	case "/pair":
		q, qerr := url.ParseQuery(u.Fragment)
		if qerr != nil || q.Get("code") == "" {
			return "", "", bad
		}
		code = q.Get("code")
	default:
		return "", "", bad
	}
	host := strings.ToLower(u.Host)
	if p := u.Port(); u.Scheme == "https" && p == "443" || u.Scheme == "http" && p == "80" {
		host = strings.ToLower(u.Hostname())
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
	}
	return u.Scheme + "://" + host, code, nil
}

// isSelf tells whether origin is this hub: its public URL or its listen
// address.
func (m *Manager) isSelf(origin string) bool {
	if pub, _, err := ParseTarget(m.publicURL()); err == nil && pub == origin {
		return true
	}
	host, port, err := net.SplitHostPort(m.o.Listen)
	if err != nil {
		return false
	}
	hosts := []string{host}
	if ip := net.ParseIP(host); host == "localhost" || ip != nil && ip.IsLoopback() {
		hosts = []string{"127.0.0.1", "localhost", "::1"}
	}
	for _, h := range hosts {
		for _, scheme := range []string{"http://", "https://"} {
			if o, _, err := ParseTarget(scheme + net.JoinHostPort(h, port)); err == nil && o == origin {
				return true
			}
		}
	}
	return false
}

// cleanName puts name on one line. An optional name may be empty.
func cleanName(name string, optional bool) (string, error) {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, name)
	name = strings.Join(strings.Fields(name), " ")
	if name == "" && optional {
		return "", nil
	}
	if n := utf8.RuneCountInString(name); n < 1 || n > maxName {
		return "", errorf("invalid_params", "호스트 이름은 1~%d자여야 합니다", maxName)
	}
	return name, nil
}

// defaultName is the name the host gives itself, or else its address.
func defaultName(host, origin string) string {
	if n, err := cleanName(host, false); err == nil {
		return n
	}
	u, _ := url.Parse(origin)
	return u.Hostname()
}

// do sends one request to the host at origin as the hub.
func (m *Manager) do(ctx context.Context, method, origin, path, token string, body any) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, origin+path, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Origin", origin)
	req.Header.Set("User-Agent", m.UserAgent())
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	}
	res, err := m.client.Do(req)
	if err != nil {
		return nil, unreachable(origin, err)
	}
	return res, nil
}

func unreachable(origin string, err error) *Error {
	if errors.Is(err, context.DeadlineExceeded) {
		return errorf("host_unreachable", "%s에 닿지 못했습니다: 시간 안에 답하지 않았습니다", origin)
	}
	if ue := (*url.Error)(nil); errors.As(err, &ue) {
		err = ue.Err // the URL is said already
	}
	return errorf("host_unreachable", "%s에 닿지 못했습니다: %v", origin, err)
}

// readError reads a Mori error body (spec §7.4).
func readError(res *http.Response) *Error {
	var body struct {
		Error struct{ Kind, Message string } `json:"error"`
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, maxBody))
	_ = json.Unmarshal(b, &body)
	return &Error{Kind: cmp.Or(body.Error.Kind, "host_unreachable"), Message: cmp.Or(body.Error.Message, fmt.Sprintf("응답 %d", res.StatusCode))}
}

type hello struct {
	App     string `json:"app"`
	Version string `json:"version"`
	Host    string `json:"host"`
}

// hello asks origin whether it is a Mori.
func (m *Manager) hello(ctx context.Context, origin string) (hello, error) {
	res, err := m.do(ctx, http.MethodGet, origin, "/api/hello", "", nil)
	if err != nil {
		return hello{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusNotFound {
		return hello{}, errorf("host_unreachable", "%s에 닿지 못했습니다: 응답 %d", origin, res.StatusCode)
	}
	var h hello
	if res.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(res.Body, maxBody)).Decode(&h) == nil && h.App == "mori" {
		return h, nil
	}
	return hello{}, errorf("invalid_params", "Mori가 아닙니다: %s", origin)
}

// pair pairs the hub with the host as a device and returns its token.
func (m *Manager) pair(ctx context.Context, origin, code string) (string, error) {
	res, err := m.do(ctx, http.MethodPost, origin, "/api/pair", "", map[string]string{"code": code, "name": m.o.HostName + " 허브"})
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		e := readError(res)
		if e.Kind == "invalid_params" || e.Kind == "rate_limited" {
			return "", e
		}
		return "", errorf("host_unreachable", "%s에 닿지 못했습니다: %s", origin, e.Message)
	}
	for _, c := range res.Cookies() {
		if c.Name == auth.CookieName && c.Value != "" {
			return c.Value, nil
		}
	}
	return "", errorf("host_unreachable", "%s에 닿지 못했습니다: 페어링 쿠키가 없습니다", origin)
}

// logout gives token up on the host, which also drops the relay
// subscription made with it. The host may be gone; that is only logged.
func (m *Manager) logout(ctx context.Context, origin, token string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), logoutTimeout)
	defer cancel()
	res, err := m.do(ctx, http.MethodPost, origin, "/api/logout", token, nil)
	if err == nil {
		res.Body.Close()
		if res.StatusCode != http.StatusNoContent && res.StatusCode != http.StatusUnauthorized {
			err = fmt.Errorf("status %d", res.StatusCode)
		}
	}
	if err != nil {
		m.o.Logger.Info("logging out of a host", "url", origin, "err", err)
	}
}

// Link pairs the hub with the host at rawURL (spec §6.9). A host linked
// before keeps its ID and name and gets the new token; the old one is
// logged out. created tells a new host. A relay that cannot be made is no
// error: the view says why. It waits for a link or relay setup of the same
// host already under way.
func (m *Manager) Link(ctx context.Context, rawURL, code, name string) (v View, created bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	origin, linkCode, err := ParseTarget(rawURL)
	if err != nil {
		return View{}, false, err
	}
	if code = cmp.Or(strings.TrimSpace(code), linkCode); code == "" {
		return View{}, false, errorf("invalid_params", "페어링 코드가 필요합니다: 그 호스트에서 mori pair를 실행해 받으세요")
	}
	if m.isSelf(origin) {
		return View{}, false, errorf("invalid_params", "이 허브 자신은 연결할 수 없습니다: %s", origin)
	}
	if name, err = cleanName(name, true); err != nil {
		return View{}, false, err
	}
	unlock, err := m.lockHost(ctx, origin)
	if err != nil {
		return View{}, false, err
	}
	defer unlock()
	h, err := m.hello(ctx, origin)
	if err != nil {
		return View{}, false, err
	}
	token, err := m.pair(ctx, origin, code)
	if err != nil {
		return View{}, false, err
	}
	var id, old string
	link := store.HostLink{Token: token, Version: h.Version, LinkedMs: m.o.Now().UnixMilli()}
	err = m.o.Store.Update(func(st *store.State) error {
		id, old, created = "", "", false
		for i := range st.Hosts {
			if o, _, err := ParseTarget(st.Hosts[i].URL); err == nil && o == origin {
				hh := &st.Hosts[i]
				id, old = hh.ID, hh.Link.Token
				hh.Name, hh.URL, hh.Link = cmp.Or(name, hh.Name), origin, link
				return nil
			}
		}
		id, created = store.NewID("h_"), true
		st.Hosts = append(st.Hosts, store.Host{ID: id, Name: cmp.Or(name, defaultName(h.Host, origin)), URL: origin, Link: link})
		return nil
	})
	if err != nil {
		m.logout(ctx, origin, token)
		return View{}, false, err
	}
	if old != "" && old != token {
		m.logout(ctx, origin, old)
	}
	v, err = m.setupRelay(ctx, id)
	return v, created, err
}

// Unlink forgets the host id, then logs the hub out of it. It is forgotten
// even when it cannot be reached (spec §6.9).
func (m *Manager) Unlink(ctx context.Context, id string) (View, error) {
	var gone store.Host
	err := m.o.Store.Update(func(st *store.State) error {
		i := slices.IndexFunc(st.Hosts, func(h store.Host) bool { return h.ID == id })
		if i < 0 {
			return errorf("not_found", "그런 호스트가 없습니다: %s", id)
		}
		gone = st.Hosts[i]
		st.Hosts = slices.Delete(st.Hosts, i, i+1)
		return nil
	})
	if err != nil {
		return View{}, err
	}
	if gone.Link.Token != "" {
		m.logout(ctx, gone.URL, gone.Link.Token)
	}
	return view(gone, ""), nil
}

// Rename names the host id.
func (m *Manager) Rename(id, name string) (View, error) {
	name, err := cleanName(name, false)
	if err != nil {
		return View{}, err
	}
	pub := m.publicURL()
	var v View
	err = m.o.Store.Update(func(st *store.State) error {
		i := slices.IndexFunc(st.Hosts, func(h store.Host) bool { return h.ID == id })
		if i < 0 {
			return errorf("not_found", "그런 호스트가 없습니다: %s", id)
		}
		st.Hosts[i].Name = name
		v = view(st.Hosts[i], pub)
		return nil
	})
	if err != nil {
		return View{}, err
	}
	return v, nil
}

// SetupRelay makes the relay subscription on the host id again with new
// keys (spec §6.11). It is off, with the reason kept, when the hub is not
// on https or the host does not take it. It waits for a link or relay setup
// of the same host already under way, and ends within 30 s all told: the
// transport has no response timeout.
func (m *Manager) SetupRelay(ctx context.Context, id string) (View, error) {
	ctx, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	t, ok := m.Target(id)
	if !ok {
		return View{}, errorf("not_found", "그런 호스트가 없습니다: %s", id)
	}
	origin, _, _ := ParseTarget(t.Base.String()) // "": a hand-edited URL, which is not linked
	unlock, err := m.lockHost(ctx, origin)
	if err != nil {
		return View{}, err
	}
	defer unlock()
	return m.setupRelay(ctx, id)
}

// setupRelay is SetupRelay with the host held. It reads the host again: a
// link it waited for may have changed the token.
func (m *Manager) setupRelay(ctx context.Context, id string) (View, error) {
	t, ok := m.Target(id)
	switch {
	case !ok:
		return View{}, errorf("not_found", "그런 호스트가 없습니다: %s", id)
	case t.Token == "":
		return View{}, errNotLinked
	}
	pub := m.publicURL()
	if !strings.HasPrefix(pub, "https://") {
		return m.setRelay(id, "", store.Relay{Base: pub, Error: "허브 주소가 https가 아니라 알림을 중계할 수 없습니다"})
	}
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return View{}, err
	}
	authSecret, secret := make([]byte, 16), make([]byte, 32)
	rand.Read(authSecret)
	rand.Read(secret)
	r := store.Relay{Secret: enc.EncodeToString(secret), Key: enc.EncodeToString(key.Bytes()), Auth: enc.EncodeToString(authSecret), Base: pub}
	// Saved first: the host's test notification comes back before subscribe returns.
	if _, err := m.setRelay(id, "", r); err != nil {
		return View{}, err
	}
	if err := m.subscribe(ctx, t, r, key.PublicKey().Bytes()); err != nil {
		r.Error = err.Error()
	} else {
		r.OK = true
	}
	return m.setRelay(id, r.Secret, r)
}

// setRelay stores r as the relay of host id. With want set it stores only
// while the stored relay is still the one with that secret, and otherwise
// returns the view as it is.
func (m *Manager) setRelay(id, want string, r store.Relay) (View, error) {
	pub := m.publicURL()
	var v View
	err := m.o.Store.Update(func(st *store.State) error {
		i := slices.IndexFunc(st.Hosts, func(h store.Host) bool { return h.ID == id })
		switch {
		case i < 0:
			return errorf("not_found", "그런 호스트가 없습니다: %s", id)
		case st.Hosts[i].Link.Token == "":
			return errNotLinked
		case want != "" && st.Hosts[i].Link.Relay.Secret != want:
			v = view(st.Hosts[i], pub)
			return errStale
		}
		st.Hosts[i].Link.Relay = r
		v = view(st.Hosts[i], pub)
		return nil
	})
	if err != nil && !errors.Is(err, errStale) {
		return View{}, err
	}
	return v, nil
}

// subscribe makes the relay subscription on the host and has the host send
// its test notification, which has to come back to the hub.
func (m *Manager) subscribe(ctx context.Context, t Target, r store.Relay, pubKey []byte) error {
	origin := t.Base.String()
	sub := map[string]any{
		"subscription": map[string]any{
			"endpoint": r.Base + "/api/relay/" + r.Secret,
			"keys":     map[string]string{"p256dh": enc.EncodeToString(pubKey), "auth": r.Auth},
		},
		"kinds": relayKinds,
	}
	res, err := m.do(ctx, http.MethodPost, origin, "/api/push/subscriptions", t.Token, sub)
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusCreated {
		defer res.Body.Close()
		if res.StatusCode == http.StatusUnauthorized {
			return errors.New("호스트가 허브의 연결을 받지 않습니다. 다시 연결하세요")
		}
		return errors.New("호스트가 알림 중계를 받지 않았습니다: " + readError(res).Message)
	}
	res.Body.Close()
	res, err = m.do(ctx, http.MethodPost, origin, "/api/push/test", t.Token, nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errors.New("호스트가 보낸 시험 알림이 허브에 오지 않았습니다: " + readError(res).Message)
	}
	var sent struct {
		Sent int `json:"sent"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxBody)).Decode(&sent); err != nil || sent.Sent < 1 {
		return errors.New("호스트가 보낸 시험 알림이 허브에 오지 않았습니다")
	}
	return nil
}

// MarkUnlinked forgets the hub's token for host id after the host refused
// it: the host revoked the hub (spec §9). token is the one refused, so a
// newer link is kept.
func (m *Manager) MarkUnlinked(id, token string) {
	err := m.o.Store.Update(func(st *store.State) error {
		i := slices.IndexFunc(st.Hosts, func(h store.Host) bool { return h.ID == id })
		if i < 0 || token == "" || st.Hosts[i].Link.Token != token {
			return errStale
		}
		st.Hosts[i].Link = store.HostLink{}
		return nil
	})
	switch {
	case err == nil:
		m.o.Logger.Info("host revoked the hub", "host", id)
	case !errors.Is(err, errStale):
		m.o.Logger.Error("forgetting a host's token", "host", id, "err", err)
	}
}
