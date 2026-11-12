package procutil

import "strings"

// QuoteArg quotes s for a POSIX shell, for commands Mori shows the user:
// as is when that is safe, else in single quotes.
func QuoteArg(s string) string {
	if plain(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// psQuotes doubles each character PowerShell reads as a single quote.
var psQuotes = strings.NewReplacer("'", "''", "\u2018", "\u2018\u2018", "\u2019", "\u2019\u2019", "\u201a", "\u201a\u201a", "\u201b", "\u201b\u201b")

// QuotePSArg quotes s for PowerShell: as is when that is safe, else in
// single quotes, with each quote inside doubled.
func QuotePSArg(s string) string {
	if plain(s) {
		return s
	}
	return "'" + psQuotes.Replace(s) + "'"
}

// QuoteWinArg quotes s so that a program that splits its command line as
// the Microsoft C runtime and Go do gets s back: as is when that is safe,
// else in double quotes, with the backslashes before a quote doubled.
func QuoteWinArg(s string) string {
	if plain(s) {
		return s
	}
	var b strings.Builder
	b.WriteByte('"')
	n := 0 // backslashes not yet written
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '\\':
			n++
			continue
		case '"':
			b.WriteString(strings.Repeat(`\`, 2*n+1))
		default:
			b.WriteString(strings.Repeat(`\`, n))
		}
		n = 0
		b.WriteByte(s[i])
	}
	b.WriteString(strings.Repeat(`\`, 2*n)) // the closing quote must stay one
	b.WriteByte('"')
	return b.String()
}

// plain reports whether s holds only letters, digits and ._=:/-, which no
// shell treats specially. A leading = is out, as zsh expands =name.
func plain(s string) bool {
	if s == "" || s[0] == '=' {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !('a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte("._=:/-", c) >= 0) {
			return false
		}
	}
	return true
}
