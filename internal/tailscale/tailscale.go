// Package tailscale asks the local Tailscale client for this machine's
// name and for what tailscale serve forwards.
package tailscale

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/kwonikhyeon/mori/internal/procutil"
)

var ErrNotFound = errors.New("tailscale 명령을 찾지 못했습니다")

const runTimeout = 5 * time.Second

// Find locates the tailscale command: on PATH, or where the macOS app and
// the Windows installer put it.
func Find() (string, error) {
	if p, err := exec.LookPath("tailscale"); err == nil {
		return p, nil
	}
	var known []string
	switch runtime.GOOS {
	case "darwin":
		known = []string{"/Applications/Tailscale.app/Contents/MacOS/Tailscale"}
	case "windows":
		known = []string{filepath.Join(cmp.Or(os.Getenv("ProgramFiles"), `C:\Program Files`), "Tailscale", "tailscale.exe")}
	}
	for _, p := range known {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p, nil
		}
	}
	return "", ErrNotFound
}

// DNSName is this machine's MagicDNS name, like "macmini.example.ts.net".
func DNSName(ctx context.Context) (string, error) {
	out, err := run(ctx, "status", "--json")
	if err != nil {
		return "", err
	}
	return dnsName(out)
}

func dnsName(status []byte) (string, error) {
	var st struct {
		Self struct{ DNSName string }
	}
	if err := json.Unmarshal(status, &st); err != nil {
		return "", fmt.Errorf("tailscale status: %w", err)
	}
	name := strings.TrimSuffix(st.Self.DNSName, ".")
	if name == "" {
		return "", errors.New("tailscale에 이 기기의 DNS 이름이 없습니다. 로그인했는지, MagicDNS가 켜져 있는지 확인하세요")
	}
	return name, nil
}

// ServeStatus is the tailscale serve configuration, as JSON.
func ServeStatus(ctx context.Context) (json.RawMessage, error) {
	out, err := run(ctx, "serve", "status", "--json")
	if err != nil {
		return nil, err
	}
	if !json.Valid(out) {
		return nil, errors.New("tailscale serve status: JSON이 아닌 출력")
	}
	return out, nil
}

// ProxiesTo reports whether a serve configuration forwards to target, such
// as "http://127.0.0.1:7761": whether any "Proxy" value in it is target.
func ProxiesTo(cfg json.RawMessage, target string) bool {
	var v any
	if json.Unmarshal(cfg, &v) != nil {
		return false
	}
	return hasProxy(v, strings.TrimSuffix(target, "/"))
}

func hasProxy(v any, target string) bool {
	switch v := v.(type) {
	case map[string]any:
		for k, x := range v {
			if s, ok := x.(string); ok && k == "Proxy" && strings.TrimSuffix(s, "/") == target {
				return true
			}
			if hasProxy(x, target) {
				return true
			}
		}
	case []any:
		for _, x := range v {
			if hasProxy(x, target) {
				return true
			}
		}
	}
	return false
}

func run(ctx context.Context, args ...string) ([]byte, error) {
	bin, err := Find()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	procutil.HideWindow(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("tailscale %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}
