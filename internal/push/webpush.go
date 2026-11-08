package push

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/kwonikhyeon/mori/internal/store"
)

// ttl is how long, in seconds, a push service keeps a message for a device
// that is offline. After a day, waiting for approval is old news.
const ttl = 24 * 60 * 60

// EnsureVAPID returns the host's VAPID key pair, making and saving one the
// first time (spec §3 #11). A stored pair that does not hold together is
// replaced, and the subscriptions go with it: push services refuse them
// under another key, so the devices must subscribe again.
func EnsureVAPID(st *store.Store) (store.VAPID, error) {
	if v := st.Get().VAPID; validVAPID(v) {
		return v, nil
	}
	var v store.VAPID
	err := st.Update(func(s *store.State) error {
		if validVAPID(s.VAPID) {
			v = s.VAPID
			return nil
		}
		k, err := ecdh.P256().GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		v = store.VAPID{Public: enc(k.PublicKey().Bytes()), Private: enc(k.Bytes())}
		s.VAPID = v
		s.PushSubs = []store.PushSub{}
		return nil
	})
	return v, err
}

// validVAPID reports whether v is a P-256 private key and its public key,
// in unpadded base64url.
func validVAPID(v store.VAPID) bool {
	priv, err := base64.RawURLEncoding.DecodeString(v.Private)
	if err != nil {
		return false
	}
	k, err := ecdh.P256().NewPrivateKey(priv)
	return err == nil && enc(k.PublicKey().Bytes()) == v.Public
}

// NewWebPush sends through the push services that browsers name, signed
// with v. subject is how the services can reach whoever runs the sender,
// the VAPID "sub" claim.
func NewWebPush(v store.VAPID, subject string) Sender {
	return &webPush{vapid: v, subject: subject, client: &http.Client{}}
}

type webPush struct {
	vapid   store.VAPID
	subject string
	client  webpush.HTTPClient // the context sets the timeout
}

func (w *webPush) Send(ctx context.Context, sub store.PushSub, payload []byte) (int, error) {
	resp, err := webpush.SendNotificationWithContext(ctx, payload,
		&webpush.Subscription{Endpoint: sub.Endpoint, Keys: webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth}},
		&webpush.Options{
			HTTPClient:      w.client,
			Subscriber:      w.subject,
			TTL:             ttl,
			Urgency:         webpush.UrgencyHigh,
			VAPIDPublicKey:  w.vapid.Public,
			VAPIDPrivateKey: w.vapid.Private,
		})
	if err != nil {
		// A url.Error repeats the endpoint, which logs should not hold.
		if ue := (*url.Error)(nil); errors.As(err, &ue) {
			err = fmt.Errorf("%s %s: %w", ue.Op, serviceHost(sub.Endpoint), ue.Err)
		}
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode <= 299 {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return resp.StatusCode, nil
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
	return resp.StatusCode, fmt.Errorf("push service answered %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
}
