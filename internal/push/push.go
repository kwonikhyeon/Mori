package push

import (
	"cmp"
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/store"
)

// Payload is what the service worker receives and shows (spec §6.5). It
// holds as little as it can, since a push service may keep it for a day.
type Payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Tag   string `json:"tag"`            // a newer notification with the same tag replaces the older one
	URL   string `json:"url"`            // what a tap opens, under the host's origin
	Kind  string `json:"kind,omitempty"` // what it is about; a hub that relays it reads this (spec §3 #167)
}

// Sender delivers one message to one subscription. It returns the push
// service's HTTP status, 0 when the service was not reached, and an error
// unless the service took the message.
type Sender interface {
	Send(ctx context.Context, sub store.PushSub, payload []byte) (int, error)
}

// Options configures a Notifier.
type Options struct {
	Store   *store.Store
	Sender  Sender
	Focused func(addr string) bool // whether a viewer has the terminal in focus; nil: never
	Host    string                 // this host's name; every title starts with it
	Now     func() time.Time       // nil: time.Now
	Window  time.Duration          // a terminal gets one notification of a kind in it; 0: 10 s
	Logger  *slog.Logger           // nil: slog.Default()
}

const (
	defaultWindow = 10 * time.Second
	sendTimeout   = 30 * time.Second
	maxBody       = 240  // runes of a notification body
	maxEndpoint   = 2048 // bytes of a subscription endpoint
)

var (
	// ErrNoSubscription is a test notification for a device without a
	// subscription.
	ErrNoSubscription = errors.New("이 기기에는 알림 구독이 없습니다")
	// ErrUnknownDevice is a subscription for a device that is not paired,
	// or no longer is.
	ErrUnknownDevice = errors.New("페어링된 기기가 아닙니다")
)

// InvalidError is a subscription Mori cannot take. Its message is for the
// user.
type InvalidError struct{ Msg string }

func (e *InvalidError) Error() string { return e.Msg }

// SendError is a message the push service did not take.
type SendError struct {
	Status int   // the service's HTTP status; 0 when it was not reached
	Err    error // what went wrong, for the log
}

func (e *SendError) Error() string {
	switch {
	case e.Gone():
		return fmt.Sprintf("이 기기의 알림 구독이 만료되어 지웠습니다. 알림을 다시 켜 주세요 (푸시 서비스 응답 %d)", e.Status)
	case e.Status != 0:
		return fmt.Sprintf("푸시 서비스가 알림을 받지 않았습니다 (응답 %d)", e.Status)
	}
	return "푸시 서비스에 닿지 못했습니다: " + e.Err.Error()
}

func (e *SendError) Unwrap() error { return e.Err }

// Gone reports that the subscription no longer exists, which push services
// say with 404 or 410.
func (e *SendError) Gone() bool {
	return e.Status == http.StatusNotFound || e.Status == http.StatusGone
}

// Subscription is a browser's PushSubscription, as its toJSON gives it.
type Subscription struct {
	Endpoint string `json:"endpoint"`
	Keys     Keys   `json:"keys"`
}

// Keys are a subscription's encryption keys, in base64.
type Keys struct {
	P256dh string `json:"p256dh"`
	Auth   string `json:"auth"`
}

// Notifier decides on terminal changes and sends the notifications.
type Notifier struct {
	o    Options
	mu   sync.Mutex
	last map[sentKey]time.Time // when a terminal last got a kind, within the window
	wg   sync.WaitGroup
}

type sentKey struct {
	addr string
	kind Kind
}

// New makes a Notifier. Hand its OnChange to the core manager.
func New(o Options) *Notifier {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Window <= 0 {
		o.Window = defaultWindow
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	return &Notifier{o: o, last: map[sentKey]time.Time{}}
}

// OnChange is for core.Options.OnChange. It decides at once and sends in
// the background, so the event stream does not wait for push services.
func (n *Notifier) OnChange(c core.Change) {
	children := false
	if c.New != nil && c.New.Parent != nil {
		children = n.o.Store.Get().Notify.Children
	}
	kind := Decide(c, children)
	if kind == "" {
		return
	}
	// Someone is looking at it. This is not counted as sent, so a viewer
	// who looks away hears of the next change.
	if n.o.Focused != nil && n.o.Focused(c.Address) {
		return
	}
	if !n.claim(sentKey{c.Address, kind}) {
		return
	}
	body, err := json.Marshal(payloadFor(n.o.Host, kind, c.New))
	if err != nil {
		n.o.Logger.Error("encoding a notification", "err", err)
		return
	}
	n.send(kind, body)
}

// Forward sends p, a notification another host sent this hub, to the
// subscriptions that want k (spec §3 #166). The other host has already
// decided and checked focus, so nothing is held back here.
func (n *Notifier) Forward(k Kind, p Payload) {
	body, err := json.Marshal(p)
	if err != nil {
		n.o.Logger.Error("encoding a notification", "err", err)
		return
	}
	n.send(k, body)
}

// send delivers body in the background to every subscription that wants k.
func (n *Notifier) send(k Kind, body []byte) {
	for _, s := range n.o.Store.Get().PushSubs {
		if wants(s, k) {
			n.wg.Go(func() { n.deliver(context.Background(), s, body) })
		}
	}
}

// Wait waits for the notifications OnChange started. Call it once
// OnChange is no longer called.
func (n *Notifier) Wait() { n.wg.Wait() }

// claim records that k is sent now, unless it was already sent within the
// window.
func (n *Notifier) claim(k sentKey) bool {
	now := n.o.Now()
	n.mu.Lock()
	defer n.mu.Unlock()
	if t, ok := n.last[k]; ok && now.Sub(t) < n.o.Window {
		return false
	}
	for old, t := range n.last {
		if now.Sub(t) >= n.o.Window {
			delete(n.last, old)
		}
	}
	n.last[k] = now
	return true
}

// deliver sends body to s and forgets s when the push service says it is
// gone.
func (n *Notifier) deliver(ctx context.Context, s store.PushSub, body []byte) error {
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	status, err := n.o.Sender.Send(ctx, s, body)
	if err == nil && status >= 200 && status <= 299 {
		return nil
	}
	if err == nil {
		err = fmt.Errorf("push service answered %d", status)
	}
	se := &SendError{Status: status, Err: err}
	log := n.o.Logger.With("subscription", s.ID, "device", s.DeviceID, "service", serviceHost(s.Endpoint))
	if se.Gone() {
		n.forget(s)
		log.Info("push subscription gone", "status", status)
	} else {
		log.Warn("push failed", "status", status, "err", err)
	}
	return se
}

func (n *Notifier) forget(s store.PushSub) {
	if err := n.o.Store.Update(func(st *store.State) error {
		st.PushSubs = slices.DeleteFunc(st.PushSubs, func(x store.PushSub) bool {
			return x.ID == s.ID && x.Endpoint == s.Endpoint
		})
		return nil
	}); err != nil {
		n.o.Logger.Warn("forgetting a push subscription", "subscription", s.ID, "err", err)
	}
}

// Test sends a test notification to the device and says to how many of
// its subscriptions it went. It fails when it went to none.
func (n *Notifier) Test(ctx context.Context, deviceID string) (int, error) {
	subs := n.Subscriptions(deviceID)
	if len(subs) == 0 {
		return 0, ErrNoSubscription
	}
	body, err := json.Marshal(Payload{Title: n.o.Host + " · 시험 알림", Body: "이 기기로 알림이 옵니다.", Tag: "mori-test", URL: "/"})
	if err != nil {
		return 0, err
	}
	sent := 0
	var first error
	for _, s := range subs {
		if err := n.deliver(ctx, s, body); err != nil {
			first = cmp.Or(first, err)
			continue
		}
		sent++
	}
	if sent == 0 {
		return 0, first
	}
	return sent, nil
}

// Subscriptions lists the device's subscriptions.
func (n *Notifier) Subscriptions(deviceID string) []store.PushSub {
	var out []store.PushSub
	for _, s := range n.o.Store.Get().PushSubs {
		if s.DeviceID == deviceID {
			out = append(out, s)
		}
	}
	return out
}

// Subscribe keeps sub for the device, for the kinds it names (none: the
// defaults). A device has one subscription: a new endpoint replaces the
// device's old one, and an endpoint another device had moves to this one,
// since a browser that paired again is still one browser. The same
// endpoint again keeps the subscription's ID and creation time and takes
// the new keys and kinds.
func (n *Notifier) Subscribe(deviceID string, sub Subscription, kinds []Kind) (store.PushSub, error) {
	p256dh, auth, err := sub.check()
	if err != nil {
		return store.PushSub{}, err
	}
	ks, err := kindList(kinds)
	if err != nil {
		return store.PushSub{}, err
	}
	next := store.PushSub{ID: store.NewID("p_"), DeviceID: deviceID, Endpoint: sub.Endpoint,
		P256dh: p256dh, Auth: auth, Kinds: ks, CreatedMs: n.o.Now().UnixMilli()}
	err = n.o.Store.Update(func(st *store.State) error {
		// Checked here, under the store's lock: a device revoked meanwhile
		// has lost its subscriptions and must not get one back.
		if !slices.ContainsFunc(st.Devices, func(d store.Device) bool { return d.ID == deviceID }) {
			return ErrUnknownDevice
		}
		keep := []store.PushSub{}
		for _, s := range st.PushSubs {
			switch {
			case s.DeviceID == deviceID && s.Endpoint == sub.Endpoint:
				next.ID, next.CreatedMs = s.ID, s.CreatedMs
			case s.DeviceID != deviceID && s.Endpoint != sub.Endpoint:
				keep = append(keep, s)
			}
		}
		st.PushSubs = append(keep, next)
		return nil
	})
	if err != nil {
		return store.PushSub{}, err
	}
	return next, nil
}

// Unsubscribe forgets the device's subscription to endpoint, or all of
// them when endpoint is empty. One that is not there is no error.
func (n *Notifier) Unsubscribe(deviceID, endpoint string) error {
	return n.o.Store.Update(func(st *store.State) error {
		st.PushSubs = slices.DeleteFunc(st.PushSubs, func(s store.PushSub) bool {
			return s.DeviceID == deviceID && (endpoint == "" || s.Endpoint == endpoint)
		})
		return nil
	})
}

// check validates the subscription and returns its keys in unpadded
// base64url, whichever base64 the browser used.
func (s Subscription) check() (p256dh, auth string, err error) {
	if len(s.Endpoint) > maxEndpoint {
		return "", "", &InvalidError{fmt.Sprintf("구독 주소는 %d바이트까지입니다", maxEndpoint)}
	}
	if u, err := url.Parse(s.Endpoint); err != nil || u.Scheme != "https" || u.Host == "" {
		return "", "", &InvalidError{"구독 주소는 https 주소여야 합니다"}
	}
	pub, err := decodeKey(s.Keys.P256dh)
	if err == nil {
		_, err = ecdh.P256().NewPublicKey(pub)
	}
	if err != nil {
		return "", "", &InvalidError{"구독의 p256dh 키가 P-256 공개 키가 아닙니다"}
	}
	secret, err := decodeKey(s.Keys.Auth)
	if err != nil || len(secret) != 16 {
		return "", "", &InvalidError{"구독의 auth 키는 16바이트여야 합니다"}
	}
	return enc(pub), enc(secret), nil
}

// decodeKey reads base64 in either alphabet, padded or not.
func decodeKey(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	if strings.ContainsAny(s, "+/") {
		return base64.RawStdEncoding.DecodeString(s)
	}
	return base64.RawURLEncoding.DecodeString(s)
}

func enc(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// kindList checks kinds and returns them once each, in the order of Kinds.
func kindList(kinds []Kind) ([]string, error) {
	if len(kinds) == 0 {
		kinds = DefaultKinds
	}
	for _, k := range kinds {
		if !slices.Contains(Kinds, k) {
			return nil, &InvalidError{fmt.Sprintf("알 수 없는 알림 종류입니다: %q (blocked, waiting, error, exited 중에서 고릅니다)", k)}
		}
	}
	out := []string{}
	for _, k := range Kinds {
		if slices.Contains(kinds, k) {
			out = append(out, string(k))
		}
	}
	return out, nil
}

// KindsOf is the kinds s takes. A subscription stored without kinds takes
// the defaults.
func KindsOf(s store.PushSub) []string {
	if len(s.Kinds) > 0 {
		return s.Kinds
	}
	out := make([]string, len(DefaultKinds))
	for i, k := range DefaultKinds {
		out[i] = string(k)
	}
	return out
}

func wants(s store.PushSub, k Kind) bool { return slices.Contains(KindsOf(s), string(k)) }

// payloadFor is the notification of kind k for t: the host and what
// happened as the title, the terminal's name and what its program said as
// the body.
func payloadFor(host string, k Kind, t *hc.Terminal) Payload {
	var detail string
	switch {
	case k == KindExited:
		detail = exitDetail(t)
	case t.Status != nil:
		detail = t.Status.Msg
	}
	body := oneLine(core.DisplayTitle(*t))
	if d := oneLine(detail); d != "" {
		body += " — " + d
	}
	return Payload{
		Title: host + " · " + k.Label(),
		Body:  clip(body, maxBody),
		Tag:   t.Address,
		URL:   "/#/t/" + url.PathEscape(t.Address),
		Kind:  string(k),
	}
}

func exitDetail(t *hc.Terminal) string {
	switch {
	case t.Signal != nil:
		return fmt.Sprintf("시그널 %d", *t.Signal)
	case t.ExitCode != nil:
		return fmt.Sprintf("종료 코드 %d", *t.ExitCode)
	}
	return ""
}

// oneLine turns control characters into spaces and folds each run of
// white space into one space.
func oneLine(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

// clip cuts s to at most n runes, marking the cut with "…".
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

// serviceHost is the push service an endpoint belongs to. Logs name it
// rather than the endpoint, which works as a credential for the device.
func serviceHost(endpoint string) string {
	if u, err := url.Parse(endpoint); err == nil {
		return u.Host
	}
	return ""
}
