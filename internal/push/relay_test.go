package push_test

import (
	"testing"

	"github.com/kwonikhyeon/mori/internal/push"
)

func TestRelayed(t *testing.T) {
	for _, tc := range []struct {
		name     string
		in, want push.Payload
		kind     push.Kind
		ok       bool
	}{
		{"with its kind",
			push.Payload{Title: "desk · 승인 대기", Body: "claude — Allow Bash?", Tag: "machine/t7", URL: "/#/t/machine%2Ft7", Kind: "blocked"},
			push.Payload{Title: "desk · 승인 대기", Body: "claude — Allow Bash?", Tag: "h_abc/machine/t7", URL: "/#/h/h_abc/t/machine%2Ft7", Kind: "blocked"},
			push.KindBlocked, true},
		{"from a Mori without kinds",
			push.Payload{Title: "desk · 오류", Body: "make", Tag: "t1", URL: "/#/t/t1"},
			push.Payload{Title: "desk · 오류", Body: "make", Tag: "h_abc/t1", URL: "/#/h/h_abc/t/t1", Kind: "error"},
			push.KindError, true},
		{"host test notification", push.Payload{Title: "desk · 시험 알림", Tag: "mori-test", URL: "/"}, push.Payload{}, "", false},
		{"unknown kind", push.Payload{Title: "desk · 승인 대기", Tag: "t1", URL: "/#/t/t1", Kind: "party"}, push.Payload{}, "", false},
		{"no kind in the title", push.Payload{Title: "desk", Tag: "t1", URL: "/#/t/t1"}, push.Payload{}, "", false},
		{"bad escape", push.Payload{Title: "desk · 오류", Tag: "t1", URL: "/#/t/%zz"}, push.Payload{}, "", false},
		{"empty address", push.Payload{Title: "desk · 오류", Tag: "t1", URL: "/#/t/"}, push.Payload{}, "", false},
		{"already relayed", push.Payload{Title: "desk · 오류", Tag: "h_x/t1", URL: "/#/h/h_x/t/t1", Kind: "error"}, push.Payload{}, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, k, ok := push.Relayed("h_abc", tc.in)
			if ok != tc.ok || k != tc.kind || got != tc.want {
				t.Fatalf("Relayed = %+v, %q, %v; want %+v, %q, %v", got, k, ok, tc.want, tc.kind, tc.ok)
			}
		})
	}
}
