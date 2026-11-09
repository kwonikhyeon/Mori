package push

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"net/url"
	"slices"
	"strings"
)

var errUndecryptable = errors.New("not a message for this key")

// Decrypt opens a Web Push message body (RFC 8291, aes128gcm in one
// record, RFC 8188) sent to the subscription with priv and authSecret.
func Decrypt(body []byte, priv *ecdh.PrivateKey, authSecret []byte) ([]byte, error) {
	if len(body) < 21 {
		return nil, errUndecryptable
	}
	salt, rs, idLen := body[:16], binary.BigEndian.Uint32(body[16:20]), int(body[20])
	if len(body) < 21+idLen {
		return nil, errUndecryptable
	}
	keyID, ct := body[21:21+idLen], body[21+idLen:]
	if rs < 18 || len(ct) < 17 || uint32(len(ct)) > rs {
		return nil, errUndecryptable
	}
	pub, err := ecdh.P256().NewPublicKey(keyID)
	if err != nil {
		return nil, errUndecryptable
	}
	shared, err := priv.ECDH(pub)
	if err != nil {
		return nil, errUndecryptable
	}
	info := append(append([]byte("WebPush: info\x00"), priv.PublicKey().Bytes()...), keyID...)
	ikm, err := hkdf.Key(sha256.New, shared, authSecret, string(info), 32)
	if err != nil {
		return nil, errUndecryptable
	}
	cek, err := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, errUndecryptable
	}
	nonce, err := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, errUndecryptable
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, errUndecryptable
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errUndecryptable
	}
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, errUndecryptable
	}
	plain = bytes.TrimRight(plain, "\x00") // the last record ends with 2, then zeros
	if len(plain) == 0 || plain[len(plain)-1] != 2 {
		return nil, errUndecryptable
	}
	return plain[:len(plain)-1], nil
}

// Relayed is p, a notification the host hostID sent, made into one of
// this hub's (spec §3 #166, #167): a tap opens the terminal under that
// host, and the tag keeps hosts apart. ok is false for what is not about a
// terminal (a test notification, one a host relayed from another) and for
// a kind this build does not know.
func Relayed(hostID string, p Payload) (Payload, Kind, bool) {
	rest, ok := strings.CutPrefix(p.URL, "/#/t/")
	if !ok {
		return Payload{}, "", false
	}
	addr, err := url.PathUnescape(rest)
	if err != nil || addr == "" {
		return Payload{}, "", false
	}
	k := Kind(p.Kind)
	if k == "" {
		k = kindFromTitle(p.Title) // a Mori from before #167
	}
	if !slices.Contains(Kinds, k) {
		return Payload{}, "", false
	}
	p.URL = "/#/h/" + hostID + "/t/" + url.PathEscape(addr)
	p.Tag = hostID + "/" + p.Tag
	p.Kind = string(k)
	return p, k, true
}

// kindFromTitle reads the kind from a title "<host> · <label>".
func kindFromTitle(title string) Kind {
	for _, k := range Kinds {
		if strings.HasSuffix(title, " · "+k.Label()) {
			return k
		}
	}
	return ""
}
