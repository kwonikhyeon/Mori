package main

import (
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/mdp/qrterminal/v3"

	"github.com/kwonikhyeon/mori/internal/admin"
	"github.com/kwonikhyeon/mori/internal/paths"
)

// adminClient reaches the server that uses the state directory homeFlag
// names.
func adminClient(homeFlag string) (admin.Client, error) {
	home, err := paths.Home(homeFlag)
	if err != nil {
		return admin.Client{}, err
	}
	return admin.Client{Path: paths.Socket(home)}, nil
}

func runPair(args []string) error {
	fs := newFlagSet("pair", "[옵션]")
	name := fs.String("name", "", "새 기기의 이름 (기본: 기기가 페어링할 때 보내는 이름)")
	homeFlag := fs.String("home", "", homeUsage)
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	c, err := adminClient(*homeFlag)
	if err != nil {
		return err
	}
	res, err := c.Do(admin.Request{Op: "pair", Name: *name})
	if err != nil {
		return err
	}
	printTable(os.Stdout, [][]string{
		{"코드", res.Code},
		{"만료", time.UnixMilli(res.ExpiresMs).Format("15:04:05") + " (한 번만 쓸 수 있습니다)"},
		{"링크", res.URL},
	})
	fmt.Println()
	qrterminal.GenerateHalfBlock(res.URL, qrterminal.L, os.Stdout)
	fmt.Println()
	fmt.Println("새 기기에서 QR을 찍거나 링크를 여세요. 페어링 화면에 코드를 직접 넣어도 됩니다.")
	if onlyHere(res.URL) {
		fmt.Println("이 링크는 이 컴퓨터에서만 열립니다. 다른 기기에서 쓰려면 Tailscale에 로그인하고 tailscale serve를 켜세요.")
	}
	return nil
}

// onlyHere reports whether link points at a loopback address.
func onlyHere(link string) bool {
	u, err := url.Parse(link)
	if err != nil {
		return false
	}
	h := u.Hostname()
	ip := net.ParseIP(h)
	return h == "localhost" || ip != nil && ip.IsLoopback()
}

func runDevices(args []string) error {
	fs := newFlagSet("devices", "[옵션]")
	homeFlag := fs.String("home", "", homeUsage)
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	c, err := adminClient(*homeFlag)
	if err != nil {
		return err
	}
	res, err := c.Do(admin.Request{Op: "devices"})
	if err != nil {
		return err
	}
	if len(res.Devices) == 0 {
		fmt.Println("페어링된 기기가 없습니다. mori pair로 추가하세요.")
		return nil
	}
	rows := [][]string{{"ID", "이름", "마지막 사용", "페어링"}}
	for _, d := range res.Devices {
		rows = append(rows, []string{d.ID, d.Name, when(d.LastSeenMs), when(d.CreatedMs)})
	}
	printTable(os.Stdout, rows)
	return nil
}

func when(ms int64) string {
	if ms == 0 {
		return "-"
	}
	return time.UnixMilli(ms).Format("2006-01-02 15:04")
}

func runRevoke(args []string) error {
	fs := newFlagSet("revoke", "[옵션] <기기 ID>")
	homeFlag := fs.String("home", "", homeUsage)
	if err := parseFlags(fs, args, "기기 ID"); err != nil {
		return err
	}
	c, err := adminClient(*homeFlag)
	if err != nil {
		return err
	}
	if _, err := c.Do(admin.Request{Op: "revoke", ID: fs.Arg(0)}); err != nil {
		return err
	}
	fmt.Printf("기기 %s: 페어링을 철회했습니다. 그 기기의 열린 연결은 바로 끊깁니다.\n", fs.Arg(0))
	return nil
}

// printTable lines up columns. A terminal gives Hangul and other wide
// characters two cells, which text/tabwriter does not count.
func printTable(w io.Writer, rows [][]string) {
	var widths []int
	for _, r := range rows {
		for i, c := range r {
			if i == len(widths) {
				widths = append(widths, 0)
			}
			widths[i] = max(widths[i], cellWidth(c))
		}
	}
	for _, r := range rows {
		var b strings.Builder
		for i, c := range r {
			b.WriteString(c)
			if i < len(r)-1 {
				b.WriteString(strings.Repeat(" ", widths[i]-cellWidth(c)+2))
			}
		}
		fmt.Fprintln(w, b.String())
	}
}

func cellWidth(s string) int {
	n := 0
	for _, r := range s {
		n++
		if isWide(r) {
			n++
		}
	}
	return n
}

// isWide covers the East Asian wide ranges that names are likely to use.
func isWide(r rune) bool {
	return r >= 0x1100 && r <= 0x115F || // Hangul Jamo initials
		r >= 0x2E80 && r <= 0xA4CF || // CJK, kana, Hangul compatibility Jamo
		r >= 0xAC00 && r <= 0xD7A3 || // Hangul syllables
		r >= 0xF900 && r <= 0xFAFF || // CJK compatibility ideographs
		r >= 0xFF00 && r <= 0xFF60 || r >= 0xFFE0 && r <= 0xFFE6 || // fullwidth forms
		r >= 0x1F300 && r <= 0x1F64F || r >= 0x1F900 && r <= 0x1F9FF || // emoji
		r >= 0x20000 && r <= 0x3FFFD // CJK extensions
}
