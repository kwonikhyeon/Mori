package push

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/store"
)

type pushRequest struct {
	header http.Header
	body   []byte
}

// TestWebPushSend sends to a fake push service and reads the message back
// as a browser would (RFC 8291, RFC 8292).
func TestWebPushSend(t *testing.T) {
	reqs := make(chan pushRequest, 2)
	var status atomic.Int32
	status.Store(http.StatusCreated)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		reqs <- pushRequest{r.Header.Clone(), b}
		w.WriteHeader(int(status.Load()))
		io.WriteString(w, "no such subscription\n")
	}))
	defer srv.Close()

	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	v, err := EnsureVAPID(st)
	if err != nil {
		t.Fatal(err)
	}
	ua, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, 16)
	rand.Read(secret)
	sub := store.PushSub{Endpoint: srv.URL + "/push/abc", P256dh: enc(ua.PublicKey().Bytes()), Auth: enc(secret)}
	const subject = "https://github.com/kwonikhyeon/Mori"
	w := NewWebPush(v, subject).(*webPush)
	w.client = srv.Client()

	payload := []byte(`{"title":"macmini · 승인 대기","body":"claude — Allow Bash?","tag":"t1","url":"/#/t/t1"}`)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	code, err := w.Send(ctx, sub, payload)
	if err != nil || code != http.StatusCreated {
		t.Fatalf("Send = %d, %v", code, err)
	}
	req := <-reqs
	for k, want := range map[string]string{"Content-Encoding": "aes128gcm", "Ttl": "86400", "Urgency": "high"} {
		if got := req.header.Get(k); got != want {
			t.Errorf("%s: %q, want %q", k, got, want)
		}
	}
	checkVAPID(t, req.header.Get("Authorization"), v.Public, srv.URL, subject)
	got, err := Decrypt(req.body, ua, secret)
	if err != nil || !bytes.Equal(got, payload) {
		t.Errorf("Decrypt = %q, %v; want %q", got, err, payload)
	}
	other, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	bad := bytes.Clone(req.body)
	bad[len(bad)-1] ^= 1
	for name, try := range map[string]func() ([]byte, error){
		"short":        func() ([]byte, error) { return Decrypt(req.body[:20], ua, secret) },
		"another key":  func() ([]byte, error) { return Decrypt(req.body, other, secret) },
		"another auth": func() ([]byte, error) { return Decrypt(req.body, ua, make([]byte, 16)) },
		"tampered":     func() ([]byte, error) { return Decrypt(bad, ua, secret) },
		"cut":          func() ([]byte, error) { return Decrypt(req.body[:len(req.body)-1], ua, secret) },
	} {
		if b, err := try(); err == nil {
			t.Errorf("%s: Decrypt = %q, want an error", name, b)
		}
	}

	status.Store(http.StatusGone)
	code, err = w.Send(ctx, sub, payload)
	<-reqs
	if code != http.StatusGone || err == nil || !strings.Contains(err.Error(), "410") || !strings.Contains(err.Error(), "no such subscription") {
		t.Errorf("Send to a gone subscription = %d, %v", code, err)
	}

	srv.Close()
	code, err = w.Send(ctx, sub, payload)
	if code != 0 || err == nil || strings.Contains(err.Error(), "/push/abc") {
		t.Errorf("Send to a closed service = %d, %v; want 0 and an error without the endpoint", code, err)
	}
}

// checkVAPID checks an Authorization header of the form
// "vapid t=<JWT>, k=<public key>" (RFC 8292).
func checkVAPID(t *testing.T, header, public, origin, subject string) {
	t.Helper()
	rest, ok := strings.CutPrefix(header, "vapid ")
	if !ok {
		t.Fatalf("Authorization %q", header)
	}
	var tok, k string
	for _, part := range strings.Split(rest, ",") {
		part = strings.TrimSpace(part)
		if v, ok := strings.CutPrefix(part, "t="); ok {
			tok = v
		} else if v, ok := strings.CutPrefix(part, "k="); ok {
			k = v
		}
	}
	if k != public {
		t.Errorf("k=%q, want the host's public key %q", k, public)
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("token %q", tok)
	}
	var head struct{ Alg, Typ string }
	var claims struct {
		Aud string `json:"aud"`
		Sub string `json:"sub"`
		Exp int64  `json:"exp"`
	}
	for i, v := range []any{&head, &claims} {
		b, err := base64.RawURLEncoding.DecodeString(parts[i])
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(b, v); err != nil {
			t.Fatal(err)
		}
	}
	if head.Alg != "ES256" {
		t.Errorf("alg %q", head.Alg)
	}
	now := time.Now().Unix()
	if claims.Aud != origin || claims.Sub != subject || claims.Exp <= now || claims.Exp > now+24*60*60 {
		t.Errorf("claims %+v; want aud %q, sub %q, exp within a day", claims, origin, subject)
	}
	pub, err := base64.RawURLEncoding.DecodeString(public)
	if err != nil {
		t.Fatal(err)
	}
	pk, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), pub)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != 64 {
		t.Fatalf("signature: %d bytes, %v", len(sig), err)
	}
	h := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(pk, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Error("the token is not signed by the host's key")
	}
}

func TestEnsureVAPIDReplacesBrokenPair(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	a, err := EnsureVAPID(st)
	if err != nil {
		t.Fatal(err)
	}
	b, err := EnsureVAPID(st)
	if err != nil || b != a {
		t.Fatalf("a good pair was replaced: %+v, %v", b, err)
	}
	other, _ := ecdh.P256().GenerateKey(rand.Reader)
	if err := st.Update(func(s *store.State) error {
		s.VAPID.Public = enc(other.PublicKey().Bytes()) // not the private key's
		s.PushSubs = []store.PushSub{{ID: "p_1", DeviceID: "d1", Endpoint: "https://push.example.com/a"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	c, err := EnsureVAPID(st)
	if err != nil || c == a || !validVAPID(c) {
		t.Fatalf("broken pair: got %+v, %v", c, err)
	}
	if subs := st.Get().PushSubs; len(subs) != 0 {
		t.Errorf("subscriptions under the old key stayed: %+v", subs)
	}
}
