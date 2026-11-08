package auth

import (
	"crypto/rand"
	"strings"
	"time"
	"unicode"
)

// codeAlphabet is Crockford's base32: no I, L, O or U, which read like
// other characters.
const codeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

const codeTTL = 5 * time.Minute

// Code is a pairing code waiting to be used.
type Code struct {
	Code    string    // "XXXX-XXXX"
	Name    string    // the name the device gets if it sends none
	Expires time.Time // valid up to and including this instant
}

// randomCode returns 8 characters holding 40 random bits.
func randomCode() string {
	var b [5]byte
	rand.Read(b[:]) // never fails; the runtime aborts if the OS source does
	v := uint64(b[0])<<32 | uint64(b[1])<<24 | uint64(b[2])<<16 | uint64(b[3])<<8 | uint64(b[4])
	var out [8]byte
	for i := len(out) - 1; i >= 0; i-- {
		out[i] = codeAlphabet[v&31]
		v >>= 5
	}
	return string(out[:])
}

// NormalizeCode turns a code as typed into its stored form: upper case,
// without dashes or spaces, with O read as 0 and I and L as 1.
func NormalizeCode(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '-' || unicode.IsSpace(r) {
			return -1
		}
		switch r = unicode.ToUpper(r); r {
		case 'O':
			return '0'
		case 'I', 'L':
			return '1'
		}
		return r
	}, s)
}

func formatCode(key string) string { return key[:4] + "-" + key[4:] }
