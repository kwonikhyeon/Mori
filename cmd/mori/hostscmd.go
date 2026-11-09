package main

import (
	"cmp"
	"errors"
	"fmt"
	"io"

	"github.com/kwonikhyeon/mori/internal/admin"
)

// runHosts lists the hosts this hub links to, or links and unlinks one
// (spec §3 #169). It writes to w so that a test can read it.
func runHosts(w io.Writer, args []string) error {
	if len(args) > 0 {
		switch args[0] {
		case "link":
			return runLinkHost(w, args[1:])
		case "unlink":
			return runUnlinkHost(w, args[1:])
		}
	}
	fs := newFlagSet("hosts", "[옵션]\n        mori hosts link [옵션] <주소 또는 페어링 링크> [코드]\n        mori hosts unlink [옵션] <ID 또는 이름>")
	homeFlag := fs.String("home", "", homeUsage)
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	c, err := adminClient(*homeFlag)
	if err != nil {
		return err
	}
	res, err := c.Do(admin.Request{Op: "hosts"})
	if err != nil {
		return err
	}
	if len(res.Hosts) == 0 {
		fmt.Fprintln(w, "이은 호스트가 없습니다. mori hosts link로 이으세요.")
		return nil
	}
	rows := [][]string{{"ID", "이름", "주소", "연결", "알림", "버전"}}
	for _, h := range res.Hosts {
		rows = append(rows, []string{h.ID, h.Name, h.URL, yesNo(h.Linked, "연결됨", "끊김"), yesNo(h.Relay, "켬", "끔"), cmp.Or(h.Version, "-")})
	}
	printTable(w, rows)
	return nil
}

func runLinkHost(w io.Writer, args []string) error {
	fs := newFlagSet("hosts link", "[옵션] <주소 또는 페어링 링크> [코드]")
	name := fs.String("name", "", "이 허브에서 부를 이름 (기본: 그 호스트의 이름)")
	homeFlag := fs.String("home", "", homeUsage)
	if err := parseFlags(fs, args, "주소 또는 페어링 링크", "[코드]"); err != nil {
		return err
	}
	c, err := adminClient(*homeFlag)
	if err != nil {
		return err
	}
	res, err := c.Do(admin.Request{Op: "link_host", URL: fs.Arg(0), Code: fs.Arg(1), Name: *name})
	if err != nil {
		return err
	}
	h := res.Host
	if h == nil {
		return errors.New("서버의 응답에 호스트가 없습니다")
	}
	verb := "다시 이었습니다"
	if res.Created {
		verb = "이었습니다"
	}
	fmt.Fprintf(w, "호스트를 %s: %s (%s)\n", verb, h.Name, h.URL)
	switch {
	case h.Relay:
		fmt.Fprintln(w, "알림을 이 허브로 중계합니다.")
	case h.RelayError != "":
		fmt.Fprintln(w, "알림 중계는 꺼져 있습니다: "+h.RelayError)
	default:
		fmt.Fprintln(w, "알림 중계는 꺼져 있습니다.")
	}
	return nil
}

func runUnlinkHost(w io.Writer, args []string) error {
	fs := newFlagSet("hosts unlink", "[옵션] <ID 또는 이름>")
	homeFlag := fs.String("home", "", homeUsage)
	if err := parseFlags(fs, args, "ID 또는 이름"); err != nil {
		return err
	}
	c, err := adminClient(*homeFlag)
	if err != nil {
		return err
	}
	res, err := c.Do(admin.Request{Op: "unlink_host", ID: fs.Arg(0)})
	if err != nil {
		return err
	}
	if res.Host == nil {
		return errors.New("서버의 응답에 호스트가 없습니다")
	}
	fmt.Fprintf(w, "호스트를 끊었습니다: %s (%s)\n", res.Host.Name, res.Host.URL)
	return nil
}

// yesNo is yes when b holds, no otherwise.
func yesNo(b bool, yes, no string) string {
	if b {
		return yes
	}
	return no
}
