package server

import (
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"
)

// namesEvery is how often the server may ask Deps.Names again for a Host
// it does not know: Tailscale may come up, or be renamed, after it starts.
const namesEvery = 10 * time.Second

// errBadHost refuses a request sent to a name this server does not go by.
var errBadHost = &apiError{Status: http.StatusMisdirectedRequest, Kind: "bad_host",
	Message: "이 주소로는 Mori에 들어올 수 없습니다",
	Hint:    "Tailscale 이름이나 127.0.0.1로 여세요. 다른 이름을 쓰려면 mori serve --public-url로 알려 주세요"}

// hostCheck tells whether a request's Host names this server (spec §3
// #193). A page that a DNS rebinding pointed at 127.0.0.1 still sends its
// own name, so only IP addresses, localhost and the server's own names
// pass.
type hostCheck struct {
	names func() []string
	mu    sync.Mutex
	known map[string]bool
	next  time.Time // when names may be asked again
}

func (c *hostCheck) allows(hostport string) bool {
	h := hostname(hostport)
	if h == "" || h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	if _, err := netip.ParseAddr(h); err == nil {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.known[h] {
		return true
	}
	if now := time.Now(); !now.Before(c.next) {
		c.next = now.Add(namesEvery)
		c.mu.Unlock() // names may run the tailscale CLI for seconds
		names := c.names()
		c.mu.Lock()
		c.known = map[string]bool{}
		for _, n := range names {
			if strings.Contains(n, "://") {
				u, err := url.Parse(n)
				if err != nil {
					continue
				}
				n = u.Host
			}
			if n = hostname(n); n != "" {
				c.known[n] = true
			}
		}
	}
	return c.known[h]
}

// hostname is the name in a Host header or URL host, lowercased, without
// its port, the brackets of an IPv6 address or a final dot.
func hostname(hostport string) string {
	h := hostport
	if host, _, err := net.SplitHostPort(hostport); err == nil {
		h = host
	} else {
		h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
	}
	return strings.TrimSuffix(strings.ToLower(h), ".")
}
