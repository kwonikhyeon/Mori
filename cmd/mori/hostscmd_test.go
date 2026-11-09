package main

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/kwonikhyeon/mori/internal/admin"
)

// hostsServer is a running hub's admin socket as far as hosts go.
type hostsServer struct {
	statusServer
	mu     sync.Mutex
	hosts  []admin.HostInfo
	linked []string // the last link_host: its URL, code and name
}

func (s *hostsServer) Hosts() []admin.HostInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.hosts)
}

func (s *hostsServer) LinkHost(ctx context.Context, rawURL, code, name string) (admin.HostInfo, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.linked = []string{rawURL, code, name}
	for i, h := range s.hosts {
		if h.URL == rawURL {
			s.hosts[i].Name = cmp.Or(name, h.Name)
			return s.hosts[i], false, nil
		}
	}
	h := admin.HostInfo{ID: "h_3", Name: cmp.Or(name, "macmini"), URL: "https://macmini.example.ts.net", Linked: true,
		RelayError: "허브 주소가 https가 아니라 알림을 중계할 수 없습니다"}
	s.hosts = append(s.hosts, h)
	return h, true, nil
}

func (s *hostsServer) UnlinkHost(ctx context.Context, idOrName string) (admin.HostInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.hosts, func(h admin.HostInfo) bool { return h.ID == idOrName || h.Name == idOrName })
	if i < 0 {
		return admin.HostInfo{}, errors.New("그런 호스트가 없습니다: " + idOrName)
	}
	h := s.hosts[i]
	s.hosts = slices.Delete(s.hosts, i, i+1)
	return h, nil
}

// lastLink is what the last link_host asked for; the socket's goroutine wrote it.
func (s *hostsServer) lastLink() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.linked
}

func TestHostsCommand(t *testing.T) {
	s := &hostsServer{hosts: []admin.HostInfo{
		{ID: "h_1", Name: "desk", URL: "https://desk.example.ts.net", Linked: true, Version: "0.3.0", Relay: true},
		{ID: "h_2", Name: "lab", URL: "https://lab.example.ts.net"},
	}}
	home := serveAdmin(t, s)
	run := func(args ...string) (string, error) {
		var b bytes.Buffer
		err := runHosts(&b, append(args, "--home", home))
		return b.String(), err
	}

	out, err := run()
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if err != nil || len(lines) != 3 || !strings.HasPrefix(lines[0], "ID") ||
		!strings.Contains(lines[1], "연결됨") || !strings.Contains(lines[1], "0.3.0") ||
		!strings.Contains(lines[2], "끊김") || !strings.Contains(lines[2], "끔") || !strings.HasSuffix(lines[2], "-") {
		t.Fatalf("%v\n%s", err, out)
	}

	pairLink := "https://macmini.example.ts.net/pair#code=ABCD-EFGH"
	out, err = run("link", pairLink, "--name", "책상")
	if err != nil || !strings.Contains(out, "호스트를 이었습니다: 책상 (https://macmini.example.ts.net)") ||
		!strings.Contains(out, "알림 중계는 꺼져 있습니다: 허브 주소가 https가 아니라") {
		t.Fatalf("%v\n%s", err, out)
	}
	if got := s.lastLink(); !slices.Equal(got, []string{pairLink, "", "책상"}) {
		t.Fatalf("%q", got)
	}
	out, err = run("link", "https://desk.example.ts.net", "ABCD-EFGH")
	if err != nil || !strings.Contains(out, "호스트를 다시 이었습니다: desk (https://desk.example.ts.net)") ||
		!strings.Contains(out, "알림을 이 허브로 중계합니다.") {
		t.Fatalf("%v\n%s", err, out)
	}
	if got := s.lastLink(); !slices.Equal(got, []string{"https://desk.example.ts.net", "ABCD-EFGH", ""}) {
		t.Fatalf("%q", got)
	}

	out, err = run("unlink", "lab")
	if err != nil || !strings.Contains(out, "호스트를 끊었습니다: lab (https://lab.example.ts.net)") {
		t.Fatalf("%v\n%s", err, out)
	}
	if out, _ := run(); strings.Contains(out, "lab.example") {
		t.Fatal(out)
	}
	if _, err := run("unlink", "nope"); err == nil || !strings.Contains(err.Error(), "그런 호스트가 없습니다") {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"unlink"}, {"lsit"}} {
		if _, err := run(args...); !errors.Is(err, errUsage) {
			t.Errorf("%q: %v", args, err)
		}
	}
}
