package core

import (
	"fmt"
	"hash/crc32"

	"github.com/kwonikhyeon/mori/internal/hc"
)

// AskID names the question t asks while it is blocked: its turn and a
// checksum of the kind and message it reported. It is "" when t asks
// nothing. A device answers with the ID it saw, and the server refuses an
// answer when the program asks something else by then (spec §3 #194). The
// turn tells apart questions with the same words: a program that worked
// between them has moved its turn on.
func AskID(t hc.Terminal) string {
	if t.State != "live" || t.Status == nil || t.Status.State != "blocked" {
		return ""
	}
	kind := ""
	if t.Status.Kind != nil {
		kind = *t.Status.Kind
	}
	sum := crc32.ChecksumIEEE([]byte(kind + "\x00" + t.Status.Msg))
	return fmt.Sprintf("%d.%08x", t.Turn, sum)
}
