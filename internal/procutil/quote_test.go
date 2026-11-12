package procutil

import "testing"

func TestQuoteArg(t *testing.T) {
	for in, want := range map[string]string{
		"serve":          "serve",
		"127.0.0.1:7761": "127.0.0.1:7761",
		"":               "''",
		"a b":            "'a b'",
		"it's":           `'it'\''s'`,
		"$HOME":          "'$HOME'",
		"/Users/u/Library/Application Support/Mori": "'/Users/u/Library/Application Support/Mori'",
	} {
		if got := QuoteArg(in); got != want {
			t.Errorf("%q: %s want %s", in, got, want)
		}
	}
}

func TestQuotePSArg(t *testing.T) {
	for in, want := range map[string]string{
		"--resume": "--resume",
		"":         "''",
		`C:\Users\u\AppData\Local\Mori\claude-settings.json`: `'C:\Users\u\AppData\Local\Mori\claude-settings.json'`,
		"it's":  "'it''s'",
		"it’s":  "'it’’s'", // PowerShell reads the curly quote as one too
		"$HOME": "'$HOME'",
	} {
		if got := QuotePSArg(in); got != want {
			t.Errorf("%q: %s want %s", in, got, want)
		}
	}
}

func TestQuoteWinArg(t *testing.T) {
	for in, want := range map[string]string{
		"serve":         "serve",
		"--log":         "--log",
		"":              `""`,
		"a b":           `"a b"`,
		`a"b`:           `"a\"b"`,
		`a\b`:           `"a\b"`,
		`C:\dir\`:       `"C:\dir\\"`,
		`a\\"b`:         `"a\\\\\"b"`,
		`C:\Mori\x.log`: `"C:\Mori\x.log"`,
	} {
		if got := QuoteWinArg(in); got != want {
			t.Errorf("%q: %s want %s", in, got, want)
		}
	}
}
