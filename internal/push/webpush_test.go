package push

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
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
	if got := decrypt(t, req.body, ua, secret); !bytes.Equal(got, payload) {
		t.Errorf("decrypted %q, want %q", got, payload)
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

// decrypt reads an aes128gcm message with the subscription's private key
// and auth secret (RFC 8188, RFC 8291).
func decrypt(t *testing.T, body []byte, ua *ecdh.PrivateKey, secret []byte) []byte {
	t.Helper()
	if len(body) < 21 {
		t.Fatalf("body of %d bytes", len(body))
	}
	salt, idlen := body[:16], int(body[20])
	if rs := binary.BigEndian.Uint32(body[16:20]); rs < 18 {
		t.Fatalf("record size %d", rs)
	}
	keyid, ct := body[21:21+idlen], body[21+idlen:]
	as, err := ecdh.P256().NewPublicKey(keyid)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := ua.ECDH(as)
	if err != nil {
		t.Fatal(err)
	}
	must := func(b []byte, err error) []byte {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	prkKey := must(hkdf.Extract(sha256.New, shared, secret))
	ikm := must(hkdf.Expand(sha256.New, prkKey, "WebPush: info\x00"+string(ua.PublicKey().Bytes())+string(keyid), 32))
	prk := must(hkdf.Extract(sha256.New, ikm, salt))
	cek := must(hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16))
	nonce := must(hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12))
	block, err := aes.NewCipher(cek)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	plain := must(gcm.Open(nil, nonce, ct, nil))
	plain = bytes.TrimRight(plain, "\x00")
	if len(plain) == 0 || plain[len(plain)-1] != 2 {
		t.Fatal("the record does not end with the last-record delimiter")
	}
	return plain[:len(plain)-1]
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
