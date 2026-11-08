package procutil

import (
	"runtime"
	"strings"
)

// WithoutEnv returns env without the named variables. Names compare
// without case on Windows, as the OS does.
func WithoutEnv(env []string, names ...string) []string {
	out := make([]string, 0, len(env))
next:
	for _, kv := range env {
		name := envName(kv)
		for _, n := range names {
			if name == n || runtime.GOOS == "windows" && strings.EqualFold(name, n) {
				continue next
			}
		}
		out = append(out, kv)
	}
	return out
}

func envName(kv string) string {
	start := 0
	if strings.HasPrefix(kv, "=") {
		start = 1 // Windows per-drive entries look like "=C:=C:\dir"
	}
	if i := strings.IndexByte(kv[start:], '='); i >= 0 {
		return kv[:start+i]
	}
	return kv
}
