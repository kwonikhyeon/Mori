package tailscale

import "testing"

func TestDNSName(t *testing.T) {
	got, err := dnsName([]byte(`{"BackendState":"Running","Self":{"HostName":"macmini","DNSName":"macmini.example.ts.net."}}`))
	if err != nil || got != "macmini.example.ts.net" {
		t.Fatal(got, err)
	}
	if _, err := dnsName([]byte(`{"BackendState":"NeedsLogin","Self":{"DNSName":""}}`)); err == nil {
		t.Fatal("logged out must error")
	}
	if _, err := dnsName([]byte(`not json`)); err == nil {
		t.Fatal("bad output must error")
	}
}

func TestProxiesTo(t *testing.T) {
	cfg := []byte(`{
		"TCP": {"443": {"HTTPS": true}},
		"Web": {"macmini.example.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:7761"}}}}
	}`)
	for target, want := range map[string]bool{
		"http://127.0.0.1:7761":  true,
		"http://127.0.0.1:7761/": true,
		"http://127.0.0.1:7762":  false,
		"":                       false,
	} {
		if got := ProxiesTo(cfg, target); got != want {
			t.Errorf("%q: %v", target, got)
		}
	}
	if ProxiesTo([]byte(`{}`), "http://127.0.0.1:7761") || ProxiesTo([]byte(`nope`), "x") {
		t.Fatal("empty or bad config proxies nothing")
	}
}
