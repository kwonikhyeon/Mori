# Mori 여러 호스트 허브 구현 계획 (단계 11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 폰이 허브 Mori 하나에만 페어링하고 알림을 구독해도, 그 허브에 이은 다른 호스트의 세션을 열고 입력하며 그 호스트의 승인 대기 알림을 받는다(설계 단계 11, 결정 158~171).

**Architecture:** 허브는 이은 호스트마다 그 호스트에 기기로 페어링해 받은 토큰을 `state.json`에 둔다. `/h/<ID>/api/…`·`/h/<ID>/ws/…` 중 허용 목록에 있는 것만 `httputil.ReverseProxy`로 그 호스트에 넘긴다. 알림은 허브가 그 호스트에 Web Push 구독 하나를 두고 `/api/relay/<비밀>`로 받아 풀어, 주소를 `#/h/<ID>/…`로 바꿔 허브의 구독으로 다시 보낸다. 새 패키지 `internal/peer`가 연결·중계 구독·대상 조회를, `internal/server`가 프록시·중계 수신·호스트 API를 맡는다.

**Tech Stack:** Go 1.26 표준 라이브러리(`net/http/httputil`, `crypto/ecdh`, `crypto/hkdf`, `crypto/aes`, `crypto/cipher`), 기존 `github.com/coder/websocket`·`github.com/SherClockHolmes/webpush-go`(테스트의 중계 송신). 웹은 기존 Preact·TypeScript·Vite.

**Spec:** `docs/superpowers/specs/2026-11-08-mori-design.md` (§3 결정 158~171, §6.9~6.11, §7, §8, §9, §10, §12 단계 11, §13)

## Global Constraints

- 모듈 `github.com/kwonikhyeon/mori`, `go 1.26.5`, toolchain `go1.26.10`. 새 외부 의존성은 넣지 않는다.
- 오류 본문은 `{"error":{"kind","message","hint?"}}`다(§7.4). 새 종류는 `host_unlinked`(409), `host_unreachable`(502).
- 허브가 거절하는 WS 종료 코드: 4401(페어링 안 된 기기, 끊긴 호스트), 4404(없는 호스트), 4502(닿지 않는 호스트), 1001(서버 종료 중). 기기 철회와 서버 종료로 중계 소켓을 끊을 때는 종료 코드 없이 끊는다. 종료 이유는 123바이트를 넘지 않는다.
- 허브가 호스트에 보내는 요청은 `Origin: <그 호스트 주소>`, `User-Agent: mori-hub/<버전>`을 단다. 리디렉션은 따르지 않는다. 연결 한 번은 30초 안에 끝낸다. 접속·TLS는 5초, 응답 시간 제한은 없다(interrupt가 60초까지 기다린다). HTTP/1.1만 쓴다.
- 본문 상한: 프록시 10 MiB(`maxUpload` 8 MiB + 2 MiB), 중계 수신 8 KiB.
- 호스트 뷰는 `{id, name, url, linked, version, relay, relay_error?, linked_ms?}`다. 토큰·키·비밀은 어떤 응답·로그에도 나가지 않는다.
- 프록시 허용 목록 밖은 404 `not_found`다. 중계 비밀 경로(`/api/relay/<비밀>`)는 로그에 남기지 않는다.
- 사용자에게 보이는 글은 한국어, 식별자·로그 메시지는 영어다. 주소·이름 뒤에는 조사를 붙이지 않는다("에"만 쓴다).
- 공개 저장소다. 테스트·문서의 주소는 `example.ts.net`(기존 `desk.example.ts.net`·`lab.example.ts.net`, 새로 쓰면 `macmini.example.ts.net`)만 쓴다. 커밋 전에 스테이징한 diff를 비밀 패턴으로 훑는다. 중계 코드에는 `secret`·`token`이 정당하게 나오므로 걸린 줄을 하나씩 본다.
- `hc`는 격리 환경에서만 실행한다(`HC_SESSION=mori-test-<id>`, `XDG_*`, `HC_SOCKET`을 `.dev/test/<id>` 아래로). 끝나면 `make test-clean`.
- 커밋 메시지는 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`로 끝낸다. 태스크마다 커밋하고 푸시한다.

## Review Focus

1. **말없이 사라진 폰, 터널 중간에 끊는 호스트.** 폰이 연결을 열어 둔 채 응답하지 않거나 호스트가 먼저 닫으면, 허브의 터널과 고루틴이 풀리고 기기 소켓 목록이 빈다 → Task 5에 `TestTunnelEndsWhenHostCloses`.
2. **`/`가 든 터미널 주소.** `machine%2Ft7` 같은 주소가 허브를 지나도 `%2F` 그대로 호스트에 닿는다 → Task 5 `TestProxyForwardsWithHubCookie`.
3. **8 MB 파일 올리기.** 허브를 지나는 8 MB 업로드는 통과한다. 길이를 밝힌 10 MiB 넘는 본문은 호스트에 닿기 전에, 길이를 모르는 본문은 10 MiB에서 끊겨 413이다 → Task 5 `TestProxyBodyLimit`.
4. **호스트가 허브를 철회.** 그 호스트의 401이 폰의 로그아웃으로 보이지 않는다: 허브는 409 `host_unlinked`로 답하고 그 호스트를 `linked:false`로 둔다. 폰의 허브 페어링은 그대로다 → Task 5 `TestProxyHostErrors`, Task 6 `TestHubRelaysHostNotifications`.
5. **`kind`가 없는 옛 Mori.** 중계받은 알림에 `kind`가 없으면 제목 끝 ` · <라벨>`로 종류를 읽는다 → Task 2 `TestRelayed`.

---

## 파일 구조

```
internal/store/state.go, store.go        Host.ID·Link·Relay, Hosts(), 옛 호스트에 ID — Task 1
internal/push/push.go                    Payload.Kind, Forward, send — Task 2
internal/push/relay.go                   Decrypt(RFC 8291), Relayed — Task 2
internal/peer/peer.go                    Manager(Link, Unlink, Rename, SetupRelay, Target, Relay, MarkUnlinked, Lookup, Views), ParseTarget — Task 3
internal/server/api_hosts.go             /api/hosts — Task 4
internal/server/api_proxy.go             /h/{host}/… 역방향 프록시, 터널 — Task 5
internal/server/api_relay.go             POST /api/relay/{secret} — Task 6
internal/server/{server,errors,middleware,api_settings,api_terminals}.go   경로, 오류 종류, isWS, 옛 호스트 API 제거 — Task 4·5
internal/admin/admin.go                  hosts, link_host, unlink_host — Task 7
cmd/mori/hostscmd.go, main.go, serve.go  mori hosts, 조립 — Task 7
web/src/lib/{types,api}.ts, web/src/views/SettingsEdit.tsx, web/test/fixtures.ts   호스트 뷰 타입, 읽기 전용 카드(임시) — Task 4
web/vite.config.ts, README.md, 스펙      /h/ 개발 프록시, 허브 안내, 스펙 반영 — Task 8
web/src/…                                여러 호스트 화면 — Task 10(Task 9의 선택 뒤)
```

## 실행 방식

사용자 지시로 승인 대기 없이 바로 실행한다(2026-11-10). 이 세션에서 직접 구현한다(Native, `superpowers:executing-plans`). 각 태스크는 실패하는 테스트 → 구현 → 통과 → 커밋 순서다. 태스크가 끝날 때마다 푸시한다. Task 9(UI 후보)에서 사용자의 선택을 기다리고, Task 10은 그 선택을 받은 뒤 이 계획에 자세히 적는다.

Go 테스트는 저장소 루트에서 `go test ./...`, 웹은 `web/`에서 `npm test`와 `npm run build`(`tsc --noEmit && vite build`)다.

---

### Task 1: 호스트의 ID와 연결 정보 (단계 11)

**Files:**
- Modify: `internal/store/state.go:33-37` (Host), `internal/store/state.go:102-132` (normalize)
- Modify: `internal/store/store.go` (Open의 끝, `Hosts()` 추가, `slices` import)
- Test: `internal/store/store_test.go`

**Interfaces:**
- Produces:

```go
// Host is another machine's Mori that this hub links to (spec §3 #158~#168).
// ID never changes, even when the host is linked again.
type Host struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	URL  string   `json:"url"` // the host's origin
	Link HostLink `json:"link,omitzero"`
}

// HostLink is the hub's pairing with the host. An empty Token means not linked.
type HostLink struct {
	Token    string `json:"token"`
	Version  string `json:"version"` // the host's Mori version when linked
	LinkedMs int64  `json:"linked_ms"`
	Relay    Relay  `json:"relay,omitzero"`
}

// Relay is the push subscription the hub holds on the host (spec §3 #165): the host
// sends its notifications to <Base>/api/relay/<Secret>, encrypted to Key and Auth.
type Relay struct {
	Secret string `json:"secret"`
	Key    string `json:"key"`  // P-256 private key, base64url without padding
	Auth   string `json:"auth"` // 16-byte auth secret, base64url without padding
	Base   string `json:"base"` // the hub public URL the endpoint was made from
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
}

func (s *Store) Hosts() []Host // a copy; every host has an ID
```

`normalize`가 ID 없는 호스트에 `NewID("h_")`를 준다. `Update`도 `normalize`를 거치므로 새 호스트를 ID 없이 넣어도 ID가 생긴다.

- [ ] **Step 1: 실패하는 테스트**

`internal/store/store_test.go` 끝에 더한다.

```go
func TestOldHostsGetIDs(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state.json")
	old := `{"version":1,"hosts":[{"name":"desk","url":"https://desk.example.ts.net"},{"name":"lab","url":"https://lab.example.ts.net"}]}`
	if err := os.WriteFile(p, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	hs := s.Hosts()
	if len(hs) != 2 || !strings.HasPrefix(hs[0].ID, "h_") || hs[0].ID == hs[1].ID || hs[0].Link.Token != "" {
		t.Fatalf("%+v", hs)
	}
	again, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.Hosts(); got[0].ID != hs[0].ID || got[1].ID != hs[1].ID {
		t.Fatalf("IDs changed on reopen: %+v then %+v", hs, got)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), `"link"`) {
		t.Fatalf("an unlinked host wrote its link: %s", b)
	}
}

func TestHostsIsACopy(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Update(func(st *State) error {
		st.Hosts = append(st.Hosts, Host{Name: "desk", URL: "https://desk.example.ts.net"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	hs := s.Hosts()
	if len(hs) != 1 || !strings.HasPrefix(hs[0].ID, "h_") {
		t.Fatalf("%+v", hs)
	}
	id := hs[0].ID
	hs[0].Name = "changed"
	if s.Hosts()[0].Name != "desk" {
		t.Fatal("Hosts shares its slice with the store")
	}
	if err := s.Update(func(st *State) error { st.Hosts[0].Name = "desk2"; return nil }); err != nil {
		t.Fatal(err)
	}
	if h := s.Hosts()[0]; h.ID != id || h.Name != "desk2" {
		t.Fatalf("%+v", h)
	}
}
```

- [ ] **Step 2: 실패 확인**

Run: `go test ./internal/store -run 'TestOldHostsGetIDs|TestHostsIsACopy'`
Expected: FAIL — `hs[0].ID undefined`, `s.Hosts undefined`로 컴파일되지 않는다.

- [ ] **Step 3: 구현**

`internal/store/state.go`의 `Host`(33~37행)를 위 Interfaces의 `Host`·`HostLink`·`Relay` 세 타입으로 바꾼다. `normalize`의 `st.Hosts == nil` 블록 바로 뒤에 더한다.

```go
	for i := range st.Hosts {
		if st.Hosts[i].ID == "" {
			st.Hosts[i].ID = NewID("h_")
		}
	}
```

`internal/store/store.go`의 import에 `"slices"`를 넣고, `Open`의 마지막 두 줄 `s.cur = normalize(st)` / `return s, nil`을 바꾼다.

```go
	needIDs := slices.ContainsFunc(st.Hosts, func(h Host) bool { return h.ID == "" })
	s.cur = normalize(st)
	if needIDs {
		return s, writeAtomic(path, s.cur) // hosts from before IDs keep the ID they get now
	}
	return s, nil
```

`Folders()` 아래에 더한다.

```go
// Hosts returns a copy of the linked hosts, cheaper than Get.
func (s *Store) Hosts() []Host {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Host{}, s.cur.Hosts...)
}
```

`Host`에는 값 타입만 있어 얕은 복사로 충분하다. `clone`(JSON 왕복)은 `omitzero`로 빠진 `link`를 영값으로 되살린다.

- [ ] **Step 4: 통과 확인**

Run: `go test ./internal/store && go test ./...`
Expected: PASS. 서버의 `handlePutHosts`·`handleGetHosts`는 아직 `st.Hosts`를 그대로 쓰지만(Task 4에서 바꾼다) 이 사이에는 아무것도 토큰을 넣지 않는다.

- [ ] **Step 5: 커밋**

```bash
git add internal/store/state.go internal/store/store.go internal/store/store_test.go
git commit -m "feat(store): 호스트에 ID와 연결 정보를 둔다

허브가 이은 호스트를 ID로 찾고, 그 호스트에서 받은 기기 토큰과 알림 중계 키를 둔다(결정 158, 165, 168).

- Host에 ID와 Link(토큰, 버전, 연결 시각, Relay)를 더했다
- ID가 없는 옛 호스트는 열 때 ID를 받고 바로 저장한다
- Store.Hosts()

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 2: 다른 호스트의 알림 풀기와 다시 보내기 (단계 11)

**Files:**
- Modify: `internal/push/push.go` (Payload, OnChange, payloadFor, Forward·send 추가)
- Create: `internal/push/relay.go`
- Test: `internal/push/relay_test.go`(새로), `internal/push/push_test.go`, `internal/push/webpush_test.go`

**Interfaces:**
- Consumes: 기존 `push.Kind`, `push.Kinds`, `Kind.Label()`, `Notifier.deliver`, `wants`
- Produces:

```go
type Payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Tag   string `json:"tag"`
	URL   string `json:"url"`
	Kind  string `json:"kind,omitempty"` // what it is about; a hub that relays it reads this (spec §3 #167)
}

// Forward sends p to the subscriptions that want k, without focus or window checks.
func (n *Notifier) Forward(k Kind, p Payload)

// Decrypt opens a Web Push message body (RFC 8291, aes128gcm, one record).
func Decrypt(body []byte, priv *ecdh.PrivateKey, authSecret []byte) ([]byte, error)

// Relayed rewrites a notification the host hostID sent into one of this hub's.
func Relayed(hostID string, p Payload) (Payload, Kind, bool)
```

- [ ] **Step 1: 실패하는 테스트**

`internal/push/relay_test.go`(새 파일):

```go
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
```

`"already relayed"`는 허브가 제 자신을 이었을 때 한 번 돌고 멈추는 것을 보인다: 한 번 지난 알림의 주소는 `/#/h/…`라 다시 보내지 않는다.

`internal/push/push_test.go`의 `TestNotifierSendsPayload`에서 `want`에 `Kind: "blocked"`를 더하고, 파일 끝에 더한다.

```go
func TestForward(t *testing.T) {
	e := newEnv(t)
	e.subscribe(t, "d1", "https://push.example.com/d1")
	e.subscribe(t, "d2", "https://push.example.com/d2", push.KindExited)
	p := push.Payload{Title: "desk · 종료", Body: "claude", Tag: "h_abc/t1", URL: "/#/h/h_abc/t/t1", Kind: "exited"}
	e.focus("t1", true)             // Forward does not ask about focus
	e.n.Forward(push.KindExited, p)
	e.n.Forward(push.KindExited, p) // nor about the window
	e.n.Wait()
	got := e.sender.take()
	if len(got) != 2 {
		t.Fatalf("sent %d: %+v", len(got), got)
	}
	for _, m := range got {
		if m.Endpoint != "https://push.example.com/d2" || m.Payload != p {
			t.Fatalf("%+v", m)
		}
	}
}
```

`internal/push/webpush_test.go`의 `TestWebPushSend`에서 82~84행

```go
	if got := decrypt(t, req.body, ua, secret); !bytes.Equal(got, payload) {
		t.Errorf("decrypted %q, want %q", got, payload)
	}
```

을 바꿔, 새 `Decrypt`가 webpush-go의 실제 출력을 풀고 틀린 입력을 거절하는지 본다.

```go
	got, err := Decrypt(req.body, ua, secret)
	if err != nil || !bytes.Equal(got, payload) {
		t.Errorf("Decrypt = %q, %v; want %q", got, err, payload)
	}
	other, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	bad := bytes.Clone(req.body)
	bad[len(bad)-1] ^= 1
	for name, try := range map[string]func() ([]byte, error){
		"short":        func() ([]byte, error) { return Decrypt(req.body[:20], ua, secret) },
		"another key":  func() ([]byte, error) { return Decrypt(req.body, other, secret) },
		"another auth": func() ([]byte, error) { return Decrypt(req.body, ua, make([]byte, 16)) },
		"tampered":     func() ([]byte, error) { return Decrypt(bad, ua, secret) },
		"cut":          func() ([]byte, error) { return Decrypt(req.body[:len(req.body)-1], ua, secret) },
	} {
		if b, err := try(); err == nil {
			t.Errorf("%s: Decrypt = %q, want an error", name, b)
		}
	}
```

이 파일의 `decrypt` 도우미(164~210행)는 지운다. 그러면 import의 `crypto/aes`, `crypto/cipher`, `crypto/hkdf`, `encoding/binary`가 쓰이지 않으니 함께 지운다(`bytes`·`crypto/sha256`은 남는다).

- [ ] **Step 2: 실패 확인**

Run: `go test ./internal/push`
Expected: FAIL — `undefined: push.Relayed`, `e.n.Forward undefined`, `undefined: Decrypt`, `unknown field Kind`.

- [ ] **Step 3: 구현**

`internal/push/push.go`:

`Payload`에 필드를 더한다.

```go
	Kind  string `json:"kind,omitempty"` // what it is about; a hub that relays it reads this (spec §3 #167)
```

`payloadFor`의 반환값에 `Kind: string(k),`를 더한다.

`OnChange`의 끝 반복문

```go
	for _, s := range n.o.Store.Get().PushSubs {
		if wants(s, kind) {
			n.wg.Go(func() { n.deliver(context.Background(), s, body) })
		}
	}
```

을 `n.send(kind, body)`로 바꾸고, `Wait` 위에 더한다.

```go
// Forward sends p, a notification another host sent this hub, to the
// subscriptions that want k (spec §3 #166). The other host has already
// decided and checked focus, so nothing is held back here.
func (n *Notifier) Forward(k Kind, p Payload) {
	body, err := json.Marshal(p)
	if err != nil {
		n.o.Logger.Error("encoding a notification", "err", err)
		return
	}
	n.send(k, body)
}

// send delivers body in the background to every subscription that wants k.
func (n *Notifier) send(k Kind, body []byte) {
	for _, s := range n.o.Store.Get().PushSubs {
		if wants(s, k) {
			n.wg.Go(func() { n.deliver(context.Background(), s, body) })
		}
	}
}
```

`internal/push/relay.go`(새 파일). 이 패키지에는 이미 `enc`가 있으니 새로 만들지 않는다.

```go
package push

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"net/url"
	"slices"
	"strings"
)

var errUndecryptable = errors.New("not a message for this key")

// Decrypt opens a Web Push message body (RFC 8291, aes128gcm in one
// record, RFC 8188) sent to the subscription with priv and authSecret.
func Decrypt(body []byte, priv *ecdh.PrivateKey, authSecret []byte) ([]byte, error) {
	if len(body) < 21 {
		return nil, errUndecryptable
	}
	salt, rs, idLen := body[:16], binary.BigEndian.Uint32(body[16:20]), int(body[20])
	if len(body) < 21+idLen {
		return nil, errUndecryptable
	}
	keyID, ct := body[21:21+idLen], body[21+idLen:]
	if rs < 18 || len(ct) < 17 || uint32(len(ct)) > rs {
		return nil, errUndecryptable
	}
	pub, err := ecdh.P256().NewPublicKey(keyID)
	if err != nil {
		return nil, errUndecryptable
	}
	shared, err := priv.ECDH(pub)
	if err != nil {
		return nil, errUndecryptable
	}
	info := append(append([]byte("WebPush: info\x00"), priv.PublicKey().Bytes()...), keyID...)
	ikm, err := hkdf.Key(sha256.New, shared, authSecret, string(info), 32)
	if err != nil {
		return nil, errUndecryptable
	}
	cek, err := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, errUndecryptable
	}
	nonce, err := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, errUndecryptable
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, errUndecryptable
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errUndecryptable
	}
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, errUndecryptable
	}
	plain = bytes.TrimRight(plain, "\x00") // the last record ends with 2, then zeros
	if len(plain) == 0 || plain[len(plain)-1] != 2 {
		return nil, errUndecryptable
	}
	return plain[:len(plain)-1], nil
}

// Relayed is p, a notification the host hostID sent, made into one of
// this hub's (spec §3 #166, #167): a tap opens the terminal under that
// host, and the tag keeps hosts apart. ok is false for what is not about a
// terminal (a test notification, one a host relayed from another) and for
// a kind this build does not know.
func Relayed(hostID string, p Payload) (Payload, Kind, bool) {
	rest, ok := strings.CutPrefix(p.URL, "/#/t/")
	if !ok {
		return Payload{}, "", false
	}
	addr, err := url.PathUnescape(rest)
	if err != nil || addr == "" {
		return Payload{}, "", false
	}
	k := Kind(p.Kind)
	if k == "" {
		k = kindFromTitle(p.Title) // a Mori from before #167
	}
	if !slices.Contains(Kinds, k) {
		return Payload{}, "", false
	}
	p.URL = "/#/h/" + hostID + "/t/" + url.PathEscape(addr)
	p.Tag = hostID + "/" + p.Tag
	p.Kind = string(k)
	return p, k, true
}

// kindFromTitle reads the kind from a title "<host> · <label>".
func kindFromTitle(title string) Kind {
	for _, k := range Kinds {
		if strings.HasSuffix(title, " · "+k.Label()) {
			return k
		}
	}
	return ""
}
```

- [ ] **Step 4: 통과 확인**

Run: `go test ./internal/push && go vet ./internal/push && go test ./...`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add internal/push
git commit -m "feat(push): 다른 호스트의 알림을 풀어 다시 보낸다

허브가 다른 호스트에서 받은 Web Push를 풀고, 누르면 허브 화면의 그 호스트 터미널로 가게 바꿔 허브의 구독으로 다시 보낸다(결정 166, 167).

- 알림 본문에 kind를 넣는다
- Decrypt(RFC 8291), Relayed, Notifier.Forward
- kind가 없는 옛 Mori는 제목 끝의 라벨로 종류를 읽는다

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 3: 다른 호스트와 잇기 — `internal/peer` (단계 11)

**Files:**
- Create: `internal/peer/peer.go`
- Test: `internal/peer/peer_test.go` (package `peer_test`)

**Interfaces:**
- Consumes: Task 1의 `store.Host`·`HostLink`·`Relay`, `Store.Hosts()`; `auth.CookieName`
- Produces:

```go
type Error struct{ Kind, Message string } // Kind is a spec §7.4 kind: invalid_params, not_found, rate_limited, host_unlinked, host_unreachable
func (e *Error) Error() string

type Options struct {
	Store     *store.Store
	PublicURL func() string    // the hub's public URL; nil: none
	Listen    string           // the hub's listen address, never linked to
	HostName  string           // the hub pairs as "<HostName> 허브"
	Version   string           // sent as User-Agent mori-hub/<Version>
	TLS       *tls.Config      // nil: the system's roots
	Logger    *slog.Logger     // nil: slog.Default()
	Now       func() time.Time // nil: time.Now
}
func New(o Options) *Manager

type View struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	Linked     bool   `json:"linked"`
	Version    string `json:"version"`
	Relay      bool   `json:"relay"`
	RelayError string `json:"relay_error,omitempty"`
	LinkedMs   int64  `json:"linked_ms,omitempty"`
}
func Views(hs []store.Host, pub string) []View // pub "": a changed public URL is not checked

type Target struct {
	ID, Name string
	Base     *url.URL // the host's origin
	Token    string   // "" when the hub is not linked
}

func ParseTarget(raw string) (origin, code string, err error)

func (m *Manager) Link(ctx context.Context, rawURL, code, name string) (v View, created bool, err error)
func (m *Manager) Unlink(ctx context.Context, id string) (View, error)
func (m *Manager) Rename(id, name string) (View, error)
func (m *Manager) SetupRelay(ctx context.Context, id string) (View, error)
func (m *Manager) Views() []View
func (m *Manager) Lookup(idOrName string) (View, error)
func (m *Manager) Target(id string) (Target, bool)
func (m *Manager) Relay(secret string) (id string, key *ecdh.PrivateKey, authSecret []byte, ok bool)
func (m *Manager) MarkUnlinked(id, token string)
func (m *Manager) UserAgent() string            // "mori-hub/<Version>"
func (m *Manager) Transport() http.RoundTripper // HTTP/1.1 only, 5 s connect and TLS, no redirects
```

`Link`이 받는 주소는 출처(`scheme://host[:port]`)나 페어링 링크(`<출처>/pair#code=XXXX-XXXX`)다. 같은 출처(대소문자, 끝의 `/`, 기본 포트를 무시)를 다시 이으면 ID와 이름을 두고 토큰만 바꾸며, 옛 토큰은 로그아웃한다. 그 호스트에서 옛 토큰의 기기가 철회되면 그 기기의 중계 구독도 함께 지워진다.

- [ ] **Step 1: 실패하는 테스트**

`internal/peer/peer_test.go`:

```go
package peer_test

import (
	"bytes"
	"cmp"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/peer"
	"github.com/kwonikhyeon/mori/internal/store"
)

// fakeHost is another host's Mori as far as the hub sees it. Change its
// fields with with, so the race detector sees the handlers' reads ordered.
type fakeHost struct {
	srv  *httptest.Server
	code string

	mu        sync.Mutex
	reqs      []*http.Request
	tokens    int
	loggedOut []string
	pairedAs  string
	sub       map[string]any // the last push subscription asked for
	push      *http.Client   // what the host sends its test notification with; nil: it sends none
	hello     string
	subStatus int // the answer to POST /api/push/subscriptions; 0: 201
}

func newFakeHost(t *testing.T, code string) *fakeHost {
	t.Helper()
	f := &fakeHost{code: code, hello: `{"app":"mori","version":"9.9.9","host":"desk","paired":false}`}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/hello", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		f.mu.Lock()
		defer f.mu.Unlock()
		io.WriteString(w, f.hello)
	})
	mux.HandleFunc("POST /api/pair", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		var body struct{ Code, Name string }
		json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		defer f.mu.Unlock()
		if body.Code != f.code {
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":{"kind":"invalid_params","message":"코드가 맞지 않거나 만료되었습니다"}}`)
			return
		}
		f.tokens++
		f.pairedAs = body.Name
		http.SetCookie(w, &http.Cookie{Name: auth.CookieName, Value: fmt.Sprintf("tok-%d", f.tokens), Path: "/", Secure: true, HttpOnly: true})
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/logout", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		c, err := r.Cookie(auth.CookieName)
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		f.with(func() { f.loggedOut = append(f.loggedOut, c.Value) })
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/push/subscriptions", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.sub = body
		status := cmp.Or(f.subStatus, http.StatusCreated)
		f.mu.Unlock()
		w.WriteHeader(status)
		if status != http.StatusCreated {
			io.WriteString(w, `{"error":{"kind":"unavailable","message":"알림이 꺼져 있습니다"}}`)
			return
		}
		io.WriteString(w, `{}`)
	})
	mux.HandleFunc("POST /api/push/test", func(w http.ResponseWriter, r *http.Request) {
		f.record(r)
		f.mu.Lock()
		sub, client := f.sub, f.push
		f.mu.Unlock()
		sent := 0
		if s, ok := sub["subscription"].(map[string]any); ok && client != nil {
			endpoint, _ := s["endpoint"].(string)
			if res, err := client.Post(endpoint, "application/octet-stream", strings.NewReader("ciphertext")); err == nil {
				res.Body.Close()
				if res.StatusCode == http.StatusCreated {
					sent = 1
				}
			}
		}
		fmt.Fprintf(w, `{"sent":%d}`, sent)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeHost) record(r *http.Request) { f.with(func() { f.reqs = append(f.reqs, r) }) }

// with changes or reads the fake under its lock.
func (f *fakeHost) with(fn func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn()
}

func (f *fakeHost) requests() (out []*http.Request) {
	f.with(func() { out = slices.Clone(f.reqs) })
	return out
}

func (f *fakeHost) loggedOutTokens() (out []string) {
	f.with(func() { out = slices.Clone(f.loggedOut) })
	return out
}

func newManager(t *testing.T, o peer.Options) (*peer.Manager, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	o.Store = st
	if o.PublicURL == nil {
		o.PublicURL = func() string { return "http://hub.invalid" }
	}
	o.Listen = cmp.Or(o.Listen, "127.0.0.1:1") // a port httptest never gets
	o.HostName = cmp.Or(o.HostName, "macmini")
	o.Version = cmp.Or(o.Version, "test")
	o.Logger = slog.New(slog.DiscardHandler)
	return peer.New(o), st
}

func addHosts(t *testing.T, st *store.Store, hs ...store.Host) {
	t.Helper()
	if err := st.Update(func(s *store.State) error { s.Hosts = append(s.Hosts, hs...); return nil }); err != nil {
		t.Fatal(err)
	}
}

func kindOf(err error) string {
	var pe *peer.Error
	if errors.As(err, &pe) {
		return pe.Kind
	}
	return ""
}

func TestParseTarget(t *testing.T) {
	for _, tc := range []struct {
		in, origin, code string
		ok               bool
	}{
		{"https://desk.example.ts.net", "https://desk.example.ts.net", "", true},
		{"  https://Desk.Example.ts.net/  ", "https://desk.example.ts.net", "", true},
		{"HTTPS://desk.example.ts.net:443", "https://desk.example.ts.net", "", true},
		{"http://127.0.0.1:80", "http://127.0.0.1", "", true},
		{"http://127.0.0.1:7761", "http://127.0.0.1:7761", "", true},
		{"https://[::1]:443/", "https://[::1]", "", true},
		{"https://desk.example.ts.net/#/t/t1", "https://desk.example.ts.net", "", true}, // copied from the address bar
		{"https://desk.example.ts.net/pair#code=ABCD-EFGH", "https://desk.example.ts.net", "ABCD-EFGH", true},
		{"https://desk.example.ts.net/pair", "", "", false},
		{"https://desk.example.ts.net/api", "", "", false},
		{"https://desk.example.ts.net/?a=1", "", "", false},
		{"https://desk.example.ts.net?", "", "", false},
		{"https://user@desk.example.ts.net", "", "", false},
		{"ftp://desk.example.ts.net", "", "", false},
		{"desk.example.ts.net", "", "", false},
		{"https://", "", "", false},
		{"https://:443", "", "", false},
		{"", "", "", false},
	} {
		origin, code, err := peer.ParseTarget(tc.in)
		if (err == nil) != tc.ok || origin != tc.origin || code != tc.code {
			t.Errorf("ParseTarget(%q) = %q, %q, %v; want %q, %q, ok %v", tc.in, origin, code, err, tc.origin, tc.code, tc.ok)
		}
		if err != nil && kindOf(err) != "invalid_params" {
			t.Errorf("ParseTarget(%q): kind %q", tc.in, kindOf(err))
		}
	}
}

func TestLink(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	m, st := newManager(t, peer.Options{})
	v, created, err := m.Link(context.Background(), f.srv.URL, "ABCD-EFGH", "")
	if err != nil || !created {
		t.Fatalf("Link = %+v, %v, %v", v, created, err)
	}
	if !strings.HasPrefix(v.ID, "h_") || v.Name != "desk" || v.URL != f.srv.URL || !v.Linked || v.Version != "9.9.9" || v.LinkedMs == 0 {
		t.Fatalf("view %+v", v)
	}
	if v.Relay || !strings.Contains(v.RelayError, "https") { // the hub here is http://hub.invalid
		t.Fatalf("relay %v %q", v.Relay, v.RelayError)
	}
	if hs := st.Hosts(); len(hs) != 1 || hs[0].ID != v.ID || hs[0].Link.Token != "tok-1" {
		t.Fatalf("stored %+v", hs)
	}
	reqs := f.requests()
	if len(reqs) != 2 || reqs[0].URL.Path != "/api/hello" || reqs[1].URL.Path != "/api/pair" {
		t.Fatalf("%d requests", len(reqs))
	}
	for _, r := range reqs {
		if r.Header.Get("Origin") != f.srv.URL || r.UserAgent() != "mori-hub/test" || r.Header.Get("Cookie") != "" {
			t.Errorf("%s %s: Origin %q, User-Agent %q, Cookie %q", r.Method, r.URL.Path, r.Header.Get("Origin"), r.UserAgent(), r.Header.Get("Cookie"))
		}
	}
	f.with(func() {
		if f.pairedAs != "macmini 허브" {
			t.Errorf("paired as %q", f.pairedAs)
		}
	})
	// A pairing link carries its code; a name given wins over the host's.
	f2 := newFakeHost(t, "WXYZ-WXYZ")
	v2, created, err := m.Link(context.Background(), f2.srv.URL+"/pair#code=WXYZ-WXYZ", "", " 연구실 ")
	if err != nil || !created || v2.Name != "연구실" || v2.ID == v.ID {
		t.Fatalf("Link with a pairing link = %+v, %v, %v", v2, created, err)
	}
}

func TestLinkErrors(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	m, st := newManager(t, peer.Options{PublicURL: func() string { return "https://macmini.example.ts.net" }})
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	notMori := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"app":"other"}`) }))
	t.Cleanup(notMori.Close)
	noHello := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(noHello.Close)
	limited := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/hello" {
			io.WriteString(w, `{"app":"mori","version":"9.9.9","host":"desk"}`)
			return
		}
		w.WriteHeader(http.StatusTooManyRequests)
		io.WriteString(w, `{"error":{"kind":"rate_limited","message":"실패가 너무 많습니다. 10분 뒤에 다시 시도하세요"}}`)
	}))
	t.Cleanup(limited.Close)
	for _, tc := range []struct{ name, url, code, as, kind, msg string }{
		{"wrong code", f.srv.URL, "WXYZ-WXYZ", "", "invalid_params", "코드가 맞지 않거나"},
		{"no code", f.srv.URL, "", "", "invalid_params", "mori pair"},
		{"a long name", f.srv.URL, "ABCD-EFGH", strings.Repeat("가", 101), "invalid_params", "1~100자"},
		{"not Mori", notMori.URL, "ABCD-EFGH", "", "invalid_params", "Mori가 아닙니다"},
		{"no hello", noHello.URL, "ABCD-EFGH", "", "invalid_params", "Mori가 아닙니다"},
		{"unreachable", closed.URL, "ABCD-EFGH", "", "host_unreachable", "닿지 못했습니다"},
		{"too many tries", limited.URL, "ABCD-EFGH", "", "rate_limited", "10분 뒤에"},
		{"its listen address", "http://127.0.0.1:1", "ABCD-EFGH", "", "invalid_params", "자신"},
		{"localhost", "http://localhost:1", "ABCD-EFGH", "", "invalid_params", "자신"},
		{"its public URL", "https://MACMINI.example.ts.net:443/", "ABCD-EFGH", "", "invalid_params", "자신"},
		{"a path", f.srv.URL + "/api", "ABCD-EFGH", "", "invalid_params", "https://호스트"},
	} {
		_, _, err := m.Link(context.Background(), tc.url, tc.code, tc.as)
		if kindOf(err) != tc.kind || !strings.Contains(fmt.Sprint(err), tc.msg) {
			t.Errorf("%s: %v (kind %q), want %s with %q", tc.name, err, kindOf(err), tc.kind, tc.msg)
		}
	}
	if hs := st.Hosts(); len(hs) != 0 {
		t.Fatalf("a failed link was kept: %+v", hs)
	}
	if n := len(f.requests()); n != 2 { // the wrong code's hello and pair; the rest stop before asking
		t.Errorf("the host got %d requests", n)
	}
}

func TestRelink(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	m, st := newManager(t, peer.Options{})
	ctx := context.Background()
	first, _, err := m.Link(ctx, f.srv.URL, "ABCD-EFGH", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Rename(first.ID, "책상"); err != nil {
		t.Fatal(err)
	}
	again, created, err := m.Link(ctx, strings.ToUpper(f.srv.URL)+"/", "ABCD-EFGH", "")
	if err != nil || created || again.ID != first.ID || again.Name != "책상" {
		t.Fatalf("relink = %+v, created %v, %v", again, created, err)
	}
	if hs := st.Hosts(); len(hs) != 1 || hs[0].Link.Token != "tok-2" || hs[0].URL != f.srv.URL {
		t.Fatalf("stored %+v", hs)
	}
	if lo := f.loggedOutTokens(); !slices.Equal(lo, []string{"tok-1"}) {
		t.Fatalf("logged out %v, want the old token", lo)
	}
	third, created, err := m.Link(ctx, f.srv.URL, "ABCD-EFGH", "새 이름")
	if err != nil || created || third.ID != first.ID || third.Name != "새 이름" {
		t.Fatalf("relink with a name = %+v, %v, %v", third, created, err)
	}
}

func TestUnlink(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	m, st := newManager(t, peer.Options{})
	ctx := context.Background()
	v, _, err := m.Link(ctx, f.srv.URL, "ABCD-EFGH", "")
	if err != nil {
		t.Fatal(err)
	}
	gone, err := m.Unlink(ctx, v.ID)
	if err != nil || gone.ID != v.ID || gone.Name != "desk" {
		t.Fatalf("Unlink = %+v, %v", gone, err)
	}
	if len(st.Hosts()) != 0 || !slices.Equal(f.loggedOutTokens(), []string{"tok-1"}) {
		t.Fatalf("hosts %+v, logged out %v", st.Hosts(), f.loggedOutTokens())
	}
	if _, err := m.Unlink(ctx, v.ID); kindOf(err) != "not_found" {
		t.Errorf("Unlink again: %v", err)
	}
	// A host that cannot be reached is forgotten all the same.
	v2, _, err := m.Link(ctx, f.srv.URL, "ABCD-EFGH", "")
	if err != nil {
		t.Fatal(err)
	}
	f.srv.Close()
	if _, err := m.Unlink(ctx, v2.ID); err != nil || len(st.Hosts()) != 0 {
		t.Fatalf("Unlink of an unreachable host: %v, %+v", err, st.Hosts())
	}
}

func TestRename(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	m, _ := newManager(t, peer.Options{})
	v, _, err := m.Link(context.Background(), f.srv.URL, "ABCD-EFGH", "")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := m.Rename(v.ID, "  책상\t컴퓨터\n"); err != nil || got.Name != "책상 컴퓨터" || got.ID != v.ID || !got.Linked {
		t.Fatalf("Rename = %+v, %v", got, err)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("가", 101)} {
		if _, err := m.Rename(v.ID, bad); kindOf(err) != "invalid_params" {
			t.Errorf("Rename(%q): %v", bad, err)
		}
	}
	if _, err := m.Rename("h_nope0000", "x"); kindOf(err) != "not_found" {
		t.Errorf("Rename of no host: %v", err)
	}
	if got := m.Views(); len(got) != 1 || got[0].Name != "책상 컴퓨터" {
		t.Fatalf("Views %+v", got)
	}
}

func TestSetupRelay(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	// The hub's public side, started after the manager exists.
	receiver := httptest.NewUnstartedServer(nil)
	pub := "https://" + receiver.Listener.Addr().String()
	m, st := newManager(t, peer.Options{PublicURL: func() string { return pub }})
	var mu sync.Mutex
	var hits []string // host IDs the host's test notifications found
	receiver.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secret, _ := strings.CutPrefix(r.URL.Path, "/api/relay/")
		id, key, authSecret, ok := m.Relay(secret)
		if !ok {
			w.WriteHeader(http.StatusGone)
			return
		}
		var keys map[string]any
		f.with(func() { keys, _ = f.sub["subscription"].(map[string]any)["keys"].(map[string]any) })
		enc := base64.RawURLEncoding
		if keys["p256dh"] != enc.EncodeToString(key.PublicKey().Bytes()) || keys["auth"] != enc.EncodeToString(authSecret) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		hits = append(hits, id)
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	})
	receiver.StartTLS()
	t.Cleanup(receiver.Close)
	f.with(func() { f.push = receiver.Client() })

	ctx := context.Background()
	v, _, err := m.Link(ctx, f.srv.URL, "ABCD-EFGH", "")
	if err != nil || !v.Relay || v.RelayError != "" {
		t.Fatalf("Link = %+v, %v", v, err)
	}
	mu.Lock()
	if !slices.Equal(hits, []string{v.ID}) {
		t.Fatalf("test notifications reached %v", hits)
	}
	mu.Unlock()
	var sub map[string]any
	f.with(func() { sub = f.sub })
	endpoint, _ := sub["subscription"].(map[string]any)["endpoint"].(string)
	secret, ok := strings.CutPrefix(endpoint, pub+"/api/relay/")
	if !ok || len(secret) != 43 { // 32 random bytes, base64url
		t.Fatalf("endpoint %q", endpoint)
	}
	if got := fmt.Sprint(sub["kinds"]); got != "[blocked waiting error exited]" {
		t.Errorf("kinds %s", got)
	}
	r := st.Hosts()[0].Link.Relay
	if !r.OK || r.Secret != secret || r.Base != pub || r.Error != "" {
		t.Fatalf("stored relay %+v", r)
	}
	for _, req := range f.requests()[2:] { // subscribe and test go with the hub's token
		if c, err := req.Cookie(auth.CookieName); err != nil || c.Value != "tok-1" || req.Header.Get("Origin") != f.srv.URL {
			t.Errorf("%s %s without the hub's token or Origin", req.Method, req.URL.Path)
		}
	}
	// Setting it up again makes a new key and secret; the old secret finds nothing.
	again, err := m.SetupRelay(ctx, v.ID)
	if err != nil || !again.Relay {
		t.Fatalf("SetupRelay = %+v, %v", again, err)
	}
	if r2 := st.Hosts()[0].Link.Relay; r2.Secret == r.Secret || r2.Key == r.Key || r2.Auth == r.Auth {
		t.Fatalf("SetupRelay kept the old keys")
	}
	if _, _, _, ok := m.Relay(r.Secret); ok {
		t.Error("the old secret still finds the host")
	}
	if _, err := m.SetupRelay(ctx, "h_nope0000"); kindOf(err) != "not_found" {
		t.Errorf("SetupRelay of no host: %v", err)
	}
}

func TestRelayFailureKept(t *testing.T) {
	f := newFakeHost(t, "ABCD-EFGH")
	f.with(func() { f.subStatus = http.StatusServiceUnavailable })
	m, st := newManager(t, peer.Options{PublicURL: func() string { return "https://macmini.example.ts.net" }})
	ctx := context.Background()
	v, created, err := m.Link(ctx, f.srv.URL, "ABCD-EFGH", "")
	if err != nil || !created || !v.Linked || v.Relay || !strings.Contains(v.RelayError, "알림 중계를 받지 않았습니다: 알림이 꺼져 있습니다") {
		t.Fatalf("Link = %+v, %v", v, err)
	}
	if r := st.Hosts()[0].Link.Relay; r.OK || r.Secret == "" || r.Error == "" {
		t.Fatalf("stored relay %+v", r)
	}
	// The host takes the subscription, but its test notification never comes back.
	f.with(func() { f.subStatus = 0 })
	v, err = m.SetupRelay(ctx, v.ID)
	if err != nil || v.Relay || !strings.Contains(v.RelayError, "시험 알림이 허브에 오지 않았습니다") {
		t.Fatalf("SetupRelay = %+v, %v", v, err)
	}
}

func TestRelayBaseChanged(t *testing.T) {
	var mu sync.Mutex
	pub := "https://macmini.example.ts.net"
	now := time.UnixMilli(1_700_000_000_000)
	m, st := newManager(t, peer.Options{
		PublicURL: func() string { mu.Lock(); defer mu.Unlock(); return pub },
		Now:       func() time.Time { mu.Lock(); defer mu.Unlock(); return now },
	})
	addHosts(t, st, store.Host{ID: "h_desk0001", Name: "desk", URL: "https://desk.example.ts.net", Link: store.HostLink{Token: "tok", Version: "9.9.9",
		Relay: store.Relay{Secret: "s", Key: "k", Auth: "a", Base: "https://macmini.example.ts.net", OK: true}}})
	if v := m.Views()[0]; !v.Relay || v.RelayError != "" {
		t.Fatalf("%+v", v)
	}
	mu.Lock()
	pub = "https://mini.example.ts.net/"
	mu.Unlock()
	if v := m.Views()[0]; !v.Relay {
		t.Fatalf("read the public URL again within a minute: %+v", v)
	}
	mu.Lock()
	now = now.Add(time.Minute + time.Second)
	mu.Unlock()
	if v := m.Views()[0]; v.Relay || !strings.Contains(v.RelayError, "허브 주소가 바뀌었습니다") {
		t.Fatalf("%+v", v)
	}
}

func TestViewsHideSecrets(t *testing.T) {
	hs := []store.Host{
		{ID: "h_1", Name: "desk", URL: "https://desk.example.ts.net", Link: store.HostLink{Token: "tok-secret", Version: "9.9.9", LinkedMs: 5,
			Relay: store.Relay{Secret: "relay-secret", Key: "relay-key", Auth: "relay-auth", Base: "https://macmini.example.ts.net", OK: true}}},
		{ID: "h_2", Name: "lab", URL: "https://lab.example.ts.net"},
	}
	b, err := json.Marshal(peer.Views(hs, "https://macmini.example.ts.net"))
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"id":"h_1","name":"desk","url":"https://desk.example.ts.net","linked":true,"version":"9.9.9","relay":true,"linked_ms":5},` +
		`{"id":"h_2","name":"lab","url":"https://lab.example.ts.net","linked":false,"version":"","relay":false}]`
	if string(b) != want {
		t.Fatalf("%s\nwant %s", b, want)
	}
	if got := peer.Views(nil, ""); got == nil || len(got) != 0 {
		t.Fatalf("%#v", got)
	}
}

func TestRelayLookup(t *testing.T) {
	m, st := newManager(t, peer.Options{})
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	authSecret := make([]byte, 16)
	rand.Read(authSecret)
	enc := base64.RawURLEncoding
	addHosts(t, st,
		store.Host{ID: "h_desk0001", Name: "desk", URL: "https://desk.example.ts.net", Link: store.HostLink{Token: "tok",
			Relay: store.Relay{Secret: "s3cr3t", Key: enc.EncodeToString(key.Bytes()), Auth: enc.EncodeToString(authSecret), Base: "https://macmini.example.ts.net"}}},
		store.Host{ID: "h_lab00001", Name: "lab", URL: "https://lab.example.ts.net", Link: store.HostLink{Relay: store.Relay{Secret: "unlinked"}}})
	id, k, a, ok := m.Relay("s3cr3t") // OK is still false: it answers while the relay is set up
	if !ok || id != "h_desk0001" || !bytes.Equal(k.Bytes(), key.Bytes()) || !bytes.Equal(a, authSecret) {
		t.Fatalf("Relay = %q, %v", id, ok)
	}
	for _, s := range []string{"", "s3cr3", "s3cr3tt", "unlinked"} {
		if _, _, _, ok := m.Relay(s); ok {
			t.Errorf("Relay(%q) found a host", s)
		}
	}
}

func TestLookup(t *testing.T) {
	m, st := newManager(t, peer.Options{})
	addHosts(t, st,
		store.Host{ID: "h_1", Name: "desk", URL: "https://desk.example.ts.net"},
		store.Host{ID: "h_2", Name: "lab", URL: "https://lab.example.ts.net"},
		store.Host{ID: "h_3", Name: "lab", URL: "https://lab2.example.ts.net"},
		store.Host{ID: "h_4", Name: "h_1", URL: "https://odd.example.ts.net"})
	if v, err := m.Lookup("h_1"); err != nil || v.Name != "desk" { // an ID wins over a name
		t.Errorf("Lookup(h_1) = %+v, %v", v, err)
	}
	if v, err := m.Lookup("desk"); err != nil || v.ID != "h_1" {
		t.Errorf("Lookup(desk) = %+v, %v", v, err)
	}
	if _, err := m.Lookup("lab"); kindOf(err) != "invalid_params" || !strings.Contains(err.Error(), "h_2, h_3") {
		t.Errorf("Lookup(lab): %v", err)
	}
	if _, err := m.Lookup("nope"); kindOf(err) != "not_found" || !strings.Contains(err.Error(), "mori hosts") {
		t.Errorf("Lookup(nope): %v", err)
	}
}

func TestMarkUnlinked(t *testing.T) {
	m, st := newManager(t, peer.Options{})
	addHosts(t, st, store.Host{ID: "h_desk0001", Name: "desk", URL: "https://desk.example.ts.net", Link: store.HostLink{Token: "new", Version: "9.9.9"}})
	m.MarkUnlinked("h_desk0001", "old") // a newer link replaced the token the host refused
	if st.Hosts()[0].Link.Token != "new" {
		t.Fatal("forgot a newer token")
	}
	m.MarkUnlinked("h_desk0001", "new")
	if h := st.Hosts()[0]; h.Link != (store.HostLink{}) || h.Name != "desk" {
		t.Fatalf("%+v", h)
	}
	m.MarkUnlinked("h_nope0000", "new") // no such host: nothing happens
	if v := m.Views()[0]; v.Linked || v.Version != "" {
		t.Fatalf("%+v", v)
	}
}
```

- [ ] **Step 2: 실패 확인**

Run: `go test ./internal/peer`
Expected: FAIL — `package github.com/kwonikhyeon/mori/internal/peer` 없음.

- [ ] **Step 3: 구현**

`internal/peer/peer.go`:

```go
// Package peer links this Mori, the hub, to other hosts' Mori (spec §3
// #158~#171). It pairs with each host as a device, keeps the token in
// state.json, and holds one push subscription there that sends the host's
// notifications back to the hub.
package peer

import (
	"bytes"
	"cmp"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/store"
)

// Error is a failure the hub's API reports as it is. Kind is an error kind
// of spec §7.4.
type Error struct{ Kind, Message string }

func (e *Error) Error() string { return e.Message }

func errorf(kind, format string, args ...any) *Error {
	return &Error{Kind: kind, Message: fmt.Sprintf(format, args...)}
}

var errNotLinked = &Error{Kind: "host_unlinked", Message: "이 호스트와 연결되어 있지 않습니다. 허브에서 다시 연결하세요"}

// errStale stops a write that a newer link or relay setup has overtaken.
var errStale = errors.New("a newer link or relay setup replaced this one")

var enc = base64.RawURLEncoding

const (
	linkTimeout   = 30 * time.Second // one link or relay setup, spec §3 #159
	dialTimeout   = 5 * time.Second  // connect and TLS, spec §3 #163
	logoutTimeout = 5 * time.Second
	pubTTL        = time.Minute // how long the hub's public URL is kept
	maxBody       = 64 << 10    // what the hub reads of a host's answer
	maxName       = 100
)

// relayKinds are what the relay subscription asks for: every kind, since
// the hub's own subscriptions choose (spec §3 #165). They are the kinds
// every Mori knows, so a host of another version takes them.
var relayKinds = []string{"blocked", "waiting", "error", "exited"}

// Options configures a Manager.
type Options struct {
	Store     *store.Store
	PublicURL func() string    // the hub's public URL; nil: none
	Listen    string           // the hub's listen address, never linked to
	HostName  string           // the hub pairs as "<HostName> 허브"
	Version   string           // sent as User-Agent mori-hub/<Version>
	TLS       *tls.Config      // nil: the system's roots
	Logger    *slog.Logger     // nil: slog.Default()
	Now       func() time.Time // nil: time.Now
}

// Manager links the hub to other hosts and finds them for the proxy and
// the relay.
type Manager struct {
	o      Options
	tr     *http.Transport
	client *http.Client

	mu       sync.Mutex
	pub      string
	pubUntil time.Time
}

// New makes a Manager over o.Store.
func New(o Options) *Manager {
	if o.Store == nil {
		panic("peer: Options.Store is nil")
	}
	if o.PublicURL == nil {
		o.PublicURL = func() string { return "" }
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	tc := &tls.Config{}
	if o.TLS != nil {
		tc = o.TLS.Clone()
	}
	tc.NextProtos = []string{"http/1.1"} // a WebSocket upgrade needs HTTP/1.1
	protos := new(http.Protocols)
	protos.SetHTTP1(true)
	tr := &http.Transport{
		// No Proxy: a host is reached on the tailnet, never through one.
		DialContext:         (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:     tc,
		TLSHandshakeTimeout: dialTimeout,
		Protocols:           protos,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
		// No ResponseHeaderTimeout: an interrupt waits up to 60 s (spec §3 #163).
	}
	return &Manager{o: o, tr: tr, client: &http.Client{
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// UserAgent is what the hub sends to the hosts as User-Agent.
func (m *Manager) UserAgent() string { return "mori-hub/" + m.o.Version }

// Transport is how the hub reaches the hosts, for the proxy.
func (m *Manager) Transport() http.RoundTripper { return m.tr }

// publicURL is the hub's public URL without a trailing slash, read at most
// once a minute. Never call it inside a Store.Update function.
func (m *Manager) publicURL() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if now := m.o.Now(); now.After(m.pubUntil) {
		m.pub, m.pubUntil = strings.TrimRight(m.o.PublicURL(), "/"), now.Add(pubTTL)
	}
	return m.pub
}

// View is what the API shows of a host (spec §3 #168). It never holds the
// token, the keys or the relay secret.
type View struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	Linked     bool   `json:"linked"`
	Version    string `json:"version"`
	Relay      bool   `json:"relay"`
	RelayError string `json:"relay_error,omitempty"`
	LinkedMs   int64  `json:"linked_ms,omitempty"`
}

// Views shows hs. pub is the hub's public URL now: a relay made from
// another one is off (spec §3 #165). With pub "" that is not checked.
func Views(hs []store.Host, pub string) []View {
	out := make([]View, 0, len(hs))
	for _, h := range hs {
		out = append(out, view(h, pub))
	}
	return out
}

func view(h store.Host, pub string) View {
	v := View{ID: h.ID, Name: h.Name, URL: h.URL, Linked: h.Link.Token != ""}
	if !v.Linked {
		return v
	}
	v.Version, v.LinkedMs = h.Link.Version, h.Link.LinkedMs
	switch r := h.Link.Relay; {
	case pub != "" && r.Base != "" && r.Base != pub:
		v.RelayError = "허브 주소가 바뀌었습니다. 알림 중계를 다시 하세요"
	case r.OK:
		v.Relay = true
	default:
		v.RelayError = r.Error
	}
	return v
}

// Views shows the linked hosts.
func (m *Manager) Views() []View { return Views(m.o.Store.Hosts(), m.publicURL()) }

// Lookup finds a host by its ID, or else by a name only one host has.
func (m *Manager) Lookup(idOrName string) (View, error) {
	hs, pub := m.o.Store.Hosts(), m.publicURL()
	if i := slices.IndexFunc(hs, func(h store.Host) bool { return h.ID == idOrName }); i >= 0 {
		return view(hs[i], pub), nil
	}
	var ids []string
	var hit store.Host
	for _, h := range hs {
		if h.Name == idOrName {
			ids, hit = append(ids, h.ID), h
		}
	}
	switch len(ids) {
	case 0:
		return View{}, errorf("not_found", "그런 호스트가 없습니다: %s. mori hosts로 ID를 확인하세요", idOrName)
	case 1:
		return view(hit, pub), nil
	}
	return View{}, errorf("invalid_params", "이름이 같은 호스트가 여럿입니다. ID로 고르세요: %s", strings.Join(ids, ", "))
}

// Target is where the proxy sends one host's requests.
type Target struct {
	ID, Name string
	Base     *url.URL // the host's origin
	Token    string   // "" when the hub is not linked
}

// Target finds the host id.
func (m *Manager) Target(id string) (Target, bool) {
	for _, h := range m.o.Store.Hosts() {
		if h.ID != id {
			continue
		}
		t := Target{ID: h.ID, Name: h.Name, Token: h.Link.Token, Base: &url.URL{}}
		if u, err := url.Parse(h.URL); err == nil && u.Host != "" {
			t.Base = &url.URL{Scheme: u.Scheme, Host: u.Host}
		} else {
			t.Token = "" // a hand-edited URL: not linked
		}
		return t, true
	}
	return Target{}, false
}

// Relay finds the host whose relay subscription has secret, with the key
// and auth secret its notifications are encrypted to. It answers before
// the relay is confirmed: the host's test notification comes back while
// SetupRelay waits.
func (m *Manager) Relay(secret string) (id string, key *ecdh.PrivateKey, authSecret []byte, ok bool) {
	if secret == "" {
		return "", nil, nil, false
	}
	for _, h := range m.o.Store.Hosts() {
		r := h.Link.Relay
		if h.Link.Token == "" || r.Secret == "" || subtle.ConstantTimeCompare([]byte(r.Secret), []byte(secret)) != 1 {
			continue
		}
		b, err := enc.DecodeString(r.Key)
		if err != nil {
			return "", nil, nil, false
		}
		k, err := ecdh.P256().NewPrivateKey(b)
		if err != nil {
			return "", nil, nil, false
		}
		a, err := enc.DecodeString(r.Auth)
		if err != nil || len(a) != 16 {
			return "", nil, nil, false
		}
		return h.ID, k, a, true
	}
	return "", nil, nil, false
}

// ParseTarget reads what a person gives as a host (spec §3 #160): an
// origin, or a pairing link <origin>/pair#code=XXXX-XXXX. origin is
// lower-cased and has no default port.
func ParseTarget(raw string) (origin, code string, err error) {
	bad := errorf("invalid_params", "호스트 주소 %q: https://호스트[:포트] 꼴이거나 페어링 링크여야 합니다", raw)
	u, perr := url.Parse(strings.TrimSpace(raw))
	if perr != nil || u.Scheme != "https" && u.Scheme != "http" || u.Host == "" || u.Hostname() == "" ||
		u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Opaque != "" {
		return "", "", bad
	}
	switch u.Path {
	case "", "/": // a fragment here is the UI's own route (/#/t/…), copied from the address bar
	case "/pair":
		q, qerr := url.ParseQuery(u.Fragment)
		if qerr != nil || q.Get("code") == "" {
			return "", "", bad
		}
		code = q.Get("code")
	default:
		return "", "", bad
	}
	host := strings.ToLower(u.Host)
	if p := u.Port(); u.Scheme == "https" && p == "443" || u.Scheme == "http" && p == "80" {
		host = strings.ToLower(u.Hostname())
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
	}
	return u.Scheme + "://" + host, code, nil
}

// isSelf tells whether origin is this hub: its public URL or its listen
// address.
func (m *Manager) isSelf(origin string) bool {
	if pub, _, err := ParseTarget(m.publicURL()); err == nil && pub == origin {
		return true
	}
	host, port, err := net.SplitHostPort(m.o.Listen)
	if err != nil {
		return false
	}
	hosts := []string{host}
	if ip := net.ParseIP(host); host == "localhost" || ip != nil && ip.IsLoopback() {
		hosts = []string{"127.0.0.1", "localhost", "::1"}
	}
	for _, h := range hosts {
		for _, scheme := range []string{"http://", "https://"} {
			if o, _, err := ParseTarget(scheme + net.JoinHostPort(h, port)); err == nil && o == origin {
				return true
			}
		}
	}
	return false
}

// cleanName puts name on one line. An optional name may be empty.
func cleanName(name string, optional bool) (string, error) {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, name)
	name = strings.Join(strings.Fields(name), " ")
	if name == "" && optional {
		return "", nil
	}
	if n := utf8.RuneCountInString(name); n < 1 || n > maxName {
		return "", errorf("invalid_params", "호스트 이름은 1~%d자여야 합니다", maxName)
	}
	return name, nil
}

// defaultName is the name the host gives itself, or else its address.
func defaultName(host, origin string) string {
	if n, err := cleanName(host, false); err == nil {
		return n
	}
	u, _ := url.Parse(origin)
	return u.Hostname()
}

// do sends one request to the host at origin as the hub.
func (m *Manager) do(ctx context.Context, method, origin, path, token string, body any) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, origin+path, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Origin", origin)
	req.Header.Set("User-Agent", m.UserAgent())
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	}
	res, err := m.client.Do(req)
	if err != nil {
		return nil, unreachable(origin, err)
	}
	return res, nil
}

func unreachable(origin string, err error) *Error {
	if errors.Is(err, context.DeadlineExceeded) {
		return errorf("host_unreachable", "%s에 닿지 못했습니다: 시간 안에 답하지 않았습니다", origin)
	}
	if ue := (*url.Error)(nil); errors.As(err, &ue) {
		err = ue.Err // the URL is said already
	}
	return errorf("host_unreachable", "%s에 닿지 못했습니다: %v", origin, err)
}

// readError reads a Mori error body (spec §7.4).
func readError(res *http.Response) *Error {
	var body struct {
		Error struct{ Kind, Message string } `json:"error"`
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, maxBody))
	_ = json.Unmarshal(b, &body)
	return &Error{Kind: cmp.Or(body.Error.Kind, "host_unreachable"), Message: cmp.Or(body.Error.Message, fmt.Sprintf("응답 %d", res.StatusCode))}
}

type hello struct {
	App     string `json:"app"`
	Version string `json:"version"`
	Host    string `json:"host"`
}

// hello asks origin whether it is a Mori.
func (m *Manager) hello(ctx context.Context, origin string) (hello, error) {
	res, err := m.do(ctx, http.MethodGet, origin, "/api/hello", "", nil)
	if err != nil {
		return hello{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusNotFound {
		return hello{}, errorf("host_unreachable", "%s에 닿지 못했습니다: 응답 %d", origin, res.StatusCode)
	}
	var h hello
	if res.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(res.Body, maxBody)).Decode(&h) == nil && h.App == "mori" {
		return h, nil
	}
	return hello{}, errorf("invalid_params", "Mori가 아닙니다: %s", origin)
}

// pair pairs the hub with the host as a device and returns its token.
func (m *Manager) pair(ctx context.Context, origin, code string) (string, error) {
	res, err := m.do(ctx, http.MethodPost, origin, "/api/pair", "", map[string]string{"code": code, "name": m.o.HostName + " 허브"})
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		e := readError(res)
		if e.Kind == "invalid_params" || e.Kind == "rate_limited" {
			return "", e
		}
		return "", errorf("host_unreachable", "%s에 닿지 못했습니다: %s", origin, e.Message)
	}
	for _, c := range res.Cookies() {
		if c.Name == auth.CookieName && c.Value != "" {
			return c.Value, nil
		}
	}
	return "", errorf("host_unreachable", "%s에 닿지 못했습니다: 페어링 쿠키가 없습니다", origin)
}

// logout gives token up on the host, which also drops the relay
// subscription made with it. The host may be gone; that is only logged.
func (m *Manager) logout(ctx context.Context, origin, token string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), logoutTimeout)
	defer cancel()
	res, err := m.do(ctx, http.MethodPost, origin, "/api/logout", token, nil)
	if err == nil {
		res.Body.Close()
		if res.StatusCode != http.StatusNoContent && res.StatusCode != http.StatusUnauthorized {
			err = fmt.Errorf("status %d", res.StatusCode)
		}
	}
	if err != nil {
		m.o.Logger.Info("logging out of a host", "url", origin, "err", err)
	}
}

// Link pairs the hub with the host at rawURL (spec §6.9). A host linked
// before keeps its ID and name and gets the new token; the old one is
// logged out. created tells a new host. A relay that cannot be made is no
// error: the view says why.
func (m *Manager) Link(ctx context.Context, rawURL, code, name string) (v View, created bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	origin, linkCode, err := ParseTarget(rawURL)
	if err != nil {
		return View{}, false, err
	}
	if code = cmp.Or(strings.TrimSpace(code), linkCode); code == "" {
		return View{}, false, errorf("invalid_params", "페어링 코드가 필요합니다: 그 호스트에서 mori pair를 실행해 받으세요")
	}
	if m.isSelf(origin) {
		return View{}, false, errorf("invalid_params", "이 허브 자신은 연결할 수 없습니다: %s", origin)
	}
	if name, err = cleanName(name, true); err != nil {
		return View{}, false, err
	}
	h, err := m.hello(ctx, origin)
	if err != nil {
		return View{}, false, err
	}
	token, err := m.pair(ctx, origin, code)
	if err != nil {
		return View{}, false, err
	}
	var id, old string
	link := store.HostLink{Token: token, Version: h.Version, LinkedMs: m.o.Now().UnixMilli()}
	err = m.o.Store.Update(func(st *store.State) error {
		id, old, created = "", "", false
		for i := range st.Hosts {
			if o, _, err := ParseTarget(st.Hosts[i].URL); err == nil && o == origin {
				hh := &st.Hosts[i]
				id, old = hh.ID, hh.Link.Token
				hh.Name, hh.URL, hh.Link = cmp.Or(name, hh.Name), origin, link
				return nil
			}
		}
		id, created = store.NewID("h_"), true
		st.Hosts = append(st.Hosts, store.Host{ID: id, Name: cmp.Or(name, defaultName(h.Host, origin)), URL: origin, Link: link})
		return nil
	})
	if err != nil {
		m.logout(ctx, origin, token)
		return View{}, false, err
	}
	if old != "" && old != token {
		m.logout(ctx, origin, old)
	}
	v, err = m.SetupRelay(ctx, id)
	return v, created, err
}

// Unlink forgets the host id, then logs the hub out of it. It is forgotten
// even when it cannot be reached (spec §6.9).
func (m *Manager) Unlink(ctx context.Context, id string) (View, error) {
	var gone store.Host
	err := m.o.Store.Update(func(st *store.State) error {
		i := slices.IndexFunc(st.Hosts, func(h store.Host) bool { return h.ID == id })
		if i < 0 {
			return errorf("not_found", "그런 호스트가 없습니다: %s", id)
		}
		gone = st.Hosts[i]
		st.Hosts = slices.Delete(st.Hosts, i, i+1)
		return nil
	})
	if err != nil {
		return View{}, err
	}
	if gone.Link.Token != "" {
		m.logout(ctx, gone.URL, gone.Link.Token)
	}
	return view(gone, ""), nil
}

// Rename names the host id.
func (m *Manager) Rename(id, name string) (View, error) {
	name, err := cleanName(name, false)
	if err != nil {
		return View{}, err
	}
	pub := m.publicURL()
	var v View
	err = m.o.Store.Update(func(st *store.State) error {
		i := slices.IndexFunc(st.Hosts, func(h store.Host) bool { return h.ID == id })
		if i < 0 {
			return errorf("not_found", "그런 호스트가 없습니다: %s", id)
		}
		st.Hosts[i].Name = name
		v = view(st.Hosts[i], pub)
		return nil
	})
	if err != nil {
		return View{}, err
	}
	return v, nil
}

// SetupRelay makes the relay subscription on the host id again with new
// keys (spec §6.11). It is off, with the reason kept, when the hub is not
// on https or the host does not take it. It ends within 30 s: the
// transport has no response timeout.
func (m *Manager) SetupRelay(ctx context.Context, id string) (View, error) {
	ctx, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	t, ok := m.Target(id)
	switch {
	case !ok:
		return View{}, errorf("not_found", "그런 호스트가 없습니다: %s", id)
	case t.Token == "":
		return View{}, errNotLinked
	}
	pub := m.publicURL()
	if !strings.HasPrefix(pub, "https://") {
		return m.setRelay(id, "", store.Relay{Base: pub, Error: "허브 주소가 https가 아니라 알림을 중계할 수 없습니다"})
	}
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return View{}, err
	}
	authSecret, secret := make([]byte, 16), make([]byte, 32)
	rand.Read(authSecret)
	rand.Read(secret)
	r := store.Relay{Secret: enc.EncodeToString(secret), Key: enc.EncodeToString(key.Bytes()), Auth: enc.EncodeToString(authSecret), Base: pub}
	// Saved first: the host's test notification comes back before subscribe returns.
	if _, err := m.setRelay(id, "", r); err != nil {
		return View{}, err
	}
	if err := m.subscribe(ctx, t, r, key.PublicKey().Bytes()); err != nil {
		r.Error = err.Error()
	} else {
		r.OK = true
	}
	return m.setRelay(id, r.Secret, r)
}

// setRelay stores r as the relay of host id. With want set it stores only
// while the stored relay is still the one with that secret, and otherwise
// returns the view as it is.
func (m *Manager) setRelay(id, want string, r store.Relay) (View, error) {
	pub := m.publicURL()
	var v View
	err := m.o.Store.Update(func(st *store.State) error {
		i := slices.IndexFunc(st.Hosts, func(h store.Host) bool { return h.ID == id })
		switch {
		case i < 0:
			return errorf("not_found", "그런 호스트가 없습니다: %s", id)
		case st.Hosts[i].Link.Token == "":
			return errNotLinked
		case want != "" && st.Hosts[i].Link.Relay.Secret != want:
			v = view(st.Hosts[i], pub)
			return errStale
		}
		st.Hosts[i].Link.Relay = r
		v = view(st.Hosts[i], pub)
		return nil
	})
	if err != nil && !errors.Is(err, errStale) {
		return View{}, err
	}
	return v, nil
}

// subscribe makes the relay subscription on the host and has the host send
// its test notification, which has to come back to the hub.
func (m *Manager) subscribe(ctx context.Context, t Target, r store.Relay, pubKey []byte) error {
	origin := t.Base.String()
	sub := map[string]any{
		"subscription": map[string]any{
			"endpoint": r.Base + "/api/relay/" + r.Secret,
			"keys":     map[string]string{"p256dh": enc.EncodeToString(pubKey), "auth": r.Auth},
		},
		"kinds": relayKinds,
	}
	res, err := m.do(ctx, http.MethodPost, origin, "/api/push/subscriptions", t.Token, sub)
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusCreated {
		defer res.Body.Close()
		if res.StatusCode == http.StatusUnauthorized {
			return errors.New("호스트가 허브의 연결을 받지 않습니다. 다시 연결하세요")
		}
		return errors.New("호스트가 알림 중계를 받지 않았습니다: " + readError(res).Message)
	}
	res.Body.Close()
	res, err = m.do(ctx, http.MethodPost, origin, "/api/push/test", t.Token, nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errors.New("호스트가 보낸 시험 알림이 허브에 오지 않았습니다: " + readError(res).Message)
	}
	var sent struct {
		Sent int `json:"sent"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxBody)).Decode(&sent); err != nil || sent.Sent < 1 {
		return errors.New("호스트가 보낸 시험 알림이 허브에 오지 않았습니다")
	}
	return nil
}

// MarkUnlinked forgets the hub's token for host id after the host refused
// it: the host revoked the hub (spec §9). token is the one refused, so a
// newer link is kept.
func (m *Manager) MarkUnlinked(id, token string) {
	err := m.o.Store.Update(func(st *store.State) error {
		i := slices.IndexFunc(st.Hosts, func(h store.Host) bool { return h.ID == id })
		if i < 0 || token == "" || st.Hosts[i].Link.Token != token {
			return errStale
		}
		st.Hosts[i].Link = store.HostLink{}
		return nil
	})
	switch {
	case err == nil:
		m.o.Logger.Info("host revoked the hub", "host", id)
	case !errors.Is(err, errStale):
		m.o.Logger.Error("forgetting a host's token", "host", id, "err", err)
	}
}
```

`unreachable`의 메시지에는 주소가 들어가지만 토큰·비밀은 들어가지 않는다. `url.Error`를 풀어 쓰므로 `/api/relay/<비밀>`도 메시지에 나오지 않는다(허브는 중계 엔드포인트로 요청하지 않는다).

- [ ] **Step 4: 통과 확인**

Run: `go test -race ./internal/peer && go vet ./internal/peer`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add internal/peer
git commit -m "feat(peer): 다른 호스트와 잇고 알림 중계를 구독한다

허브가 다른 호스트의 Mori에 기기로 페어링하고, 그 호스트의 알림을 허브로 보내는 구독을 둔다(결정 158~160, 165, 168).

- 주소나 페어링 링크를 읽어 Mori인지 확인하고 페어링한다
- 같은 주소를 다시 이으면 ID와 이름을 두고 옛 토큰을 로그아웃한다
- 허브 주소가 https면 중계 구독과 시험 알림으로 중계를 켠다
- 호스트 뷰에는 토큰·키·비밀이 없다

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 4: 호스트 연결 API (단계 11)

**Files:**
- Create: `internal/server/api_hosts.go`
- Modify: `internal/server/server.go` (`Deps.Links`, 경로)
- Modify: `internal/server/errors.go` (`statusFor`, `toAPIError`)
- Modify: `internal/server/api_settings.go:73-119` (옛 `handleGetHosts`·`handlePutHosts`·`hostURL` 삭제)
- Modify: `internal/server/api_terminals.go:148` (overview의 `hosts`)
- Test: `internal/server/hosts_test.go`(새로), `internal/server/terminals_test.go`, `internal/server/server_test.go`
- Modify: `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/views/SettingsEdit.tsx`, `web/src/views/settings.css`, `web/test/fixtures.ts`
- Test: `web/src/lib/hosts.test.ts`, `web/src/lib/store.test.ts`, `web/src/views/Shell.test.tsx`, `web/src/views/SettingsEdit.test.tsx`

**Interfaces:**
- Consumes: Task 3의 `peer.New`, `peer.Options`, `(*peer.Manager).Link/Unlink/Rename/SetupRelay/Views`, `peer.Views`, `peer.View`, `*peer.Error`
- Produces:

```go
// Deps
Links *peer.Manager // nil: the hosts are listed but cannot be linked (503)

func (s *Server) hostViews() []peer.View
func withLinks(c *tls.Config) func(*Deps)              // test helper, hosts_test.go
func fakeMori(t *testing.T, code string) *httptest.Server // test helper, hosts_test.go
```

| 요청 | 답 |
|---|---|
| `GET /api/hosts` | 200 `[]View` |
| `POST /api/hosts {url, code?, name?}` | 201 새 호스트, 200 다시 이음 — `View` |
| `PATCH /api/hosts/{id} {name}` | 200 `View` |
| `DELETE /api/hosts/{id}` | 204 |
| `POST /api/hosts/{id}/relay` | 200 `View` |
| `PUT /api/hosts` | 404(없어짐) |

웹의 `Host`는 `View`와 같은 꼴이 된다. 이 태스크의 설정 카드는 읽기 전용 임시판이고, 여러 호스트 화면은 Task 10이 만든다.

- [ ] **Step 1: 실패하는 테스트**

`internal/server/hosts_test.go`(새 파일):

```go
package server

import (
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/peer"
)

// fakeMori is another host's Mori as far as linking goes: it pairs with
// code and gives the token "tok-<code>".
func fakeMori(t *testing.T, code string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/hello", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"app":"mori","version":"9.9.9","host":"desk","paired":false}`)
	})
	mux.HandleFunc("POST /api/pair", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Code string }
		json.NewDecoder(r.Body).Decode(&body)
		if body.Code != code {
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":{"kind":"invalid_params","message":"코드가 맞지 않거나 만료되었습니다"}}`)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: auth.CookieName, Value: "tok-" + code, Path: "/"})
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/logout", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// withLinks lets the server link to other hosts; c is how it trusts their
// TLS (nil: the system's roots). Its own public URL is not https, so no
// relay is made.
func withLinks(c *tls.Config) func(*Deps) {
	return func(d *Deps) {
		d.Links = peer.New(peer.Options{Store: d.Store, PublicURL: func() string { return "http://hub.invalid" }, Listen: "127.0.0.1:1",
			HostName: d.HostName, Version: d.Version, TLS: c, Logger: d.Logger})
	}
}

func TestHostsAPI(t *testing.T) {
	desk := fakeMori(t, "ABCD-EFGH")
	e := newTestEnv(t, withLinks(nil))
	e.pair()
	for _, body := range []map[string]string{
		{"url": "desk.example.ts.net", "code": "ABCD-EFGH"},
		{"url": desk.URL},
		{"url": desk.URL, "code": "WXYZ-WXYZ"},
	} {
		if eb := e.expectError("POST", "/api/hosts", body, 400); eb.Error.Kind != "invalid_params" {
			t.Fatal(body, eb)
		}
	}
	var v peer.View
	e.json("POST", "/api/hosts", map[string]string{"url": desk.URL + "/pair#code=ABCD-EFGH"}, 201, &v)
	if !strings.HasPrefix(v.ID, "h_") || v.Name != "desk" || v.URL != desk.URL || !v.Linked || v.Version != "9.9.9" || v.Relay || v.RelayError == "" {
		t.Fatalf("%+v", v)
	}
	var again peer.View
	e.json("POST", "/api/hosts", map[string]string{"url": desk.URL + "/", "code": "ABCD-EFGH", "name": "책상"}, 200, &again)
	if again.ID != v.ID || again.Name != "책상" {
		t.Fatalf("relink %+v", again)
	}
	var list []peer.View
	e.json("GET", "/api/hosts", nil, 200, &list)
	if len(list) != 1 || list[0].ID != v.ID {
		t.Fatalf("%+v", list)
	}
	for _, path := range []string{"/api/hosts", "/api/overview"} {
		b, err := io.ReadAll(e.do("GET", path, nil).Body)
		if err != nil || strings.Contains(string(b), "tok-") {
			t.Fatalf("%s shows the token: %s %v", path, b, err)
		}
	}

	e.json("PATCH", "/api/hosts/"+v.ID, map[string]string{"name": " 연구실 "}, 200, &again)
	if again.Name != "연구실" {
		t.Fatalf("rename %+v", again)
	}
	e.expectError("PATCH", "/api/hosts/"+v.ID, map[string]string{"name": "  "}, 400)
	e.expectError("PATCH", "/api/hosts/h_nope0000", map[string]string{"name": "x"}, 404)
	e.json("POST", "/api/hosts/"+v.ID+"/relay", nil, 200, &again)
	if again.Relay || !strings.Contains(again.RelayError, "https") {
		t.Fatalf("relay %+v", again)
	}
	e.expectError("PUT", "/api/hosts", []any{}, 404) // the list is not set as a whole any more

	e.json("DELETE", "/api/hosts/"+v.ID, nil, 204, nil)
	e.expectError("DELETE", "/api/hosts/"+v.ID, nil, 404)
	e.json("GET", "/api/hosts", nil, 200, &list)
	if list == nil || len(list) != 0 {
		t.Fatalf("%#v", list)
	}
}

func TestHostsWithoutLinks(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	var list []peer.View
	e.json("GET", "/api/hosts", nil, 200, &list)
	if list == nil || len(list) != 0 {
		t.Fatalf("%#v", list)
	}
	if eb := e.expectError("POST", "/api/hosts", map[string]string{"url": "https://desk.example.ts.net", "code": "ABCD-EFGH"}, 503); eb.Error.Kind != "unavailable" {
		t.Fatal(eb)
	}
}
```

`internal/server/terminals_test.go`: `TestTerminalLifecycleOverHTTP`의 overview 구조체에서 `Hosts []store.Host`를 `Hosts []peer.View`로 바꾸고 import에 `"github.com/kwonikhyeon/mori/internal/peer"`를 더한다. `TestHostsValidation`(478~503행)은 지운다. 그 내용은 `TestHostsAPI`와 Task 3의 `TestParseTarget`이 맡는다.

`internal/server/server_test.go`의 `TestStatusForKinds` 표에 `"host_unlinked": 409, "host_unreachable": 502,`를 더한다.

- [ ] **Step 2: 실패 확인**

Run: `go test ./internal/server -run 'TestHostsAPI|TestHostsWithoutLinks|TestStatusForKinds|TestTerminalLifecycleOverHTTP'`
Expected: FAIL — `d.Links undefined`.

- [ ] **Step 3: 구현**

`internal/server/server.go`: import에 `"github.com/kwonikhyeon/mori/internal/peer"`를 더하고 `Deps`의 `Push` 아래에 더한다.

```go
	// Links links this hub to other hosts' Mori and finds them for the
	// proxy and the relay (spec §3 #158). Without it the hosts are listed
	// but cannot be linked.
	Links *peer.Manager
```

`routes()`의

```go
	api.HandleFunc("GET /api/hosts", s.handleGetHosts)
	api.HandleFunc("PUT /api/hosts", s.handlePutHosts)
```

를 바꾼다.

```go
	api.HandleFunc("GET /api/hosts", s.handleGetHosts)
	api.HandleFunc("POST /api/hosts", s.needLinks(s.handleLinkHost))
	api.HandleFunc("PATCH /api/hosts/{id}", s.needLinks(s.handleRenameHost))
	api.HandleFunc("DELETE /api/hosts/{id}", s.needLinks(s.handleUnlinkHost))
	api.HandleFunc("POST /api/hosts/{id}/relay", s.needLinks(s.handleHostRelay))
```

`PUT /api/hosts`는 `/api/` 패턴에 걸려 404 `not_found`가 된다(405가 아니다: 메서드 없는 `/api/`가 맞으므로).

`internal/server/errors.go`: import에 `"github.com/kwonikhyeon/mori/internal/peer"`를 더한다. `statusFor`의 두 줄을 바꾼다.

```go
	case "blocked", "finished", "live", "name_taken", "conflict", "already_added", "host_unlinked":
		return http.StatusConflict
```

```go
	case "push_failed", "host_unreachable":
		return http.StatusBadGateway
```

`toAPIError`의 `push.SendError` 검사 아래에 더한다.

```go
	if pe := (*peer.Error)(nil); errors.As(err, &pe) {
		return &apiError{Status: statusFor(pe.Kind), Kind: pe.Kind, Message: pe.Message}
	}
```

`internal/server/api_hosts.go`(새 파일):

```go
package server

import (
	"context"
	"net/http"

	"github.com/kwonikhyeon/mori/internal/peer"
)

// hostViews shows the hosts linked to this hub (spec §3 #168). Without
// Links the stored ones are still shown.
func (s *Server) hostViews() []peer.View {
	if s.d.Links == nil {
		return peer.Views(s.d.Store.Hosts(), "")
	}
	return s.d.Links.Views()
}

// needLinks answers 503 when this server cannot link to other hosts.
func (s *Server) needLinks(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.d.Links == nil {
			writeError(w, errorf(http.StatusServiceUnavailable, "unavailable", "이 서버는 다른 호스트로 잇지 않습니다"))
			return
		}
		h(w, r)
	}
}

func (s *Server) handleGetHosts(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.hostViews())
}

// handleLinkHost links the hub to another host's Mori (spec §6.9). It goes
// on when the device leaves, since the host has used up the code by then.
func (s *Server) handleLinkHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL  string `json:"url"`
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	v, created, err := s.d.Links.Link(context.WithoutCancel(r.Context()), req.URL, req.Code, req.Name)
	if err != nil {
		writeError(w, err)
		return
	}
	s.log.Info("host linked", "host", v.ID, "url", v.URL, "relay", v.Relay)
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, v)
}

func (s *Server) handleRenameHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, err)
		return
	}
	v, err := s.d.Links.Rename(r.PathValue("id"), req.Name)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// handleUnlinkHost forgets a host, then logs the hub out of it; a host
// that cannot be reached is forgotten all the same.
func (s *Server) handleUnlinkHost(w http.ResponseWriter, r *http.Request) {
	v, err := s.d.Links.Unlink(context.WithoutCancel(r.Context()), r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	s.log.Info("host unlinked", "host", v.ID, "url", v.URL)
	w.WriteHeader(http.StatusNoContent)
}

// handleHostRelay makes the host's relay subscription again with new keys
// (spec §6.11).
func (s *Server) handleHostRelay(w http.ResponseWriter, r *http.Request) {
	v, err := s.d.Links.SetupRelay(context.WithoutCancel(r.Context()), r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	s.log.Info("host relay set up", "host", v.ID, "relay", v.Relay)
	writeJSON(w, http.StatusOK, v)
}
```

`internal/server/api_settings.go`: `handleGetHosts`, `handlePutHosts`, `hostURL`(73~119행)을 지우고 import에서 `net/url`과 `strings`를 지운다(`slices`·`unicode/utf8`은 프리셋 검사가 쓴다).

`internal/server/api_terminals.go`의 `handleOverview`에서 `"hosts": st.Hosts,`를 `"hosts": s.hostViews(),`로 바꾼다.

- [ ] **Step 4: Go 통과 확인**

Run: `go test ./internal/server && go vet ./... && go test ./...`
Expected: PASS.

- [ ] **Step 5: 웹 타입과 임시 설정 카드**

`web/src/lib/types.ts`의 `Host`를 바꾼다.

```ts
/** Another host's Mori linked to this hub (spec §3 #168). */
export interface Host {
  id: string
  name: string
  url: string
  linked: boolean
  version: string
  relay: boolean
  relay_error?: string
  linked_ms?: number
}
```

`web/src/lib/api.ts`의 `hosts`에서 `put`을 지운다.

```ts
  hosts: {
    get: () => get<Host[]>('/api/hosts'),
  },
```

`web/test/fixtures.ts`: import에 `Host`를 더하고(`import type { FolderView, Host, Status, TerminalView, Worktree } from '../src/lib/types'`) 끝에 더한다. 이름을 `host`로 하지 않는 것은 store의 `host` 신호와 겹치지 않게 하려는 것이다.

```ts
export function linkedHost(over: Partial<Host> = {}): Host {
  return { id: 'h_desk0001', name: 'desk', url: 'https://desk.example.ts.net', linked: true, version: '0.1.0', relay: true, ...over }
}
```

`web/src/views/SettingsEdit.tsx`: 첫 주석을 고친다.

```tsx
// What Settings edits for the whole host: the folders of the list (spec §3
// #37) and the presets a session starts (#42). It also shows the hosts
// linked to this hub (#168).
```

`/* ---------- 다른 호스트 ---------- */` 아래의 `HostDraft`와 `HostsCard`를 지우고 읽기 전용 카드로 바꾼다. `EDIT_BTN`과 `isHere`는 그대로 둔다(`EDIT_BTN`은 프리셋 카드가 쓴다).

```tsx
/* ---------- 다른 호스트 ---------- */

const EDIT_BTN = '.st-card-head .btn'

/** The hosts linked to this hub. They are linked with `mori hosts link` for now. */
export function HostsCard() {
  const id = useId()
  const list = hosts.value
  return (
    <section class="st-card st-list" aria-labelledby={id}>
      <div class="st-card-head">
        <h2 id={id} class="st-h2">
          다른 호스트
        </h2>
      </div>
      {list.length === 0 && <p class="st-none">이은 호스트가 없습니다.</p>}
      {list.map((h, i) => (
        <div key={h.id}>
          {i > 0 && <div class="st-div is-tight" />}
          <div class="st-row">
            <span class="st-row-icon">
              <Icon name="monitor" size={20} />
            </span>
            <span class="st-row-main">
              <span class="st-row-name">
                <span class="st-name">{h.name}</span>
                {isHere(h.url) && <span class="st-pill">이 호스트</span>}
                {!h.linked && <span class="st-pill">끊김</span>}
              </span>
              <span class="st-row-sub mono">{[h.url, h.version].filter(Boolean).join(' · ')}</span>
            </span>
          </div>
        </div>
      ))}
      <p class="st-hint">
        다른 컴퓨터의 Mori를 이 허브에 이으려면 이 컴퓨터에서 <code>mori hosts link 주소 코드</code>를 실행하세요. 코드는 그 컴퓨터에서 <code>mori pair</code>로 받습니다.
      </p>
    </section>
  )
}
```

`web/src/views/settings.css`에서 쓰지 않게 된 규칙(464~466행)을 지운다.

```css
.st-pc .st-item-fields.is-host {
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
}
```

- [ ] **Step 6: 웹 테스트를 새 타입에 맞추기**

`web/src/lib/hosts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { linkedHost } from '../../test/fixtures'
import { otherHosts } from './hosts'

describe('otherHosts', () => {
  it('leaves out this host and what is not a web address', () => {
    const hs = [
      linkedHost({ name: 'macmini', url: 'https://macmini.example.ts.net' }),
      linkedHost({ name: 'desktop', url: 'https://desktop.example.ts.net/' }),
      linkedHost({ name: 'broken', url: 'not a url' }),
      linkedHost({ name: 'script', url: 'javascript:alert(1)' }),
    ]
    expect(otherHosts(hs, 'https://macmini.example.ts.net').map((h) => h.name)).toEqual(['desktop'])
  })
})
```

`web/src/lib/store.test.ts`: fixtures import에 `linkedHost`를 더하고 67행을 `hosts: [linkedHost({ name: 'desktop', url: 'https://desktop.example.ts.net' })],`로 바꾼다.

`web/src/views/Shell.test.tsx`: fixtures import에 `linkedHost`를 더하고 202~205행을 바꾼다.

```tsx
    hosts.value = [linkedHost(), linkedHost({ id: 'h_self0001', name: 'self', url: location.origin })]
```

`web/src/views/SettingsEdit.test.tsx`: fixtures import를 `import { folder, linkedHost } from '../../test/fixtures'`로, 타입 import를 `import type { FolderView, Preset } from '../lib/types'`로 바꾸고, `describe('HostsCard', …)`(162~247행)를 바꾼다.

```tsx
describe('HostsCard', () => {
  it('lists the linked hosts and how they are', () => {
    hosts.value = [
      linkedHost(),
      linkedHost({ id: 'h_lab00001', name: 'lab', url: 'https://lab.example.ts.net', linked: false, version: '' }),
      linkedHost({ id: 'h_self0001', name: 'macmini', url: location.origin }),
    ]
    render(<HostsCard />)
    const row = (name: string) => screen.getByText(name, { selector: '.st-name' }).closest('.st-row') as HTMLElement
    expect(within(row('desk')).getByText('https://desk.example.ts.net · 0.1.0')).toBeTruthy()
    expect(within(row('desk')).queryByText('끊김')).toBeNull()
    expect(within(row('lab')).getByText('끊김')).toBeTruthy()
    expect(within(row('lab')).getByText('https://lab.example.ts.net')).toBeTruthy()
    expect(within(row('macmini')).getByText('이 호스트')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says how to link one', () => {
    render(<HostsCard />)
    expect(screen.getByText('이은 호스트가 없습니다.')).toBeTruthy()
    expect(document.querySelector('.st-hint')!.textContent).toBe(
      '다른 컴퓨터의 Mori를 이 허브에 이으려면 이 컴퓨터에서 mori hosts link 주소 코드를 실행하세요. 코드는 그 컴퓨터에서 mori pair로 받습니다.',
    )
  })
})
```

- [ ] **Step 7: 웹 통과 확인**

Run: `cd web && npm run build && npm test`
Expected: 타입 오류 없이 빌드되고 테스트가 모두 통과한다.

- [ ] **Step 8: 커밋**

```bash
git add internal/server web/src web/test
git commit -m "feat(server): 호스트 연결 API

허브가 다른 호스트를 잇고, 이름을 바꾸고, 끊고, 알림 중계를 다시 하는 API를 둔다(결정 168). 호스트 목록을 통째로 바꾸던 PUT /api/hosts는 없앤다.

- GET/POST /api/hosts, PATCH·DELETE /api/hosts/{id}, POST /api/hosts/{id}/relay
- 새 오류 종류 host_unlinked(409), host_unreachable(502)
- overview의 hosts는 토큰 없는 호스트 뷰다
- 설정의 다른 호스트 카드는 여러 호스트 화면 전까지 읽기 전용으로 둔다

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 5: 다른 호스트로 중계 — /h/<ID> (단계 11)

**Files:**
- Create: `internal/server/api_proxy.go`
- Modify: `internal/server/server.go` (`Server.proxy`, `New`, `routes`)
- Modify: `internal/server/middleware.go:32` (`isWS`)
- Test: `internal/server/proxy_test.go`(새로)

**Interfaces:**
- Consumes: Task 3의 `peer.Target{ID, Name string; Base *url.URL; Token string}`, `(*peer.Manager).Target(id string) (peer.Target, bool)`, `MarkUnlinked(id, token string)`, `UserAgent() string`, `Transport() http.RoundTripper`, `peer.View`. Task 4의 `Deps.Links`, `withLinks(c *tls.Config) func(*Deps)`, `GET /api/hosts`.
- Produces:

```go
const maxRelayBody = maxUpload + 2<<20                  // 10 MiB
const closeUnknownHost websocket.StatusCode = 4404
const closeHostUnreachable websocket.StatusCode = 4502
func isWS(path string) bool                             // middleware.go: /ws/… and /h/<ID>/ws/…
func stripHost(path string) string                      // /h/<ID>/api/hello → /api/hello
func closeReason(msg string) string                     // at most 123 bytes, cut at a rune
func (e *testEnv) linkHost(origin string) string        // test helper: a linked host with the token "tok"
func (e *testEnv) openSockets() int                     // test helper: the sockets revoke or stop would cut
func newFakePeer(t *testing.T) (*fakePeer, *httptest.Server) // test helper: a host behind the hub
func echoes(t *testing.T, c *websocket.Conn)            // test helper
```

| 요청 | 답 |
|---|---|
| 허용 목록의 `/h/<ID>/api/…`, `/h/<ID>/ws/…` | 그 호스트의 답 그대로. 단 `Set-Cookie`·CSP·`X-Content-Type-Options`·`Referrer-Policy`는 뺀다 |
| 그 밖의 `/h/…` | 404 `not_found` "허브가 중계하지 않는 API입니다" |
| 없는 ID | 404 `not_found` / 소켓 4404 |
| 토큰 없음, 호스트의 401 | 409 `host_unlinked` / 소켓 4401 |
| 접속·TLS 실패, 응답 전에 끊김 | 502 `host_unreachable` / 소켓 4502 |
| 본문 10 MiB 넘음 | 413 `too_large`. 길이를 밝힌 본문은 호스트에 닿기 전에, 길이를 모르는 본문은 10 MiB에서 끊는다 |
| `Deps.Links` 없음 | 503 `unavailable` / 소켓 4404 |
| 페어링 안 된 폰 | 401(`requireDevice`) / 소켓 4401 |

`/h/`는 `Deps.Links`가 없어도 늘 등록한다. 응답 헤더를 보낸 뒤 호스트가 끊으면 `ReverseProxy`가 `http.ErrAbortHandler`로 폰 연결을 끊는다(502는 헤더 전에만 나온다). 터널 안에서는 허브가 말할 수 없으므로, 기기 철회와 허브 종료는 중계 소켓을 종료 코드 없이 끊는다.

- [ ] **Step 1: 실패하는 테스트**

`internal/server/proxy_test.go`(새 파일):

```go
package server

import (
	"bufio"
	"cmp"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/peer"
	"github.com/kwonikhyeon/mori/internal/store"
)

// hostSaw is what a host got from the hub.
type hostSaw struct {
	Method, Path, RawQuery, Proto string
	Header                        http.Header
	Body                          int64
}

// fakePeer is another host's Mori behind the hub. It answers each API with
// what it got, or with an error body when status is an error, and echoes
// on /ws/events.
type fakePeer struct {
	mu     sync.Mutex
	status int // 0: 200
	got    []hostSaw
	ended  chan struct{} // an echo socket ended
}

func newFakePeer(t *testing.T) (*fakePeer, *httptest.Server) {
	t.Helper()
	p := &fakePeer{ended: make(chan struct{}, 8)}
	srv := httptest.NewServer(p)
	t.Cleanup(srv.Close)
	return p, srv
}

func (p *fakePeer) answer(status int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.status = status
}

func (p *fakePeer) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.got)
}

func (p *fakePeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	n, err := io.Copy(io.Discard, r.Body)
	if err != nil {
		return // the hub gave up on the body
	}
	saw := hostSaw{Method: r.Method, Path: r.URL.EscapedPath(), RawQuery: r.URL.RawQuery, Proto: r.Proto, Header: r.Header.Clone(), Body: n}
	p.mu.Lock()
	p.got = append(p.got, saw)
	status := cmp.Or(p.status, http.StatusOK)
	p.mu.Unlock()
	switch {
	case status >= 400:
		writeJSON(w, status, map[string]any{"error": map[string]string{"kind": "core_unavailable", "message": "그 호스트의 오류"}})
	case r.URL.Path == "/ws/events":
		p.echo(w, r)
	default:
		w.Header().Set("Set-Cookie", "evil=1")
		w.Header().Set("Content-Security-Policy", "default-src *")
		writeJSON(w, status, saw)
	}
}

func (p *fakePeer) echo(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, nil) // nil: Origin must be this host, which the hub says it is
	if err != nil {
		return
	}
	defer func() {
		select {
		case p.ended <- struct{}{}:
		default:
		}
	}()
	defer c.CloseNow()
	for {
		typ, b, err := c.Read(context.Background())
		if err != nil {
			return
		}
		if err := c.Write(context.Background(), typ, b); err != nil {
			return
		}
	}
}

// linkHost puts a host at origin in the hub's state as linked, with the
// token "tok", and returns its ID.
func (e *testEnv) linkHost(origin string) string {
	e.t.Helper()
	var id string
	if err := e.store.Update(func(st *store.State) error {
		id = fmt.Sprintf("h_peer%04d", len(st.Hosts)+1)
		st.Hosts = append(st.Hosts, store.Host{ID: id, Name: "desk", URL: origin,
			Link: store.HostLink{Token: "tok", Version: "9.9.9", LinkedMs: 1}})
		return nil
	}); err != nil {
		e.t.Fatal(err)
	}
	return id
}

// openSockets counts the sockets the hub would cut on revoke or stop.
func (e *testEnv) openSockets() int {
	e.s.hub.mu.Lock()
	defer e.s.hub.mu.Unlock()
	n := 0
	for _, cs := range e.s.hub.conns {
		n += len(cs)
	}
	return n
}

// echoes checks that c gets back what it sends.
func echoes(t *testing.T, c *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), wsWait)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, []byte("안녕")); err != nil {
		t.Fatal(err)
	}
	if _, b, err := c.Read(ctx); err != nil || string(b) != "안녕" {
		t.Fatalf("%q %v", b, err)
	}
}

func TestProxyForwardsWithHubCookie(t *testing.T) {
	p, peerSrv := newFakePeer(t)
	e := newTestEnv(t, withLinks(nil))
	e.pair()
	id := e.linkHost(peerSrv.URL)

	req, err := http.NewRequest("GET", e.srv.URL+"/h/"+id+"/api/terminals/machine%2Ft7?x=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", e.srv.URL)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "ko")
	req.Header.Set("Authorization", "Bearer phone")
	req.Header.Set("X-Forwarded-For", "10.0.0.9")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: e.token})
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatal(res.StatusCode)
	}
	saw := decode[hostSaw](t, res)
	if saw.Method != "GET" || saw.Path != "/api/terminals/machine%2Ft7" || saw.RawQuery != "x=1" {
		t.Fatalf("%+v", saw)
	}
	if c := saw.Header.Values("Cookie"); len(c) != 1 || c[0] != auth.CookieName+"=tok" {
		t.Fatalf("the host got the cookie %q, want the hub's own", c)
	}
	if saw.Header.Get("Origin") != peerSrv.URL || saw.Header.Get("User-Agent") != "mori-hub/test" || saw.Header.Get("Accept") != "application/json" {
		t.Fatalf("%v", saw.Header)
	}
	for k := range saw.Header {
		if !slices.Contains([]string{"Accept", "Accept-Encoding", "Cookie", "Origin", "User-Agent"}, k) {
			t.Errorf("the host got %s: %q", k, saw.Header[k])
		}
	}
	for _, c := range res.Cookies() {
		if c.Name == "evil" {
			t.Error("the host's cookie reached the phone")
		}
	}
	if csp := res.Header.Values("Content-Security-Policy"); len(csp) != 1 || csp[0] == "default-src *" {
		t.Errorf("CSP %q, want the hub's own", csp)
	}
	if p.count() != 1 {
		t.Fatal(p.count())
	}
}

func TestProxyAllowlist(t *testing.T) {
	p, peerSrv := newFakePeer(t)
	e := newTestEnv(t, withLinks(nil))
	e.pair()
	h := "/h/" + e.linkHost(peerSrv.URL)
	for _, c := range []struct{ method, path string }{
		{"POST", "/api/pair"}, {"POST", "/api/logout"}, {"GET", "/api/devices"}, {"DELETE", "/api/devices/d_1"},
		{"POST", "/api/pair-codes"}, {"GET", "/api/hosts"}, {"POST", "/api/hosts"}, {"GET", "/api/push/key"},
		{"POST", "/api/push/subscriptions"}, {"POST", "/api/push/test"}, {"POST", "/api/relay/abc"},
		{"DELETE", "/api/presets"}, {"GET", h + "/api/hello"}, {"GET", "/"}, {"GET", "/api/nope"},
	} {
		if eb := e.expectError(c.method, h+c.path, nil, http.StatusNotFound); eb.Error.Kind != "not_found" {
			t.Errorf("%s %s: %+v", c.method, c.path, eb)
		}
	}
	if n := p.count(); n != 0 {
		t.Fatalf("the host got %d requests", n)
	}
	e.json("GET", h+"/api/hello", nil, http.StatusOK, nil)
	if p.count() != 1 {
		t.Fatal(p.count())
	}
}

func TestProxyHostErrors(t *testing.T) {
	p, peerSrv := newFakePeer(t)
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	e := newTestEnv(t, withLinks(nil))
	e.pair()
	id, goneID := e.linkHost(peerSrv.URL), e.linkHost(gone.URL)

	if eb := e.expectError("GET", "/h/h_nope0000/api/hello", nil, http.StatusNotFound); eb.Error.Kind != "not_found" {
		t.Fatal(eb)
	}
	if eb := e.expectError("GET", "/h/"+goneID+"/api/overview", nil, http.StatusBadGateway); eb.Error.Kind != "host_unreachable" || eb.Error.Message != "desk에 닿지 못했습니다" {
		t.Fatal(eb)
	}
	p.answer(http.StatusServiceUnavailable) // the host's own errors pass through
	if eb := e.expectError("GET", "/h/"+id+"/api/overview", nil, http.StatusServiceUnavailable); eb.Error.Kind != "core_unavailable" || eb.Error.Message != "그 호스트의 오류" {
		t.Fatal(eb)
	}

	p.answer(http.StatusUnauthorized) // the host revoked the hub
	if eb := e.expectError("GET", "/h/"+id+"/api/overview", nil, http.StatusConflict); eb.Error.Kind != "host_unlinked" {
		t.Fatal(eb)
	}
	var hello struct{ Paired bool }
	e.json("GET", "/api/hello", nil, http.StatusOK, &hello)
	if !hello.Paired {
		t.Fatal("the phone lost its pairing with the hub")
	}
	var hosts []peer.View
	e.json("GET", "/api/hosts", nil, http.StatusOK, &hosts)
	if i := slices.IndexFunc(hosts, func(v peer.View) bool { return v.ID == id }); i < 0 || hosts[i].Linked {
		t.Fatalf("%+v", hosts)
	}
	n := p.count()
	if eb := e.expectError("GET", "/h/"+id+"/api/overview", nil, http.StatusConflict); eb.Error.Kind != "host_unlinked" || p.count() != n {
		t.Fatal(eb, p.count()) // without a token the hub does not ask
	}

	e.token = ""
	e.expectError("GET", "/h/"+id+"/api/hello", nil, http.StatusUnauthorized)

	plain := newTestEnv(t) // a Mori that links to no one
	plain.pair()
	if eb := plain.expectError("GET", "/h/h_peer0001/api/hello", nil, http.StatusServiceUnavailable); eb.Error.Kind != "unavailable" {
		t.Fatal(eb)
	}
}

func TestProxyBodyLimit(t *testing.T) {
	p, peerSrv := newFakePeer(t)
	e := newTestEnv(t, withLinks(nil))
	e.pair()
	files := "/h/" + e.linkHost(peerSrv.URL) + "/api/terminals/t1/files"

	res := e.upload(files, "file", "big.bin", make([]byte, maxUpload)) // the most a host takes
	if res.StatusCode != http.StatusOK {
		t.Fatal(res.StatusCode)
	}
	if saw := decode[hostSaw](t, res); saw.Body < maxUpload {
		t.Fatalf("the host read %d bytes", saw.Body)
	}

	n := p.count()
	big := strings.Repeat("x", 11<<20)
	if eb := e.expectError("POST", files, big, http.StatusRequestEntityTooLarge); eb.Error.Kind != "too_large" {
		t.Fatal(eb)
	}
	req, err := http.NewRequest("POST", e.srv.URL+files, io.MultiReader(strings.NewReader(big))) // no length: chunked
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", e.srv.URL)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: e.token})
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatal(res.StatusCode)
	}
	if p.count() != n {
		t.Fatal("the host took a body over the limit")
	}
}

func TestProxyWebSocket(t *testing.T) {
	p, peerSrv := newFakePeer(t)
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	e := newTestEnv(t, withLinks(nil))
	dev := e.pair()
	id, goneID := e.linkHost(peerSrv.URL), e.linkHost(gone.URL)

	c := e.dialWS("/h/" + id + "/ws/events")
	echoes(t, c)
	if n := e.openSockets(); n != 1 {
		t.Fatalf("%d sockets", n)
	}
	if err := e.auth.Revoke(dev.ID); err != nil {
		t.Fatal(err)
	}
	if code := readUntilClosed(t, c); code != -1 {
		t.Fatalf("closed with %d; a revoked device's relayed socket is cut without a code", code)
	}
	select {
	case <-p.ended:
	case <-time.After(wsWait):
		t.Fatal("the host's socket is still open")
	}
	e.eventually(func() bool { return e.openSockets() == 0 })

	e.pair()
	refused := func(path string, want websocket.StatusCode) {
		t.Helper()
		c, _, err := e.tryWS(e.srv.URL, path)
		if err != nil {
			t.Fatal(path, err)
		}
		defer c.CloseNow()
		if code := readUntilClosed(t, c); code != want {
			t.Errorf("%s: closed with %d, want %d", path, code, want)
		}
	}
	refused("/h/h_nope0000/ws/events", closeUnknownHost)
	refused("/h/"+url.PathEscape(strings.Repeat("가", 60))+"/ws/events", closeUnknownHost) // its reason is cut to fit
	refused("/h/"+goneID+"/ws/events", closeHostUnreachable)
	p.answer(http.StatusUnauthorized)
	refused("/h/"+id+"/ws/events", closeUnauthorized) // the host revoked the hub
	refused("/h/"+id+"/ws/events", closeUnauthorized) // and now the hub has no token for it
	e.token = ""
	refused("/h/"+id+"/ws/events", closeUnauthorized) // the phone is not paired
}

// closeFrame is a close frame with code 4000, as a host sends it.
const closeFrame = "\x88\x02\x0f\xa0"

func TestTunnelEndsWhenHostCloses(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() { // a host that ends the socket as soon as it opens
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		if _, err := http.ReadRequest(bufio.NewReader(c)); err != nil {
			return
		}
		io.WriteString(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
			"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"+closeFrame)
	}()
	e := newTestEnv(t, withLinks(nil))
	e.pair()
	id := e.linkHost("http://" + ln.Addr().String())

	phone, err := net.Dial("tcp", e.srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer phone.Close() // the phone stays silent: it never closes on its own
	fmt.Fprintf(phone, "GET /h/%s/ws/events HTTP/1.1\r\nHost: %s\r\nOrigin: %s\r\nCookie: %s=%s\r\n"+
		"Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
		id, e.srv.Listener.Addr(), e.srv.URL, auth.CookieName, e.token)
	phone.SetReadDeadline(time.Now().Add(wsWait))
	br := bufio.NewReader(phone)
	res, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatal(res.Status)
	}
	if rest, err := io.ReadAll(br); err != nil || string(rest) != closeFrame {
		t.Fatalf("%q %v; want the host's close frame, then the end", rest, err)
	}
	e.eventually(func() bool { return e.openSockets() == 0 })

	// The other way round: the phone goes away without a word.
	p, peerSrv := newFakePeer(t)
	c := e.dialWS("/h/" + e.linkHost(peerSrv.URL) + "/ws/events")
	echoes(t, c)
	c.CloseNow()
	select {
	case <-p.ended:
	case <-time.After(wsWait):
		t.Fatal("the host's socket is still open")
	}
	e.eventually(func() bool { return e.openSockets() == 0 })
}

func TestProxyOverHTTP2Host(t *testing.T) {
	p := &fakePeer{ended: make(chan struct{}, 8)}
	peerSrv := httptest.NewUnstartedServer(p)
	peerSrv.EnableHTTP2 = true // like tailscale serve: h2 offered, HTTP/1.1 still taken
	peerSrv.StartTLS()
	t.Cleanup(peerSrv.Close)
	e := newTestEnv(t, withLinks(peerSrv.Client().Transport.(*http.Transport).TLSClientConfig))
	e.pair()
	id := e.linkHost(peerSrv.URL)

	var saw hostSaw
	e.json("GET", "/h/"+id+"/api/hello", nil, http.StatusOK, &saw)
	if saw.Proto != "HTTP/1.1" {
		t.Fatal(saw.Proto)
	}
	echoes(t, e.dialWS("/h/"+id+"/ws/events"))
}

func TestIsWS(t *testing.T) {
	for path, want := range map[string]bool{
		"/ws/events":              true,
		"/ws/attach":              true,
		"/h/h_peer0001/ws/events": true,
		"/h/h_peer0001/api/hello": false,
		"/api/hello":              false,
		"/h/ws/events":            false,
		"/h/":                     false,
	} {
		if isWS(path) != want {
			t.Errorf("isWS(%q) = %v", path, !want)
		}
	}
}

func TestCloseReason(t *testing.T) {
	long := strings.Repeat("가", 60)
	if r := closeReason(long); len(r) != 123 || !utf8.ValidString(r) || !strings.HasPrefix(long, r) {
		t.Fatalf("%d bytes: %q", len(r), r)
	}
	if r := closeReason("짧은 이유"); r != "짧은 이유" {
		t.Fatal(r)
	}
}
```

- [ ] **Step 2: 실패 확인**

Run: `go test ./internal/server -run 'TestProxy|TestTunnel|TestIsWS|TestCloseReason'`
Expected: FAIL — `undefined: isWS`, `closeReason`, `closeUnknownHost`, `closeHostUnreachable`로 컴파일되지 않는다.

- [ ] **Step 3: 구현**

`internal/server/api_proxy.go`(새 파일):

```go
package server

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/kwonikhyeon/mori/internal/auth"
	"github.com/kwonikhyeon/mori/internal/peer"
)

const (
	// maxRelayBody is the most the hub passes on to a host: a whole upload
	// and its multipart framing (spec §3 #162).
	maxRelayBody = maxUpload + 2<<20

	// closeUnknownHost and closeHostUnreachable refuse a relayed socket
	// (spec §3 #164). A host that no longer takes the hub is
	// closeUnauthorized, as an unpaired phone is.
	closeUnknownHost     websocket.StatusCode = 4404
	closeHostUnreachable websocket.StatusCode = 4502

	// maxCloseReason is the longest reason a close frame has room for.
	maxCloseReason = 123
)

// proxied are the APIs a phone reaches on another host through the hub,
// as /h/<ID><path> (spec §3 #161). Pairing, devices, the host list and
// push subscriptions are the hub's own.
var proxied = []string{
	"GET /api/hello",
	"GET /api/overview",
	"GET /api/folders",
	"POST /api/folders",
	"PATCH /api/folders/{id}",
	"DELETE /api/folders/{id}",
	"GET /api/fs",
	"GET /api/folders/{id}/git",
	"GET /api/folders/{id}/branches",
	"POST /api/folders/{id}/worktrees",
	"DELETE /api/folders/{id}/worktrees",
	"GET /api/git/status",
	"GET /api/git/diff",
	"GET /api/git/log",
	"GET /api/git/commit",
	"GET /api/terminals",
	"POST /api/terminals",
	"GET /api/terminals/{t}",
	"PATCH /api/terminals/{t}",
	"DELETE /api/terminals/{t}",
	"POST /api/terminals/{t}/send",
	"POST /api/terminals/{t}/keys",
	"POST /api/terminals/{t}/interrupt",
	"POST /api/terminals/{t}/kill",
	"POST /api/terminals/{t}/files",
	"GET /api/terminals/{t}/text",
	"GET /api/presets",
	"PUT /api/presets",
	"GET /api/push/settings",
	"PUT /api/push/settings",
	"GET /ws/events",
	"GET /ws/attach",
}

// forwardedHeaders are all a host sees of the phone's request headers, and
// upgradeHeaders a socket's on top of them. The hub sets Cookie, Origin
// and User-Agent itself (spec §3 #162).
var (
	forwardedHeaders = []string{"Accept", "Content-Type"}
	upgradeHeaders   = []string{"Connection", "Upgrade", "Sec-WebSocket-Key", "Sec-WebSocket-Version",
		"Sec-WebSocket-Extensions", "Sec-WebSocket-Protocol"}
)

// droppedHeaders never reach the phone from a host: its cookie, and the
// security headers the hub sets for itself.
var droppedHeaders = []string{"Set-Cookie", "Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy"}

var (
	errUnlinked      = errors.New("host answered 401")
	errHostUnlinked  = errorf(http.StatusConflict, "host_unlinked", "이 호스트와의 연결이 끊겼습니다. 허브에서 다시 연결하세요")
	errRelayTooLarge = errorf(http.StatusRequestEntityTooLarge, "too_large", "요청 본문이 %d MiB를 넘습니다", maxRelayBody>>20)
)

type proxyKey struct{}

// proxyTarget is where one relayed request goes, for the proxy's hooks.
type proxyTarget struct {
	peer.Target
	tw *tunnelWriter
	ws bool
}

func (s *Server) newProxy() *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite:        s.rewrite,
		Transport:      s.d.Links.Transport(),
		ModifyResponse: s.modifyResponse,
		ErrorHandler:   s.proxyError,
		ErrorLog:       slog.NewLogLogger(s.log.Handler(), slog.LevelDebug),
	}
}

// serveProxy relays a request under /h/<ID> to that host, as the hub's
// own device there (spec §3 #161~#164).
func (s *Server) serveProxy(w http.ResponseWriter, r *http.Request) {
	ws := isWS(r.URL.Path)
	if s.proxy == nil {
		refuse(w, r, ws, closeUnknownHost, errorf(http.StatusServiceUnavailable, "unavailable", "이 서버는 다른 호스트로 잇지 않습니다"))
		return
	}
	dev, paired := deviceFrom(r.Context())
	if !paired { // requireDevice lets only sockets through unpaired
		refuseWS(w, r, closeUnauthorized, "페어링되지 않은 기기입니다")
		return
	}
	t, ok := s.d.Links.Target(r.PathValue("host"))
	switch {
	case !ok:
		refuse(w, r, ws, closeUnknownHost, errorf(http.StatusNotFound, "not_found", "그런 호스트가 없습니다: %s", r.PathValue("host")))
		return
	case t.Token == "":
		refuse(w, r, ws, closeUnauthorized, errHostUnlinked)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	tw := &tunnelWriter{ResponseWriter: w}
	if ws {
		// Revoking the device or stopping the hub cuts the tunnel without a
		// close code: the hub has no say inside it.
		remove, ok := s.hub.add(dev.ID, func(websocket.StatusCode, string) { cancel(); tw.close() })
		if !ok {
			refuseWS(w, r, websocket.StatusGoingAway, goingAway)
			return
		}
		defer remove()
		if !s.stillPaired(dev.ID) {
			refuseWS(w, r, closeUnauthorized, "기기가 철회되었습니다")
			return
		}
	}
	if r.ContentLength > maxRelayBody {
		writeError(w, errRelayTooLarge)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRelayBody) // w itself: the connection then closes after the 413
	s.proxy.ServeHTTP(tw, r.WithContext(context.WithValue(ctx, proxyKey{}, &proxyTarget{Target: t, tw: tw, ws: ws})))
}

// rewrite sends the request to the host with the hub's credentials there.
// Of the phone's headers only the content ones go on, and a socket's.
func (s *Server) rewrite(pr *httputil.ProxyRequest) {
	t := pr.In.Context().Value(proxyKey{}).(*proxyTarget)
	p := stripHost(pr.In.URL.EscapedPath()) // keeps %2F in a terminal's address
	pr.Out.URL.Path, _ = url.PathUnescape(p) // an escaped path always unescapes
	pr.Out.URL.RawPath = p
	pr.SetURL(t.Base)
	h := make(http.Header)
	keep := func(names []string) {
		for _, k := range names {
			for _, v := range pr.Out.Header.Values(k) {
				h.Add(k, v)
			}
		}
	}
	keep(forwardedHeaders)
	if t.ws {
		keep(upgradeHeaders)
	}
	h.Set("Cookie", (&http.Cookie{Name: auth.CookieName, Value: t.Token}).String())
	h.Set("Origin", t.Base.Scheme+"://"+t.Base.Host)
	h.Set("User-Agent", s.d.Links.UserAgent())
	pr.Out.Header = h
}

// modifyResponse keeps the host's cookie and security headers from the
// phone. A 401 means the host revoked the hub. A socket the host opened
// ends for the phone as soon as the host ends it.
func (s *Server) modifyResponse(res *http.Response) error {
	for _, k := range droppedHeaders {
		res.Header.Del(k)
	}
	t := res.Request.Context().Value(proxyKey{}).(*proxyTarget)
	if res.StatusCode == http.StatusUnauthorized {
		s.d.Links.MarkUnlinked(t.ID, t.Token)
		return errUnlinked
	}
	if rwc, ok := res.Body.(io.ReadWriteCloser); ok && res.StatusCode == http.StatusSwitchingProtocols {
		res.Body = &tunnelBody{ReadWriteCloser: rwc, tw: t.tw}
	}
	return nil
}

// proxyError answers when the hub could not ask the host, or the host
// would not have the hub. r is the request to the host, which still has
// the socket headers, so a socket is refused with a close code.
func (s *Server) proxyError(w http.ResponseWriter, r *http.Request, err error) {
	t := r.Context().Value(proxyKey{}).(*proxyTarget)
	var mbe *http.MaxBytesError
	switch {
	case t.tw.hijacked(): // a tunnel ran and ended; no one is left to answer
		s.log.Debug("relay tunnel ended", "host", t.ID, "err", err)
	case errors.Is(err, context.Canceled) && r.Context().Err() != nil: // the phone left or was cut off
	case errors.Is(err, errUnlinked):
		refuse(w, r, t.ws, closeUnauthorized, errHostUnlinked)
	case errors.As(err, &mbe):
		writeError(w, errRelayTooLarge)
	default:
		s.log.Info("host unreachable", "host", t.ID, "err", err)
		refuse(w, r, t.ws, closeHostUnreachable, errorf(http.StatusBadGateway, "host_unreachable", "%s에 닿지 못했습니다", t.Name))
	}
}

// refuse turns down a relayed request: with an error body, or a socket
// with a close code the UI acts on (spec §3 #164).
func refuse(w http.ResponseWriter, r *http.Request, ws bool, code websocket.StatusCode, e *apiError) {
	if ws {
		refuseWS(w, r, code, e.Message)
		return
	}
	writeError(w, e)
}

func refuseWS(w http.ResponseWriter, r *http.Request, code websocket.StatusCode, reason string) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // requireDevice has checked Origin
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	c.Close(code, closeReason(reason))
}

// closeReason fits msg in a close frame, cut at a rune boundary. A longer
// reason makes Close fail without sending the frame at all.
func closeReason(msg string) string {
	msg = strings.ToValidUTF8(msg, "")
	if len(msg) > maxCloseReason {
		msg = msg[:maxCloseReason]
		for !utf8.ValidString(msg) {
			msg = msg[:len(msg)-1]
		}
	}
	return msg
}

// stripHost is the host's own path for a relayed one: /h/<ID>/api/hello
// is /api/hello there.
func stripHost(p string) string {
	_, rest, ok := strings.Cut(strings.TrimPrefix(p, "/h/"), "/")
	if !ok {
		return "/"
	}
	return "/" + rest
}

// tunnelWriter is the phone's side of a relayed request. close cuts the
// phone's connection once it is hijacked for a tunnel, at once if it
// already is.
type tunnelWriter struct {
	http.ResponseWriter
	mu   sync.Mutex
	conn net.Conn
	done bool
}

func (t *tunnelWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	c, rw, err := http.NewResponseController(t.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.conn = c
	if t.done {
		c.Close()
	}
	return c, rw, nil
}

func (t *tunnelWriter) Unwrap() http.ResponseWriter { return t.ResponseWriter }

func (t *tunnelWriter) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.done = true
	if t.conn != nil {
		t.conn.Close()
	}
}

func (t *tunnelWriter) hijacked() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.conn != nil
}

// tunnelBody is the host's side of a tunnel. When the host ends it, the
// phone's side is cut too, once the host's last bytes (its close frame)
// are on their way. Without this the proxy only half-closes the phone's
// connection and waits for a phone that may never answer. It has no
// CloseWrite, as the body it wraps has none.
type tunnelBody struct {
	io.ReadWriteCloser
	tw  *tunnelWriter
	err error
}

func (b *tunnelBody) Read(p []byte) (int, error) {
	if b.err != nil {
		b.tw.close()
		return 0, b.err
	}
	n, err := b.ReadWriteCloser.Read(p)
	if err != nil && n > 0 {
		b.err = err // hand over the bytes first
		return n, nil
	}
	if err != nil {
		b.tw.close()
	}
	return n, err
}
```

`internal/server/middleware.go`: 32행 `ws := strings.HasPrefix(r.URL.Path, "/ws/")`를 `ws := isWS(r.URL.Path)`로 바꾸고, `deviceFrom` 뒤에 더한다.

```go
// isWS reports whether path is a socket: the hub's own, or one it relays.
func isWS(path string) bool {
	if strings.HasPrefix(path, "/h/") {
		path = stripHost(path)
	}
	return strings.HasPrefix(path, "/ws/")
}
```

`internal/server/server.go`:

1. import에 `"net/http/httputil"`을 더한다.
2. `Server` 구조체의 `hub *hub` 뒤에 `proxy *httputil.ReverseProxy // nil without Deps.Links`를 더한다.
3. `New`의 `s := &Server{...}`(75행) 바로 뒤에 더한다.

```go
	if d.Links != nil {
		s.proxy = s.newProxy()
	}
```

4. `routes`의 `notFound := func…`(133행) 바로 앞에 더한다.

```go
	for _, p := range proxied {
		method, path, _ := strings.Cut(p, " ")
		api.HandleFunc(method+" /h/{host}"+path, s.serveProxy)
	}
	api.HandleFunc("/h/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, errorf(http.StatusNotFound, "not_found", "허브가 중계하지 않는 API입니다: %s %s", r.Method, r.URL.Path))
	})
```

5. `s.mux.Handle("/ws/", guarded)`(141행) 뒤에 `s.mux.Handle("/h/", guarded)`를 더한다.

메서드 없는 `/h/`가 있으므로 허용 목록에 없는 메서드는 405가 아니라 404다. `{t}`는 이스케이프된 한 마디를 받으므로 `machine%2Ft7`은 나뉘지 않는다.

- [ ] **Step 4: 통과 확인**

Run: `go test -race ./internal/server && go vet ./... && go test ./...`
Expected: PASS. `TestTunnelEndsWhenHostCloses`가 20초를 기다리다 실패하면 `modifyResponse`가 101의 본문을 `tunnelBody`로 감쌌는지 본다.

- [ ] **Step 5: 커밋**

```bash
git add internal/server
git commit -m "feat(server): 다른 호스트를 /h/<ID> 아래로 중계한다

허브가 이은 호스트의 API와 WebSocket을 /h/<ID> 아래로 넘긴다(결정 161~164). 폰은 허브 쿠키만 보내고, 허브가 그 호스트에서 받은 토큰과 Origin·User-Agent를 단다.

- 허용 목록 밖은 404, 없는 호스트 404/4404, 끊긴 호스트 409/4401, 닿지 않는 호스트 502/4502
- 호스트의 401은 허브 철회로 보고 그 호스트를 끊긴 상태로 둔다. 폰의 허브 페어링은 그대로다
- 본문은 10 MiB까지, 호스트의 Set-Cookie와 보안 헤더는 폰에 가지 않는다
- 기기 철회와 허브 종료는 중계 소켓을 종료 코드 없이 끊고, 호스트가 끝낸 소켓은 폰 쪽도 바로 끝난다

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 6: 다른 호스트의 알림 중계 받기 (단계 11)

**Files:**
- Create: `internal/server/api_relay.go`
- Modify: `internal/server/server.go` (`routes`: 바깥 경로 하나)
- Modify: `internal/server/auth_test.go:24-50` (`testEnv.httpClient`, `startTestEnv`), `:83`(`doFrom`), `:126`(`tryWS`)
- Modify: `internal/server/push_test.go:19-33` (`recordSender.bodies`, `payloads`)
- Test: `internal/server/relay_test.go`(새로)

**Interfaces:**
- Consumes: Task 2의 `push.Decrypt(body []byte, priv *ecdh.PrivateKey, authSecret []byte) ([]byte, error)`, `push.Relayed(hostID string, p Payload) (Payload, Kind, bool)`, `(*Notifier).Forward(k Kind, p Payload)`, `Payload.Kind`. Task 3의 `peer.New(peer.Options) *peer.Manager`, `peer.Options{Store, PublicURL, Listen, HostName, Version, TLS, Logger, Now}`, `(*Manager).Relay(secret string) (id string, key *ecdh.PrivateKey, authSecret []byte, ok bool)`, `peer.View`. Task 4의 `Deps.Links *peer.Manager`, `withLinks(c *tls.Config) func(*Deps)`, `POST /api/hosts`, `GET /api/hosts`. Task 5의 `/h/{host}/…`, `(e *testEnv) linkHost(origin string) string`.
- Produces:

```go
const maxRelayPush = 8 << 10                                            // api_relay.go
func (s *Server) handleRelay(w http.ResponseWriter, r *http.Request)    // POST /api/relay/{secret}
func startTestEnv(t *testing.T, srv *httptest.Server, useTLS bool, opts ...func(*Deps)) *testEnv // auth_test.go
// testEnv.httpClient *http.Client: nil (http.DefaultClient), or one that trusts an https env
func (r *recordSender) payloads(t *testing.T) []push.Payload            // push_test.go
func withLog(l *logBuffer) func(*Deps)                                  // relay_test.go
func (e *testEnv) relayTo(id string) relayKeys                          // relay_test.go
func sealed(t *testing.T, k relayKeys, p any) []byte                    // relay_test.go
func (e *testEnv) postRelay(secret, encoding string, body []byte) *http.Response // relay_test.go
```

| 요청 | 답 |
|---|---|
| 모르는 비밀, `Deps.Links` 없음, 끊긴 호스트의 비밀 | 410 `not_found`. 호스트의 알림기는 그 구독을 지운다 |
| `Deps.Push` 없음 | 503 `unavailable` |
| `Content-Encoding`이 `aes128gcm`이 아님 | 400 `invalid_params` |
| 본문 8 KiB 넘음 | 413 `too_large` |
| 풀 수 없는 본문, JSON이 아닌 평문 | 400 `invalid_params`. 로그 "relayed notification unreadable"(호스트 ID만) |
| 시험 알림, 모르는 종류 | 201, 보내지 않는다 |
| 터미널 알림 | 201. 주소·태그를 `<호스트 ID>`로 바꿔 그 종류를 켠 허브의 구독으로 보낸다 |

검사 순서는 표의 위에서 아래다. 비밀이 맞지 않으면 본문을 읽지 않는다. 중계 경로는 `requireDevice` 밖에 있다. 푸시 서비스 자리에서 보내는 호스트에는 허브 쿠키가 없고 Origin도 없기 때문이다. 비밀 경로 자체가 자격이므로 로그에 남기지 않는다(서버에는 요청 로그가 없고, 이 핸들러도 호스트 ID만 적는다). `POST`만 밖에 두므로 `GET /api/relay/…`는 여전히 `requireDevice`를 지나 401이다.

시험은 호스트 쪽 송신기로 `webpush-go`를 실제로 쓴다. 암호화와 헤더가 호스트의 운영 송신기(`push.NewWebPush`)와 같아야 시험이 뜻을 갖는다. 운영 송신기는 HTTP 클라이언트를 바꿀 수 없으므로, 시험의 `relaySender`가 같은 호출을 허브의 시험 인증서를 믿는 클라이언트로 한다.

- [ ] **Step 1: 실패하는 테스트**

`internal/server/auth_test.go` — 시험 환경이 https로도 뜨게 한다. import에 `"cmp"`를 더하고 `testEnv`와 `newTestEnv`를 아래로 바꾼다.

```go
type testEnv struct {
	t          *testing.T
	srv        *httptest.Server
	s          *Server
	auth       *auth.Auth
	store      *store.Store
	token      string       // the paired device's cookie, once pair has run
	httpClient *http.Client // nil: http.DefaultClient; an https env's trusts its certificate
}

func newTestEnv(t *testing.T, opts ...func(*Deps)) *testEnv {
	t.Helper()
	return startTestEnv(t, httptest.NewUnstartedServer(nil), false, opts...)
}

// startTestEnv serves a new server on srv, over TLS when useTLS is set. srv
// has not started, so a test knows its address before the server is made.
func startTestEnv(t *testing.T, srv *httptest.Server, useTLS bool, opts ...func(*Deps)) *testEnv {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	a := auth.New(st, auth.Options{})
	discard := slog.New(slog.DiscardHandler)
	d := Deps{Version: "test", HostName: "testhost", Store: st, Auth: a, UI: http.NotFoundHandler(), Logger: discard,
		Core: core.New(core.Options{Logger: discard})} // never started: the core is down
	for _, o := range opts {
		o(&d)
	}
	s := New(d)
	srv.Config.Handler = s.Handler()
	t.Cleanup(srv.Close) // after TempDir's, so it runs first: the server stops before its state goes
	e := &testEnv{t: t, srv: srv, s: s, auth: d.Auth, store: d.Store}
	if useTLS {
		srv.StartTLS()
		e.httpClient = srv.Client()
	} else {
		srv.Start()
	}
	return e
}
```

`doFrom`의 보내는 줄과 `tryWS`의 마지막 줄을 바꾼다. https 환경의 `e.srv.URL`은 `https://`로 시작하므로 `tryWS`의 `"ws"+strings.TrimPrefix(…, "http")`는 그대로 `wss://`가 된다.

```go
	res, err := cmp.Or(e.httpClient, http.DefaultClient).Do(req)
```

```go
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(e.srv.URL, "http")+path, &websocket.DialOptions{HTTPHeader: h, HTTPClient: e.httpClient})
```

`internal/server/push_test.go` — 보낸 알림의 내용을 읽을 수 있게 한다. import에 `"encoding/json"`을 더한다.

```go
// recordSender takes every message, or answers status when it is set.
type recordSender struct {
	mu     sync.Mutex
	sent   []string // endpoints
	bodies [][]byte // what was sent, before encryption
	status int
}

func (r *recordSender) Send(ctx context.Context, sub store.PushSub, payload []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, sub.Endpoint)
	r.bodies = append(r.bodies, payload)
	if r.status != 0 {
		return r.status, nil
	}
	return 201, nil
}

// payloads are the notifications sent so far, decoded.
func (r *recordSender) payloads(t *testing.T) []push.Payload {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	var ps []push.Payload
	for _, b := range r.bodies {
		var p push.Payload
		if err := json.Unmarshal(b, &p); err != nil {
			t.Fatal(err)
		}
		ps = append(ps, p)
	}
	return ps
}
```

`internal/server/relay_test.go`(새 파일):

```go
package server

import (
	"bytes"
	"cmp"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/peer"
	"github.com/kwonikhyeon/mori/internal/push"
	"github.com/kwonikhyeon/mori/internal/store"
)

// relaySender sends for real with webpush-go, as a host's notifier does,
// over client: a hub's relay endpoint plays the push service.
type relaySender struct {
	client *http.Client
	store  *store.Store // the sending host's, for its VAPID keys
}

func (r *relaySender) Send(ctx context.Context, sub store.PushSub, payload []byte) (int, error) {
	v := r.store.Get().VAPID
	res, err := webpush.SendNotificationWithContext(ctx, payload,
		&webpush.Subscription{Endpoint: sub.Endpoint, Keys: webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth}},
		&webpush.Options{HTTPClient: r.client, Subscriber: "https://github.com/kwonikhyeon/Mori", TTL: 60,
			Urgency: webpush.UrgencyHigh, VAPIDPublicKey: v.Public, VAPIDPrivateKey: v.Private})
	if err != nil {
		return 0, err
	}
	res.Body.Close()
	return res.StatusCode, nil
}

// logBuffer collects a server's log; slog may write from any goroutine.
type logBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *logBuffer) Write(p []byte) (int, error) { l.mu.Lock(); defer l.mu.Unlock(); return l.b.Write(p) }
func (l *logBuffer) String() string              { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

// withLog makes the server log into l. It goes before the options that
// hand the logger on.
func withLog(l *logBuffer) func(*Deps) {
	return func(d *Deps) { d.Logger = slog.New(slog.NewTextHandler(l, nil)) }
}

// relayKeys are what a hub keeps for one host's relay subscription.
type relayKeys struct {
	secret     string
	key        *ecdh.PrivateKey
	authSecret []byte
}

func newRelayKeys(t *testing.T) relayKeys {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	a := make([]byte, 16)
	rand.Read(a)
	return relayKeys{secret: rand.Text(), key: k, authSecret: a}
}

// relayTo gives the linked host id a relay subscription, as SetupRelay
// leaves it, and returns its keys.
func (e *testEnv) relayTo(id string) relayKeys {
	e.t.Helper()
	k := newRelayKeys(e.t)
	enc := base64.RawURLEncoding.EncodeToString
	if err := e.store.Update(func(st *store.State) error {
		for i := range st.Hosts {
			if st.Hosts[i].ID == id {
				st.Hosts[i].Link.Relay = store.Relay{Secret: k.secret, Key: enc(k.key.Bytes()), Auth: enc(k.authSecret),
					Base: "https://macmini.example.ts.net", OK: true}
				return nil
			}
		}
		return fmt.Errorf("no host %s", id)
	}); err != nil {
		e.t.Fatal(err)
	}
	return k
}

// captureClient keeps the request webpush-go would send instead of sending it.
type captureClient struct {
	req  *http.Request
	body []byte
}

func (c *captureClient) Do(req *http.Request) (*http.Response, error) {
	b, err := io.ReadAll(req.Body)
	c.req, c.body = req, b
	return &http.Response{StatusCode: http.StatusCreated, Body: http.NoBody}, err
}

// sealed is p encrypted to k, as a host's notifier sends it to the hub.
func sealed(t *testing.T, k relayKeys, p any) []byte {
	t.Helper()
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.RawURLEncoding.EncodeToString
	var c captureClient
	res, err := webpush.SendNotification(b, &webpush.Subscription{Endpoint: "https://macmini.example.ts.net/api/relay/" + k.secret,
		Keys: webpush.Keys{P256dh: enc(k.key.PublicKey().Bytes()), Auth: enc(k.authSecret)}},
		&webpush.Options{HTTPClient: &c, Subscriber: "https://github.com/kwonikhyeon/Mori", TTL: 60, VAPIDPublicKey: pub, VAPIDPrivateKey: priv})
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if got := c.req.Header.Get("Content-Encoding"); got != "aes128gcm" {
		t.Fatal("content encoding", got)
	}
	return c.body
}

// postRelay posts body to the relay endpoint as a push service does: no
// cookie, no Origin.
func (e *testEnv) postRelay(secret, encoding string, body []byte) *http.Response {
	e.t.Helper()
	req, err := http.NewRequest("POST", e.srv.URL+"/api/relay/"+secret, bytes.NewReader(body))
	if err != nil {
		e.t.Fatal(err)
	}
	if encoding != "" {
		req.Header.Set("Content-Encoding", encoding)
	}
	res, err := cmp.Or(e.httpClient, http.DefaultClient).Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { res.Body.Close() })
	return res
}

// TestHubRelaysHostNotifications runs two real servers: the hub links desk
// through its API, and a phone paired only with the hub opens desk's
// terminals and gets desk's approval request (spec §3 #158, #165~#167).
func TestHubRelaysHostNotifications(t *testing.T) {
	phone := &recordSender{}
	hubLog := &logBuffer{}
	hubSrv := httptest.NewUnstartedServer(nil)
	addr := hubSrv.Listener.Addr().String()
	hub := startTestEnv(t, hubSrv, true, withLog(hubLog), withPush(t, phone), func(d *Deps) {
		d.PublicURL = func() string { return "https://" + addr }
		d.Links = peer.New(peer.Options{Store: d.Store, PublicURL: d.PublicURL, Listen: addr,
			HostName: d.HostName, Version: d.Version, Logger: d.Logger})
	})
	hub.pair()
	hub.json("POST", "/api/push/subscriptions", map[string]any{
		"subscription": browserSubscription(t, "https://push.example.com/phone"), "kinds": []string{"blocked"}}, 201, nil)

	relay := &relaySender{client: hub.httpClient}
	desk := newTestEnv(t, func(d *Deps) { d.HostName = "desk"; relay.store = d.Store }, withPush(t, relay))

	pc := desk.auth.NewCode("")
	var v peer.View
	hub.json("POST", "/api/hosts", map[string]string{"url": desk.srv.URL, "code": pc.Code}, 201, &v)
	if !v.Linked || !v.Relay || v.RelayError != "" || v.Name != "desk" {
		t.Fatalf("%+v", v)
	}
	hub.s.d.Push.Wait()
	if phone.count() != 0 {
		t.Fatal("desk's test notification must stop at the hub")
	}

	// Through the hub, the phone works on desk.
	var hello struct {
		App, Host string
		Paired    bool
	}
	hub.json("GET", "/h/"+v.ID+"/api/hello", nil, 200, &hello)
	if hello.App != "mori" || hello.Host != "desk" || !hello.Paired {
		t.Fatalf("%+v", hello)
	}
	c := hub.dialWS("/h/" + v.ID + "/ws/events")
	ctx, cancel := context.WithTimeout(context.Background(), wsWait)
	defer cancel()
	_, b, err := c.Read(ctx)
	var snap struct{ Type string }
	if err != nil || json.Unmarshal(b, &snap) != nil || snap.Type != "snapshot" {
		t.Fatalf("%s %v", b, err)
	}

	// desk's terminal waits for approval: the phone hears it from the hub.
	desk.s.d.Push.OnChange(core.Change{Address: "t1",
		Old:   &hc.Terminal{Address: "t1", State: "live", Argv: []string{"claude"}, Status: &hc.Status{State: "working"}},
		New:   &hc.Terminal{Address: "t1", State: "live", Argv: []string{"claude"}, Turn: 1, Status: &hc.Status{State: "blocked", Msg: "Allow Bash?"}},
		Event: &hc.Event{Type: "status", Terminal: "t1", Data: json.RawMessage(`{}`)}})
	desk.s.d.Push.Wait() // desk's delivery ends once the hub has taken it
	hub.s.d.Push.Wait()
	want := []push.Payload{{Title: "desk · 승인 대기", Body: "claude — Allow Bash?", Tag: v.ID + "/t1", URL: "/#/h/" + v.ID + "/t/t1", Kind: "blocked"}}
	if got := phone.payloads(t); !slices.Equal(got, want) {
		t.Fatalf("%+v", got)
	}

	// desk revokes the hub: the phone sees desk unlinked, not itself logged out.
	secret := hub.store.Get().Hosts[0].Link.Relay.Secret
	ds := desk.auth.Devices()
	i := slices.IndexFunc(ds, func(d store.Device) bool { return d.Name == "testhost 허브" })
	if i < 0 {
		t.Fatalf("no hub device on desk: %+v", ds)
	}
	if err := desk.auth.Revoke(ds[i].ID); err != nil {
		t.Fatal(err)
	}
	if code := readUntilClosed(t, c); code != closeUnauthorized {
		t.Fatalf("close %d: desk's 4401 passes through", code)
	}
	if eb := hub.expectError("GET", "/h/"+v.ID+"/api/overview", nil, 409); eb.Error.Kind != "host_unlinked" {
		t.Fatal(eb)
	}
	var hosts []peer.View
	hub.json("GET", "/api/hosts", nil, 200, &hosts)
	if len(hosts) != 1 || hosts[0].Linked || hosts[0].Relay {
		t.Fatalf("%+v", hosts)
	}
	hub.json("GET", "/api/hello", nil, 200, &hello)
	if !hello.Paired {
		t.Fatal("the phone stays paired with the hub")
	}
	if n := len(desk.store.Get().PushSubs); n != 0 {
		t.Fatalf("%d subscriptions left on desk", n)
	}
	if res := hub.postRelay(secret, "aes128gcm", []byte("x")); res.StatusCode != 410 {
		t.Fatal(res.StatusCode)
	}
	if strings.Contains(hubLog.String(), secret) {
		t.Fatal("the relay secret is in the hub's log")
	}
}

// TestRelayEndpoint covers what a host's push may bring (spec §3 #166).
func TestRelayEndpoint(t *testing.T) {
	logs := &logBuffer{}
	phone := &recordSender{}
	e := newTestEnv(t, withLog(logs), withPush(t, phone), withLinks(nil))
	e.pair()
	e.json("POST", "/api/push/subscriptions", map[string]any{
		"subscription": browserSubscription(t, "https://push.example.com/phone"), "kinds": []string{"blocked", "exited"}}, 201, nil)
	id := e.linkHost("https://desk.example.ts.net")
	k := e.relayTo(id)
	terminal := push.Payload{Title: "desk · 종료", Body: "claude", Tag: "machine/t7", URL: "/#/t/machine%2Ft7", Kind: "exited"}

	for _, tc := range []struct {
		name, secret, encoding string
		body                   []byte
		status                 int
		kind                   string
	}{
		{"unknown secret", "unknown-relay-secret", "aes128gcm", sealed(t, k, terminal), 410, "not_found"},
		{"no encoding", k.secret, "", sealed(t, k, terminal), 400, "invalid_params"},
		{"old encoding", k.secret, "aesgcm", sealed(t, k, terminal), 400, "invalid_params"},
		{"too large", k.secret, "aes128gcm", bytes.Repeat([]byte{1}, maxRelayPush+1), 413, "too_large"},
		{"other keys", k.secret, "aes128gcm", sealed(t, newRelayKeys(t), terminal), 400, "invalid_params"},
		{"garbage", k.secret, "aes128gcm", bytes.Repeat([]byte{7}, 200), 400, "invalid_params"},
		{"test notification", k.secret, "aes128gcm",
			sealed(t, k, push.Payload{Title: "desk · 시험 알림", Body: "이 기기로 알림이 옵니다.", Tag: "mori-test", URL: "/"}), 201, ""},
		{"unknown kind", k.secret, "aes128gcm",
			sealed(t, k, push.Payload{Title: "desk · 파티", Tag: "t7", URL: "/#/t/t7", Kind: "party"}), 201, ""},
		{"kind the phone left off", k.secret, "aes128gcm",
			sealed(t, k, push.Payload{Title: "desk · 오류", Tag: "t7", URL: "/#/t/t7", Kind: "error"}), 201, ""},
	} {
		res := e.postRelay(tc.secret, tc.encoding, tc.body)
		if res.StatusCode != tc.status {
			t.Errorf("%s: %d, want %d", tc.name, res.StatusCode, tc.status)
			continue
		}
		if tc.kind != "" {
			if eb := decode[errorBody](t, res); eb.Error.Kind != tc.kind {
				t.Errorf("%s: %+v", tc.name, eb)
			}
		}
	}
	e.s.d.Push.Wait()
	if n := phone.count(); n != 0 {
		t.Fatalf("%d sent: none of these goes on", n)
	}

	if res := e.postRelay(k.secret, "aes128gcm", sealed(t, k, terminal)); res.StatusCode != 201 {
		t.Fatal(res.StatusCode)
	}
	e.s.d.Push.Wait()
	want := []push.Payload{{Title: "desk · 종료", Body: "claude", Tag: id + "/machine/t7", URL: "/#/h/" + id + "/t/machine%2Ft7", Kind: "exited"}}
	if got := phone.payloads(t); !slices.Equal(got, want) {
		t.Fatalf("%+v", got)
	}
	out := logs.String()
	if !strings.Contains(out, "relayed notification unreadable") || strings.Contains(out, k.secret) || strings.Contains(out, "unknown-relay-secret") {
		t.Fatal(out)
	}
}

// TestRelayEndpointWithout checks a server that links no hosts and one that
// sends no notifications. Only POST goes around requireDevice.
func TestRelayEndpointWithout(t *testing.T) {
	bare := newTestEnv(t)
	if res := bare.postRelay("anything", "aes128gcm", []byte("x")); res.StatusCode != 410 {
		t.Fatal(res.StatusCode)
	}
	if res := bare.do("GET", "/api/relay/anything", nil); res.StatusCode != 401 {
		t.Fatal(res.StatusCode)
	}
	e := newTestEnv(t, withLinks(nil))
	k := e.relayTo(e.linkHost("https://desk.example.ts.net"))
	res := e.postRelay(k.secret, "aes128gcm", sealed(t, k, push.Payload{Title: "desk · 승인 대기", Tag: "t1", URL: "/#/t/t1", Kind: "blocked"}))
	if res.StatusCode != 503 || decode[errorBody](t, res).Error.Kind != "unavailable" {
		t.Fatal(res.StatusCode)
	}
}
```

`TestHubRelaysHostNotifications`에서 desk의 이름은 `withPush`보다 먼저 정한다. 알림기가 그 이름으로 제목을 만든다. desk의 `Push.Wait()`가 끝나면 허브는 이미 `Forward`로 보낼 일을 맡았다. 허브의 중계 엔드포인트가 201로 답하기 전에 `Forward`가 `wg.Go`를 부르기 때문이다. 그래서 두 `Wait`를 차례로 부르면 폰의 알림까지 기다린다.

- [ ] **Step 2: 실패 확인**

Run: `go test ./internal/server -run 'TestHubRelaysHostNotifications|TestRelayEndpoint'`
Expected: FAIL — `undefined: maxRelayPush`로 컴파일되지 않는다.

- [ ] **Step 3: 구현**

`internal/server/api_relay.go`(새 파일):

```go
package server

import (
	"crypto/ecdh"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/kwonikhyeon/mori/internal/push"
)

// maxRelayPush is the most a relayed notification may be: webpush pads a
// message to a 4096-byte record (spec §3 #166).
const maxRelayPush = 8 << 10

// handleRelay takes a notification a linked host sent to this hub's relay
// subscription and sends it on to this hub's own subscriptions (spec §3 #166).
// It needs no cookie: the secret path is the credential, so it is never logged.
func (s *Server) handleRelay(w http.ResponseWriter, r *http.Request) {
	var (
		id         string
		key        *ecdh.PrivateKey
		authSecret []byte
		ok         bool
	)
	if s.d.Links != nil {
		id, key, authSecret, ok = s.d.Links.Relay(r.PathValue("secret"))
	}
	if !ok { // 410 makes the host's notifier forget the subscription
		writeError(w, errorf(http.StatusGone, "not_found", "그런 알림 중계가 없습니다"))
		return
	}
	if s.d.Push == nil {
		writeError(w, errorf(http.StatusServiceUnavailable, "unavailable", "이 서버는 알림을 보내지 않습니다"))
		return
	}
	if r.Header.Get("Content-Encoding") != "aes128gcm" {
		writeError(w, errorf(http.StatusBadRequest, "invalid_params", "중계 알림은 Content-Encoding: aes128gcm이어야 합니다"))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRelayPush))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, errorf(http.StatusRequestEntityTooLarge, "too_large", "중계 알림은 %d KiB까지입니다", maxRelayPush>>10))
			return
		}
		writeError(w, errorf(http.StatusBadRequest, "invalid_params", "중계 알림을 읽지 못했습니다"))
		return
	}
	plain, err := push.Decrypt(body, key, authSecret)
	var p push.Payload
	if err == nil {
		err = json.Unmarshal(plain, &p)
	}
	if err != nil {
		s.log.Info("relayed notification unreadable", "host", id)
		writeError(w, errorf(http.StatusBadRequest, "invalid_params", "중계 알림을 풀지 못했습니다"))
		return
	}
	if q, k, ok := push.Relayed(id, p); ok {
		s.d.Push.Forward(k, q)
	}
	w.WriteHeader(http.StatusCreated)
}
```

`internal/server/server.go`:

1. `routes`의 주석을 바꾼다.

```go
// routes puts every API and WebSocket behind requireDevice, but for the
// relay endpoint, whose secret path is its credential; the web UI itself is
// public.
```

2. Task 5가 더한 `s.mux.Handle("/h/", guarded)` 바로 뒤에 더한다.

```go
	s.mux.HandleFunc("POST /api/relay/{secret}", s.handleRelay) // outside requireDevice: a push service has no cookie
```

`POST /api/relay/{secret}`는 `/api/`보다 구체적이므로 먼저 걸린다. 다른 메서드와 한 마디가 아닌 경로는 `/api/`로 가서 `requireDevice`를 지난다.

- [ ] **Step 4: 통과 확인**

Run: `go test -race ./internal/server && go vet ./... && go test ./...`
Expected: PASS. `TestHubRelaysHostNotifications`의 연결이 `v.Relay == false`로 실패하면 `v.RelayError`를 본다. "시험 알림이 허브에 오지 않았습니다"면 desk의 `relaySender`가 허브 인증서를 믿는 `hub.httpClient`를 쓰는지 확인한다.

- [ ] **Step 5: 커밋**

```bash
git add internal/server
git commit -m "feat(server): 다른 호스트의 알림을 받아 중계한다

허브가 이은 호스트의 알림을 /api/relay/<비밀>로 받아 풀고, 주소를 /#/h/<ID>/…로 바꿔 허브의 구독으로 다시 보낸다(결정 165~167).

- 쿠키·Origin 없이 받고 비밀 경로는 로그에 남기지 않는다
- 모르는 비밀 410, 알림기 없음 503, 인코딩·본문 오류 400, 8 KiB 넘으면 413
- 시험 알림·모르는 종류는 201로 답하고 보내지 않는다
- 두 서버를 실제로 이어 폰이 허브만으로 다른 호스트의 승인 대기 알림을 받는 흐름을 시험한다

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 7: mori hosts — 관리 소켓으로 잇고 끊기 (단계 11)

**Files:**
- Modify: `internal/admin/admin.go` (`Request`, `Response`, `HostInfo`, `Handler`, `timeout`, `serveConn`, `handle`, `Client.Do`)
- Modify: `cmd/mori/main.go` (사용법, `hosts`, `parseFlags`)
- Modify: `cmd/mori/serve.go:106` (`peer.New`), `:115-128` (`Deps.Links`), `:149` (`adminHandler`), `:243-272` (메서드)
- Create: `cmd/mori/hostscmd.go`
- Test: `internal/admin/admin_test.go`, `cmd/mori/hostscmd_test.go`(새로), `cmd/mori/serve_test.go`, `cmd/mori/doctor_test.go`(`statusServer`, `serveAdmin`), `internal/service/service_test.go`(`fakeServer`)

**Interfaces:**
- Consumes: Task 3의 `peer.New(peer.Options) *peer.Manager`, `(*Manager).Views() []View`, `Link(ctx, rawURL, code, name string) (View, bool, error)`, `Lookup(idOrName string) (View, error)`, `Unlink(ctx, id string) (View, error)`, `peer.View{ID, Name, URL, Linked, Version, Relay, RelayError, LinkedMs}`. Task 4의 `Deps.Links`.
- Produces:

```go
type HostInfo struct{ ID, Name, URL string; Linked bool; Version string; Relay bool; RelayError string } // admin
// Request.URL, Request.Code; Response.Hosts []HostInfo, Response.Host *HostInfo, Response.Created bool
// admin.Handler += Hosts() []HostInfo
//                  LinkHost(ctx context.Context, rawURL, code, name string) (HostInfo, bool, error)
//                  UnlinkHost(ctx context.Context, idOrName string) (HostInfo, error)
const slowTimeout = 40 * time.Second                          // admin
func timeout(op string, base time.Duration) time.Duration     // admin
func runHosts(w io.Writer, args []string) error              // cmd/mori
func serveAdmin(t *testing.T, h admin.Handler) string        // cmd/mori test helper
// parseFlags: flags may come after the positional arguments; "[이름]" is optional
```

| 명령 | 관리 소켓 요청 | 출력 |
|---|---|---|
| `mori hosts` | `hosts` | ID·이름·주소·연결·알림·버전 표, 없으면 "이은 호스트가 없습니다. mori hosts link로 이으세요." |
| `mori hosts link <주소 또는 페어링 링크> [코드] [--name 이름]` | `link_host` | "호스트를 이었습니다: 이름 (주소)" 또는 "…다시 이었습니다…", 다음 줄에 중계 상태 |
| `mori hosts unlink <ID 또는 이름>` | `unlink_host` | "호스트를 끊었습니다: 이름 (주소)" |

모두 `--home`을 받는다. `link_host`와 `unlink_host`는 다른 호스트를 기다리므로 관리 소켓의 기한이 40초다(결정 169). 서버 쪽 ctx도 그 기한에 끝나고, 서버가 멈추면 함께 끝난다. 결정 169의 형태대로 옵션이 위치 인자 뒤에 와도 받도록 `parseFlags`를 고친다. 값을 받는 옵션의 값이 `--`인 경우(`--name --`)는 잘못 읽지만 받아들인다.

- [ ] **Step 1: 실패하는 테스트**

`internal/admin/admin_test.go` — import에 `"cmp"`를 더하고 `fakeHandler`에 메서드를 더한다.

```go
func (f *fakeHandler) Hosts() []HostInfo {
	return []HostInfo{{ID: "h_1", Name: "desk", URL: "https://desk.example.ts.net", Linked: true, Relay: true}}
}

// LinkHost fails unless the server gave it time to wait on the host.
func (f *fakeHandler) LinkHost(ctx context.Context, rawURL, code, name string) (HostInfo, bool, error) {
	if d, ok := ctx.Deadline(); !ok || time.Until(d) < 30*time.Second {
		return HostInfo{}, false, errors.New("a link needs 30 s")
	}
	if code != "ABCD-EFGH" {
		return HostInfo{}, false, errors.New("코드가 맞지 않습니다")
	}
	return HostInfo{ID: "h_1", Name: cmp.Or(name, "desk"), URL: rawURL, Linked: true}, true, nil
}

func (f *fakeHandler) UnlinkHost(ctx context.Context, idOrName string) (HostInfo, error) {
	if idOrName != "h_1" && idOrName != "desk" {
		return HostInfo{}, errors.New("no such host")
	}
	return HostInfo{ID: "h_1", Name: "desk", URL: "https://desk.example.ts.net"}, nil
}
```

`TestAdminRoundTrip`의 `status` 검사(93행) 바로 앞에 더한다. `r, err`는 80행의 것이다.

```go
	if r, err := c.Do(Request{Op: "hosts"}); err != nil || len(r.Hosts) != 1 || r.Hosts[0].ID != "h_1" || !r.Hosts[0].Relay {
		t.Fatal(r, err)
	}
	r, err = c.Do(Request{Op: "link_host", URL: "https://desk.example.ts.net", Code: "ABCD-EFGH", Name: "책상"})
	if err != nil || r.Host == nil || r.Host.Name != "책상" || !r.Created {
		t.Fatal(r, err)
	}
	if _, err := c.Do(Request{Op: "link_host", URL: "https://desk.example.ts.net", Code: "WXYZ-WXYZ"}); err == nil || err.Error() != "코드가 맞지 않습니다" {
		t.Fatal(err)
	}
	if r, err := c.Do(Request{Op: "unlink_host", ID: "desk"}); err != nil || r.Host == nil || r.Host.ID != "h_1" {
		t.Fatal(r, err)
	}
```

파일 끝에 더한다.

```go
func TestSlowOpsWaitLonger(t *testing.T) {
	if timeout("link_host", clientTimeout) != slowTimeout || timeout("unlink_host", connTimeout) != slowTimeout {
		t.Fatal("linking waits on another host")
	}
	if timeout("devices", clientTimeout) != clientTimeout {
		t.Fatal("other ops keep their deadline")
	}
}
```

`internal/service/service_test.go` — `fakeServer`의 `Shutdown` 뒤에 더한다(`context`는 이미 import돼 있다).

```go
func (f fakeServer) Hosts() []admin.HostInfo { return nil }
func (f fakeServer) LinkHost(context.Context, string, string, string) (admin.HostInfo, bool, error) {
	return admin.HostInfo{}, false, nil
}
func (f fakeServer) UnlinkHost(context.Context, string) (admin.HostInfo, error) { return admin.HostInfo{}, nil }
```

`cmd/mori/doctor_test.go` — `statusServer`의 주석과 메서드, `serveStatus`를 아래로 바꾼다. 지금 `statusServer` 위의 주석은 `serveStatus`의 것이었다.

```go
// statusServer answers status as a running server does. It links no hosts.
type statusServer struct{ st admin.Status }

func (s statusServer) PairCode(string) (string, string, time.Time) { return "", "", time.Time{} }
func (s statusServer) Devices() []admin.DeviceInfo                 { return nil }
func (s statusServer) Revoke(string) error                         { return nil }
func (s statusServer) Status() any                                 { return s.st }
func (s statusServer) Shutdown()                                   {}
func (s statusServer) Hosts() []admin.HostInfo                     { return nil }
func (s statusServer) LinkHost(context.Context, string, string, string) (admin.HostInfo, bool, error) {
	return admin.HostInfo{}, false, nil
}
func (s statusServer) UnlinkHost(context.Context, string) (admin.HostInfo, error) { return admin.HostInfo{}, nil }
```

```go
// serveStatus serves st as a running server's status and returns the state
// directory.
func serveStatus(t *testing.T, st admin.Status) string {
	t.Helper()
	return serveAdmin(t, statusServer{st})
}

// serveAdmin serves h on the admin socket of a new state directory, as a
// running server does, and returns the directory.
func serveAdmin(t *testing.T, h admin.Handler) string {
	t.Helper()
	home := shortHome(t)
	ln, err := admin.Listen(paths.Socket(home))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { admin.Serve(ctx, ln, h); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return home
}
```

`cmd/mori/serve_test.go` — import에 `"flag"`를 더한다. `TestParseFlagsPositional`의 표에 `{[]string{"d_1", "--home", "/x"}, true},`를 더하고, 시험을 하나 더한다.

```go
func TestParseFlagsLateAndOptional(t *testing.T) {
	fs := newFlagSet("revoke", "<기기 ID>")
	fs.SetOutput(io.Discard)
	home := fs.String("home", "", "")
	if err := parseFlags(fs, []string{"d_1", "--home", "/x"}, "기기 ID"); err != nil || *home != "/x" || fs.Arg(0) != "d_1" {
		t.Fatal(err, *home, fs.Args())
	}

	link := func(args ...string) (*flag.FlagSet, string, error) {
		fs := newFlagSet("hosts link", "[옵션] <주소 또는 페어링 링크> [코드]")
		fs.SetOutput(io.Discard)
		name := fs.String("name", "", "")
		err := parseFlags(fs, args, "주소 또는 페어링 링크", "[코드]")
		return fs, *name, err
	}
	fs, name, err := link("https://desk.example.ts.net", "ABCD-EFGH", "--name", "desk")
	if err != nil || fs.Arg(0) != "https://desk.example.ts.net" || fs.Arg(1) != "ABCD-EFGH" || name != "desk" {
		t.Fatal(err, fs.Args(), name)
	}
	fs, _, err = link("https://desk.example.ts.net/pair#code=ABCD-EFGH")
	if err != nil || fs.NArg() != 1 || fs.Arg(1) != "" {
		t.Fatal(err, fs.Args())
	}
	for _, args := range [][]string{{"a", "b", "c"}, {"--name", "desk"}} {
		if _, _, err := link(args...); !errors.Is(err, errUsage) {
			t.Errorf("%q: %v", args, err)
		}
	}
	if fs, _, err := link("--", "-d"); err != nil || fs.Arg(0) != "-d" {
		t.Fatal(err, fs.Args())
	}
}
```

`cmd/mori/hostscmd_test.go`(새 파일):

```go
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
```

- [ ] **Step 2: 실패 확인**

Run: `go test ./internal/admin ./cmd/mori ./internal/service`
Expected: FAIL — `undefined: HostInfo`, `undefined: timeout`, `undefined: runHosts`, `undefined: admin.HostInfo`로 컴파일되지 않는다.

- [ ] **Step 3: 구현**

`internal/admin/admin.go`:

1. `Request`와 `Response`를 아래로 바꾸고, `DeviceInfo` 뒤에 `HostInfo`를 더한다.

```go
// Request is one command, sent as one JSON line.
type Request struct {
	Op   string `json:"op"`             // pair, devices, revoke, hosts, link_host, unlink_host, status, shutdown
	Name string `json:"name,omitempty"` // pair: the device; link_host: the host
	ID   string `json:"id,omitempty"`   // revoke: a device ID; unlink_host: a host ID or name
	URL  string `json:"url,omitempty"`  // link_host: an origin or a pairing link
	Code string `json:"code,omitempty"` // link_host: the pairing code, when URL has none
}

// Response is the one JSON line that answers a Request.
type Response struct {
	Error     string          `json:"error,omitempty"`
	Code      string          `json:"code,omitempty"`
	URL       string          `json:"url,omitempty"`
	ExpiresMs int64           `json:"expires_ms,omitempty"`
	Devices   []DeviceInfo    `json:"devices,omitempty"`
	Hosts     []HostInfo      `json:"hosts,omitempty"`
	Host      *HostInfo       `json:"host,omitempty"`    // link_host, unlink_host
	Created   bool            `json:"created,omitempty"` // link_host: a new host, not a re-link
	Status    json.RawMessage `json:"status,omitempty"`
}
```

```go
// HostInfo is a host this hub links to (spec §3 #168), without its token.
type HostInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	Linked     bool   `json:"linked"`
	Version    string `json:"version,omitempty"`
	Relay      bool   `json:"relay"`
	RelayError string `json:"relay_error,omitempty"`
}
```

2. `Handler`를 아래로 바꾼다.

```go
// Handler does what the requests ask. Its methods run on the connection's
// goroutine. LinkHost and UnlinkHost get a context that ends with the
// request's deadline or the server.
type Handler interface {
	PairCode(name string) (code, url string, expires time.Time)
	Devices() []DeviceInfo
	Revoke(id string) error
	Hosts() []HostInfo
	LinkHost(ctx context.Context, rawURL, code, name string) (host HostInfo, created bool, err error)
	UnlinkHost(ctx context.Context, idOrName string) (HostInfo, error)
	Status() any
	Shutdown()
}
```

3. 상수에 `slowTimeout`을 더하고 그 뒤에 `timeout`을 둔다.

```go
const (
	connTimeout   = 10 * time.Second
	clientTimeout = 5 * time.Second
	// slowTimeout bounds link_host and unlink_host, which wait on another
	// host: linking takes up to 30 s (spec §3 #169).
	slowTimeout = 40 * time.Second
	maxRequest  = 64 << 10
)

// timeout is how long op may take: base, or slowTimeout for an op that
// waits on another host.
func timeout(op string, base time.Duration) time.Duration {
	if op == "link_host" || op == "unlink_host" {
		return slowTimeout
	}
	return base
}
```

4. `Serve`의 `go serveConn(c, h)`를 `go serveConn(ctx, c, h)`로 바꾸고, `serveConn`과 `handle`을 아래로 바꾼다.

```go
func serveConn(ctx context.Context, c net.Conn, h Handler) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(connTimeout))
	var req Request
	if err := json.NewDecoder(io.LimitReader(c, maxRequest)).Decode(&req); err != nil {
		json.NewEncoder(c).Encode(Response{Error: "요청을 읽지 못했습니다: " + err.Error()})
		return
	}
	limit := timeout(req.Op, connTimeout)
	c.SetDeadline(time.Now().Add(limit))
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	res, after := handle(ctx, h, req)
	json.NewEncoder(c).Encode(res)
	if after != nil {
		after() // shutdown answers first
	}
}

func handle(ctx context.Context, h Handler, req Request) (Response, func()) {
	switch req.Op {
	case "pair":
		code, url, exp := h.PairCode(req.Name)
		return Response{Code: code, URL: url, ExpiresMs: exp.UnixMilli()}, nil
	case "devices":
		return Response{Devices: h.Devices()}, nil
	case "revoke":
		if err := h.Revoke(req.ID); err != nil {
			return Response{Error: err.Error()}, nil
		}
		return Response{}, nil
	case "hosts":
		return Response{Hosts: h.Hosts()}, nil
	case "link_host":
		host, created, err := h.LinkHost(ctx, req.URL, req.Code, req.Name)
		if err != nil {
			return Response{Error: err.Error()}, nil
		}
		return Response{Host: &host, Created: created}, nil
	case "unlink_host":
		host, err := h.UnlinkHost(ctx, req.ID)
		if err != nil {
			return Response{Error: err.Error()}, nil
		}
		return Response{Host: &host}, nil
	case "status":
		b, err := json.Marshal(h.Status())
		if err != nil {
			return Response{Error: err.Error()}, nil
		}
		return Response{Status: b}, nil
	case "shutdown":
		return Response{}, h.Shutdown
	}
	return Response{Error: fmt.Sprintf("알 수 없는 요청 %q", req.Op)}, nil
}
```

5. `Client.Do`의 `conn.SetDeadline(time.Now().Add(clientTimeout))`를 `conn.SetDeadline(time.Now().Add(timeout(req.Op, clientTimeout)))`로 바꾼다.

`cmd/mori/main.go`:

1. import에 `"strings"`를 더한다.
2. 사용법의 `revoke` 줄 뒤에 `  hosts     이 허브에 이은 다른 호스트를 보고, 잇고, 끊습니다 (link, unlink)`를 더한다.
3. `switch cmd`의 `case "revoke":` 뒤에 더한다.

```go
	case "hosts":
		err = runHosts(os.Stdout, args)
```

4. `parseFlags`를 아래로 바꾼다.

```go
// parseFlags parses args, which must hold the named positional arguments;
// flags may come after them too. A name in brackets, such as "[코드]", is
// optional and goes last. Afterwards fs.Arg gives the positional arguments.
func parseFlags(fs *flag.FlagSet, args []string, positional ...string) error {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return err
			}
			return errUsage // the flag package has printed the problem and the usage
		}
		rest := fs.Args()
		if len(rest) == 0 {
			break
		}
		if n := len(args) - len(rest); n > 0 && args[n-1] == "--" { // all after -- is positional
			pos = append(pos, rest...)
			break
		}
		pos, args = append(pos, rest[0]), rest[1:]
	}
	required := 0
	for _, p := range positional {
		if !strings.HasPrefix(p, "[") {
			required++
		}
	}
	switch {
	case len(pos) > len(positional):
		fmt.Fprintf(fs.Output(), "mori %s: 알 수 없는 인자 %q\n", fs.Name(), pos[len(positional)])
		return errUsage
	case len(pos) < required:
		fmt.Fprintf(fs.Output(), "mori %s: <%s> 인자가 필요합니다\n", fs.Name(), positional[len(pos)])
		return errUsage
	}
	return fs.Parse(append([]string{"--"}, pos...)) // so that fs.Arg gives them
}
```

`cmd/mori/hostscmd.go`(새 파일):

```go
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
```

`cmd/mori/serve.go`:

1. import에 `"github.com/kwonikhyeon/mori/internal/peer"`를 더한다.
2. `host := hostName(tailscale.DNSName)`(106행) 바로 뒤에 더한다.

```go
	// links pairs this hub with other hosts; the API and the admin socket
	// share it (spec §6.9).
	links := peer.New(peer.Options{Store: st, PublicURL: pub, Listen: addr, HostName: host, Version: version.Version, Logger: logger})
```

3. `server.Deps{…}`의 `Push: notifier,` 뒤에 `Links: links,`를 더한다.
4. `adminHandler{auth: au, publicURL: pub, …}`(149행)를 `adminHandler{auth: au, links: links, logger: logger, publicURL: pub, …}`로 바꾼다.
5. `adminHandler` 구조체와 메서드를 고친다.

```go
// adminHandler answers the mori commands through the admin socket.
type adminHandler struct {
	auth      *auth.Auth
	links     *peer.Manager
	logger    *slog.Logger
	publicURL func() string
	status    func() any
	shutdown  func()
}
```

`Revoke` 뒤에 더한다.

```go
func (h adminHandler) Hosts() []admin.HostInfo {
	var out []admin.HostInfo
	for _, v := range h.links.Views() {
		out = append(out, hostInfo(v))
	}
	return out
}

func (h adminHandler) LinkHost(ctx context.Context, rawURL, code, name string) (admin.HostInfo, bool, error) {
	v, created, err := h.links.Link(ctx, rawURL, code, name)
	if err != nil {
		return admin.HostInfo{}, false, err
	}
	h.logger.Info("host linked", "host", v.ID, "url", v.URL, "relay", v.Relay)
	return hostInfo(v), created, nil
}

func (h adminHandler) UnlinkHost(ctx context.Context, idOrName string) (admin.HostInfo, error) {
	v, err := h.links.Lookup(idOrName)
	if err != nil {
		return admin.HostInfo{}, err
	}
	if v, err = h.links.Unlink(ctx, v.ID); err != nil {
		return admin.HostInfo{}, err
	}
	h.logger.Info("host unlinked", "host", v.ID, "url", v.URL)
	return hostInfo(v), nil
}

// hostInfo is what the admin socket says of v.
func hostInfo(v peer.View) admin.HostInfo {
	return admin.HostInfo{ID: v.ID, Name: v.Name, URL: v.URL, Linked: v.Linked, Version: v.Version, Relay: v.Relay, RelayError: v.RelayError}
}
```

이제 `mori serve`가 호스트 관리자를 만들어 API(`Deps.Links`)와 관리 소켓에 함께 준다. Task 4~6의 `/api/hosts`, `/h/<ID>`, `/api/relay/<비밀>`이 이 커밋부터 실제 서버에서 돈다.

- [ ] **Step 4: 통과 확인**

Run: `go test -race ./internal/admin ./cmd/mori ./internal/service && go vet ./... && go test ./...`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add internal/admin internal/service cmd/mori
git commit -m "feat(cli): mori hosts로 호스트를 잇고 끊는다

mori hosts가 이은 호스트를 보이고, link와 unlink가 관리 소켓으로 도는 서버에 잇고 끊기를 시킨다(결정 169). 연결은 다른 호스트를 기다리므로 40초까지 기다린다.

- mori hosts, mori hosts link <주소 또는 페어링 링크> [코드] [--name 이름], mori hosts unlink <ID 또는 이름>
- 위치 인자 뒤에도 옵션을 받는다
- 서버가 호스트 관리자를 만들어 API와 관리 소켓에 함께 준다

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 8: 허브 안내와 개발 프록시 (단계 11)

**Files:**
- Modify: `web/vite.config.ts` (`server.proxy`)
- Modify: `README.md:6`, `:9`, `:83`, `:84` 뒤(새 절 "여러 호스트를 한 앱에서"), `:100`, `:113` 뒤(명령 표), `:124-125`(보안), `:144-145`(개발)
- Modify: `docs/superpowers/specs/2026-11-08-mori-design.md:3`(상태 줄), `:659`(§12 단계 11 상태), 아래 "스펙 반영"의 자리

**Interfaces:**
- Consumes: Task 4~7의 `/api/hosts`, `/h/<ID>/…`, `/api/relay/<비밀>`, `mori hosts`·`hosts link`·`hosts unlink`(출력 "호스트를 이었습니다: <이름> (<주소>)", "알림 중계는 꺼져 있습니다: <이유>", "호스트를 끊었습니다: <이름> (<주소>)")
- Produces: 개발 서버의 `/h/` 프록시(Task 10이 쓴다). 코드 인터페이스는 없다.

바뀌는 코드가 개발 서버 설정뿐이라 실패하는 테스트는 없다. 웹 테스트와 빌드가 그대로 도는지 보고, 실제 `mori serve` 두 개로 잇기, 허브를 거친 세션 열기와 입력, 끊기를 손으로 확인한다.

- [ ] **Step 1: 개발 프록시**

`web/vite.config.ts`의 `server.proxy`:

```ts
    proxy: {
      '/api': { target: 'http://127.0.0.1:7761', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:7761', ws: true, changeOrigin: false },
      // A linked host's API and sockets, relayed by the server (spec §3
      // #161). The key ends in a slash so that only /h/<ID>/… goes there.
      '/h/': { target: 'http://127.0.0.1:7761', ws: true, changeOrigin: false },
    },
```

키는 `'/h'`가 아니라 `'/h/'`다. Vite는 키를 경로의 앞부분으로 맞추므로 `'/h'`면 `/h`로 시작하는 다른 경로까지 서버로 간다. 한 키가 REST와 소켓을 함께 넘기도록 `target`은 `http://`에 `ws: true`다.

- [ ] **Step 2: 웹 확인**

Run: `make test-web && make web`
Expected: PASS, 빌드 성공. 개발 서버는 띄우지 않는다. 7761에는 서비스로 도는 실제 서버가 있을 수 있다.

- [ ] **Step 3: README**

1. 6행(머리 글머리)을 바꾼다.

```markdown
- **호스트마다 Mori 하나, 폰에는 앱 하나:** 세션을 돌릴 컴퓨터마다 Mori를 설치합니다. 폰은 그중 하나(허브)에만 페어링하고, 허브가 이은 다른 호스트의 세션과 알림을 함께 다룹니다. 한 호스트가 꺼져도 나머지는 계속 돕니다.
```

2. 9행(배너)을 바꾼다.

```markdown
> 단계 11(여러 호스트를 한 앱에서)의 서버와 명령까지 만들었습니다. 허브의 화면에서 다른 호스트를 여는 것은 화면 후보를 고른 뒤 만듭니다. 실제 기기에서 확인할 것(iPhone 홈 화면 앱의 입력과 알림, Windows 호스트, 에이전트의 상태 보고)은 [설계](docs/superpowers/specs/2026-11-08-mori-design.md) §13과 §15에 남아 있습니다.
```

3. 83행(기기 페어링)을 바꾼다.

```markdown
- 페어링, 홈 화면 추가, 알림 켜기는 주소(origin)마다 따로 합니다. 호스트가 여럿이면 폰은 허브 하나에만 하고, 나머지 호스트는 허브에 잇습니다(아래 "여러 호스트를 한 앱에서").
```

4. 84행 뒤, `## 업데이트와 제거` 앞에 새 절을 넣는다.

````markdown
## 여러 호스트를 한 앱에서

폰에는 Mori 하나(허브)만 홈 화면에 추가하고 페어링합니다. 허브에 다른 호스트를 이어 두면 폰은 허브의 앱 하나로 그 호스트들의 세션을 열고 입력하며, 알림도 허브에서 받습니다. 어느 Mori든 다른 호스트를 이으면 허브가 됩니다.

1. 이을 호스트에서 페어링 코드를 만듭니다. 그 호스트에서 `mori pair`를 실행하거나, 그 호스트의 설정에서 "새 기기 페어링"의 "코드 만들기"를 누릅니다.
2. 허브에서 그 링크로, 또는 주소와 코드로 잇습니다.

   ```sh
   mori hosts link 'https://desk.<tailnet>.ts.net/pair#code=ABCD-EFGH'
   mori hosts link https://desk.<tailnet>.ts.net ABCD-EFGH --name 책상
   mori hosts                # 이은 호스트: ID, 이름, 주소, 연결, 알림, 버전
   mori hosts unlink 책상     # ID나 이름으로 끊습니다
   ```

- 페어링 링크는 따옴표로 감쌉니다. zsh에서 `extended_glob`을 켰다면 `#`이 glob 문자가 됩니다.
- 이은 호스트의 기기 목록에는 허브가 "<허브 이름> 허브"로 보입니다. 거기서 철회하면 그 호스트와의 연결만 끊기고, 허브는 그 호스트를 "끊김"으로 둡니다. 새 코드로 다시 이으면 ID와 이름은 그대로입니다. 예전에 설정의 "다른 호스트"에 넣은 호스트도 "끊김"으로 남아 있다가 같은 방법으로 이어집니다.
- 허브에서 폰을 철회하면 그 폰은 허브를 거쳐 어느 호스트에도 닿지 못합니다.
- **알림:** 허브의 주소가 https(`tailscale serve`)면 허브가 이은 호스트의 알림을 구독해 폰으로 중계합니다. 폰은 허브의 알림만 켜면 되고, 알림을 누르면 그 호스트의 터미널이 열립니다. `mori hosts`의 알림 칸이 "끔"이면 `mori hosts link`가 이유를 보여 줍니다. 허브의 주소가 바뀌면 중계가 꺼지므로 새 코드로 다시 잇습니다.
- 허브와 이은 호스트의 버전이 달라도 됩니다. 허브의 화면이 그 호스트에 없는 기능을 부르면 그 화면만 오류를 보입니다. `mori hosts`의 버전은 이을 때 읽은 것입니다.
- 이은 호스트도 제 주소로 그대로 열립니다. 허브가 꺼져 있을 때 그 주소로 직접 열려면 폰을 그 호스트에도 페어링해 두어야 합니다.
````

5. 100행(알아 둘 것)의 "`state.json`(폴더, 프리셋, 기기, 알림 구독과 키)"를 "`state.json`(폴더, 프리셋, 기기, 알림 구독과 키, 이은 호스트)"로 바꾼다.

6. 113행(`mori pair` / `devices` / `revoke`) 뒤에 명령 표의 줄을 넣는다.

```markdown
| `mori hosts` / `hosts link` / `hosts unlink` | 허브에 이은 호스트를 보고, 잇고, 끊습니다(`--home`, `hosts link`는 `--name`) |
```

7. 124행(코어 보호) 뒤에 두 줄을 넣는다.

```markdown
- **허브:** 허브에 페어링한 기기는 허브가 이은 모든 호스트에 닿습니다. 허브는 정해진 API와 WebSocket만 넘기고(그 밖은 404), 폰의 쿠키 대신 그 호스트가 허브에 준 기기 토큰을 씁니다. 그 호스트의 쿠키와 보안 헤더는 폰에 넘기지 않습니다. 한 호스트만 떼려면 그 호스트에서 허브를 철회합니다.
- **알림 중계:** 이은 호스트가 보내는 알림(`/api/relay/<비밀>`)은 쿠키 없이 받습니다. 대신 경로의 256비트 비밀이 맞고 본문이 허브의 키로 풀려야 하며(RFC 8291), 그 경로는 로그에 남기지 않습니다.
```

8. 125행(로컬 파일)의 "`state.json`에는 알림 서명 키(VAPID 개인 키)와 토큰 해시가 들어 있습니다."를 "`state.json`에는 알림 서명 키(VAPID 개인 키)와 토큰 해시가, 허브라면 이은 호스트마다 그 호스트의 기기 토큰(해시가 아닌 값)과 알림 중계 키가 들어 있습니다."로 바꾼다.

9. 144행의 "`/api`와 `/ws`는 서버로 넘어갑니다."를 "`/api`, `/ws`, `/h/`(이은 호스트)는 서버로 넘어갑니다."로, 145행의 "구현 계획은 [백엔드](docs/superpowers/plans/2026-11-09-mori-backend-v1.md)와 [웹 UI](docs/superpowers/plans/2026-11-09-mori-web-ui.md)에 있습니다."를 "구현 계획은 [백엔드](docs/superpowers/plans/2026-11-09-mori-backend-v1.md), [웹 UI](docs/superpowers/plans/2026-11-09-mori-web-ui.md), [여러 호스트](docs/superpowers/plans/2026-11-10-mori-multi-host.md)에 있습니다."로 바꾼다.

"화면" 절(다른 호스트로 가는 링크)은 그대로 둔다. Task 10이 새 화면에 맞춰 고친다.

- [ ] **Step 4: 두 Mori로 확인**

저장소 루트의 한 셸에서 차례로 실행한다. 두 서버는 `.dev/test/hubdesk`(이을 호스트, 7771)와 `.dev/test/hubhub`(허브, 7772)의 격리 hc 환경에서 돈다. `--public-url`을 꼭 준다. 없으면 공개 주소가 이 컴퓨터의 Tailscale 이름(https)이 되어, 허브가 그 주소에서 도는 실제 서버로 중계를 구독하려 하고 페어링 링크에 실제 tailnet 이름이 들어간다.

```sh
R=$(git rev-parse --show-toplevel)
make -C "$R" build
# iso <id> <명령…>: .dev/test/<id>의 격리 hc 환경에서 돌린다. make test-clean이 같은 모양으로 치운다.
iso() {
  local id=$1; shift
  local a=$R/.dev/test/$id
  mkdir -p -m 700 "$a" "$a/state" "$a/config" "$a/run"
  env -u HC_TERMINAL_ID HC_SESSION=mori-test-$id XDG_STATE_HOME="$a/state" XDG_CONFIG_HOME="$a/config" \
    XDG_RUNTIME_DIR="$a/run" HC_SOCKET="$a/c.sock" "$@"
}
iso hubdesk true && iso hubhub true
K=$R/.dev/test/hubdesk/home; H=$R/.dev/test/hubhub/home
iso hubdesk "$R/bin/mori" serve --home "$K" --listen 127.0.0.1:7771 --public-url http://127.0.0.1:7771 \
  >"$R/.dev/test/hubdesk/serve.log" 2>&1 &
iso hubhub "$R/bin/mori" serve --home "$H" --listen 127.0.0.1:7772 --public-url http://127.0.0.1:7772 \
  >"$R/.dev/test/hubhub/serve.log" 2>&1 &
curl -fs --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null http://127.0.0.1:7771/api/hello
curl -fs --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null http://127.0.0.1:7772/api/hello
```

1. 허브가 페어링 링크로 잇는다. 그 호스트의 기기 목록에 남는 이름은 허브가 보낸 "<허브 호스트 이름> 허브"다(`mori pair --name`보다 앞선다).

```sh
link=$(iso hubdesk "$R/bin/mori" pair --home "$K" | awk '$1=="링크"{print $2}')
echo "$link"                                              # http://127.0.0.1:7771/pair#code=XXXX-XXXX
iso hubhub "$R/bin/mori" hosts link --home "$H" "$link" --name desk
```

Expected:

```
호스트를 이었습니다: desk (http://127.0.0.1:7771)
알림 중계는 꺼져 있습니다: 허브 주소가 https가 아니라 알림을 중계할 수 없습니다
```

2. 목록과 그 호스트의 기기를 본다.

```sh
iso hubhub "$R/bin/mori" hosts --home "$H"                # ID 이름 주소 연결 알림 버전 / h_… desk http://127.0.0.1:7771 연결됨 끔 <버전>
iso hubdesk "$R/bin/mori" devices --home "$K"             # "<이 컴퓨터의 호스트 이름> 허브"가 보인다
```

3. 폰 대신 curl을 허브에 페어링한다. 기기 쿠키는 `Secure`라 curl의 쿠키 저장소가 http로 돌려보내지 않으므로 헤더에서 직접 꺼낸다.

```sh
code=$(iso hubhub "$R/bin/mori" pair --home "$H" | awk '$1=="코드"{print $2}')
tok=$(curl -s -D - -o /dev/null -H 'Origin: http://127.0.0.1:7772' -H 'Content-Type: application/json' \
  -d "{\"code\":\"$code\",\"name\":\"curl\"}" http://127.0.0.1:7772/api/pair | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p')
id=$(iso hubhub "$R/bin/mori" hosts --home "$H" | awk 'NR==2{print $1}')
c() { curl -s -H "Cookie: $tok" -H 'Origin: http://127.0.0.1:7772' -H 'Content-Type: application/json' "$@"; }
B=http://127.0.0.1:7772/h/$id
```

4. 허브를 거쳐 그 호스트의 세션을 열고 입력한다.

```sh
c "$B/api/hello" | jq -c '{app, host, paired}'           # {"app":"mori","host":"<호스트 이름>","paired":true}
mkdir -p "$R/.dev/test/hubdesk/work"
fid=$(c -d "{\"path\":\"$R/.dev/test/hubdesk/work\"}" "$B/api/folders" | jq -r .id)
addr=$(c -d "{\"folder_id\":\"$fid\",\"preset\":\"shell\"}" "$B/api/terminals" | jq -r .address)
ea=$(jq -rn --arg a "$addr" '$a|@uri')                   # 주소의 /는 %2F로
c -d '{"text":"echo via-hub"}' "$B/api/terminals/$ea/send" | jq -c .
c "$B/api/terminals/$ea/text" | grep -c via-hub          # 1 이상
c "$B/api/devices" -o /dev/null -w '%{http_code}\n'     # 404: 허용 목록 밖
```

5. 로그에 토큰이 없는지 본다. 허브가 그 호스트에서 받은 토큰과 curl의 허브 토큰이다.

```sh
ht=$(jq -r '.hosts[0].link.token' "$H/state.json")
grep -c -F -e "$ht" -e "${tok#*=}" "$R"/.dev/test/hub*/serve.log    # 두 파일 모두 :0
```

6. 끊는다.

```sh
iso hubhub "$R/bin/mori" hosts unlink --home "$H" "$id"   # 호스트를 끊었습니다: desk (http://127.0.0.1:7771)
iso hubdesk "$R/bin/mori" devices --home "$K"             # "… 허브"가 없다
c "$B/api/hello" -o /dev/null -w '%{http_code}\n'        # 404
```

7. 치운다.

```sh
pkill -f "$K"; pkill -f "$H"
make -C "$R" test-clean                                   # stopped hubdesk, stopped hubhub
```

어느 단계라도 기대와 다르면 커밋하지 않고 해당 태스크의 코드로 돌아가 고친다. 고친 것은 그 태스크의 테스트에 먼저 넣는다. 서버 로그와 `state.json`은 저장소에 옮기지 않는다.

- [ ] **Step 5: 스펙**

1. 3행(상태 줄)의 "단계 11(여러 호스트를 한 앱에서) 설계 (2026-11-10)"를 "단계 11(여러 호스트를 한 앱에서) 서버와 명령 구현, 화면은 후보 고르기 (2026-11-10)"로 바꾼다.
2. 659행(§12 단계 11 상태)을 바꾼다. 커밋하는 날이 다르면 날짜를 그날로 쓴다.

```markdown
단계 11 상태(2026-11-10): 허브의 중계(`/h/<ID>/…`), 알림 중계 받기(`/api/relay/<비밀>`), 호스트 API(`/api/hosts`), `mori hosts`를 만들었다(결정 158~169, 171). 한 프로세스에 TLS 허브와 호스트를 띄운 통합 테스트로 중계한 요청과 소켓, 알림 중계를 확인했고, 격리 코어 두 개에 `mori serve`를 하나씩 띄워 잇기, 허브를 거친 세션 열기와 입력, 끊기를 확인했다. 호스트를 보이고 고르는 화면(결정 170)은 후보를 만들어 사용자가 고른다. 계획은 `docs/superpowers/plans/2026-11-10-mori-multi-host.md`다.
```

3. 아래 "스펙 반영"의 항목을 그 자리에 넣는다.

- [ ] **Step 6: 커밋**

스테이징한 diff를 비밀 패턴으로 훑는다(Global Constraints). `<tailnet>`과 `example.ts.net`이 아닌 `.ts.net`이 없어야 하고, `secret`·`token`이 걸린 줄은 하나씩 본다.

```bash
git add web/vite.config.ts README.md docs/superpowers/specs/2026-11-08-mori-design.md
git diff --cached | grep -n -E '\.ts\.net|claude\.ai/artifact|BEGIN (RSA|OPENSSH|EC) PRIVATE|api[_-]?key|secret|password|token=' | grep -v -E 'example\.ts\.net|<tailnet>\.ts\.net'
git commit -m "docs: 여러 호스트 허브 안내

README에 허브 하나로 여러 호스트를 쓰는 법(mori hosts, 알림 중계, 보안)을 쓰고, 개발 서버가 /h/도 서버로 넘기게 한다. 구현하며 정한 것을 스펙에 옮기고 단계 11 상태를 적는다.

- README: 여러 호스트를 한 앱에서, 명령 표, 보안의 허브와 알림 중계
- vite: /h/ 프록시(REST와 WebSocket)
- 스펙: 결정 161~166, 169의 세부, §13의 중계 테스트, §12 단계 11 상태

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 9: 여러 호스트 화면 후보 (단계 11)

**Files:** 없음. 후보는 디자인 캔버스에 둔다(결정 103). 캔버스 주소는 공개 저장소에 넣지 않고 대화로만 알린다.

**Interfaces:**
- Consumes: Task 4의 호스트 뷰 `{id, name, url, linked, version, relay, relay_error?, linked_ms?}`, Task 4의 `/api/hosts` 요청들, 결정 163·164의 오류(409 `host_unlinked`, 502 `host_unreachable`, 소켓 4401·4404·4502), 결정 170의 주소 `#/h/<ID>/…`
- Produces: 사용자가 고른 후보(와 고칠 점). Task 10이 그것으로 단계를 쓴다.

- [ ] **Step 1: 캔버스와 공통 바탕**

새 디자인 캔버스 하나를 연다. 이 하네스에서는 Artifact 도구의 `quickstart`(intent `design`)로 시작한다. 단계 9의 캔버스는 Artifact `list`로 찾아 후보 B(지금 화면)의 색, 글꼴, 간격, 카드 모양을 가져온다. 밝은 카드와 어두운 터미널, 다크 모드(결정 118)를 그대로 쓴다.

세 후보는 같은 가짜 데이터로 배치만 비교한다. 주소는 `example.ts.net`만 쓴다.

| 호스트 | 주소 | 상태 | 폴더와 세션 |
|---|---|---|---|
| macmini(허브, 이 폰이 페어링한 곳) | `https://macmini.example.ts.net` | 허브 | Mori(Claude Code 작업 중), TopoMind(셸) |
| desk(Windows) | `https://desk.example.ts.net` | 연결됨, 알림 켬, 0.11.0 | api-server(Claude Code 승인 대기 "Bash: npm test", Codex 입력 대기) |
| lab | `https://lab.example.ts.net` | 끊김(그 호스트에서 허브를 철회), 0.10.2 | 보이지 않음 |

- [ ] **Step 2: 후보 A·B·C**

캔버스에 후보마다 페이지 하나를 둔다. 후보마다 PC 화면 하나(desk의 승인 대기 터미널을 연 상태)와 폰 화면 다섯 개를 밝은 모드로 그리고, PC 화면과 폰의 첫 화면은 어두운 모드로 한 번 더 그린다.

폰 화면 다섯 개:
1. 첫 화면(지금 볼 것): 여러 호스트의 대기가 어떻게 보이는가.
2. 호스트 고르기: 다른 호스트로 가는 자리와 호스트마다의 대기 수.
3. 다른 호스트의 터미널: 알림을 눌러 연 desk의 터미널(`#/h/<ID>/t/<주소>`). 머리글에 어느 호스트인지 보인다.
4. 설정의 호스트 카드: 잇기(페어링 링크, 또는 주소와 코드, 이름), 호스트마다 연결·알림·버전, 이름 바꾸기(1~100자), 끊기, "알림 다시 연결"(`relay_error`가 있을 때).
5. 문제 상태: lab의 "연결이 끊겼습니다"(409, 새 코드로 다시 잇기), desk에 닿지 못할 때의 "닿지 못했습니다"(502·4502, 다시 시도), 중계 소켓이 4401로 닫혔을 때 허브의 `paired`로 가른 두 결과(이 기기의 페어링이 풀림 → 페어링 화면, 그 호스트만 끊김 → 5의 끊김 표시).

후보:
- **A 호스트 전환:** 한 번에 한 호스트를 본다. 폰은 머리글의 호스트 이름을 누르면 호스트 목록 시트가 열리고, PC는 헤더에 호스트 선택이 있다. 지금 볼 것과 폴더는 고른 호스트의 것만 보이고, 다른 호스트의 승인 대기 수는 전환 버튼의 배지로 보인다.
- **B 통합 지금 볼 것:** 지금 볼 것이 모든 호스트의 세션을 한 목록에 묶고 줄마다 호스트 칩을 단다. 폴더 탭은 호스트별 소제목으로 묶는다. 새 세션은 호스트를 먼저 고른다. 끊긴 호스트는 목록 맨 아래 한 줄로 보인다.
- **C 호스트별 묶음:** 호스트가 맨 위 묶음이다. PC 사이드바는 호스트 > 폴더 > 세션의 나무이고, 폰의 첫 화면은 호스트 카드 목록(호스트마다 대기 배지)이며, 누르면 그 호스트의 지금 볼 것과 폴더로 간다.

- [ ] **Step 3: 사용자에게 보이고 기다린다**

캔버스 링크와 후보마다 두세 줄의 장단점을 대화로 알린다. 섞거나 고칠 점도 받는다고 덧붙인다. 여기서 멈추고, 사용자가 고르기 전에는 Task 10을 시작하지 않는다. 이 태스크는 커밋하지 않는다.

---

### Task 10: 여러 호스트 화면 구현 (단계 11, Task 9의 선택 뒤)

**Files:** Task 9의 선택에 따라 정한다. 선택과 상관없이 바뀌는 것: `web/src/lib/{api,store,events,router,boot,hosts}.ts`, `web/src/views/SettingsEdit.tsx`, 그 테스트, `README.md`의 "화면" 절, 스펙 §12.

**Interfaces:**
- Consumes: Task 4의 `/api/hosts`·호스트 뷰, Task 5의 `/h/<ID>/api/…`·`/h/<ID>/ws/…`와 오류, Task 6의 알림 `url` `/#/h/<ID>/t/<주소>`, Task 8의 개발 프록시 `/h/`
- Produces: 여러 호스트 화면

선택과 상관없이 정해진 것:

1. **호스트 앞머리:** `web/src/lib/api.ts`의 `request`와 `wsURL`이 호스트 앞머리를 받는다. 허브 자신은 `''`, 이은 호스트는 `/h/<ID>`다. 지금의 `api` 객체를 앞머리로 만드는 함수로 바꾸고, 허브의 것은 지금 이름 그대로 둔다. 중계 요청에는 그 호스트의 401이 오지 않으므로(허브가 409로 바꾼다), 페어링 화면으로 가는 401은 허브 자신의 것뿐이다.
2. **호스트마다 상태:** `store.ts`의 신호(`terminals`, `folders`, `core`, `conn`, `ready`, `host`, `presets`)를 호스트마다 한 벌씩 둔다. 이벤트 스트림(`EventStream`)도 호스트마다 `/h/<ID>/ws/events`로 하나씩 연다(결정 170). 호스트 목록(`hosts`)은 허브의 것만 쓰고, 이은 호스트의 overview에 있는 `hosts`는 버린다.
3. **경로:** `router.ts`의 `Route`에 `host?: string`(이은 호스트의 ID, 없으면 허브)을 더한다. `href`는 앞에 `#/h/<ID>`를 붙이고 `parseHash`는 `#/h/<ID>/…`를 읽는다. 허브의 경로(결정 121)는 그대로다. 테스트: `parseHash('#/h/h_1/t/machine%2Ft7')`가 `{ name: 'terminal', addr: 'machine/t7', git: false, host: 'h_1' }`이고, `href`가 그것을 같은 해시로 되돌린다. `#/h/`나 `#/h/h_1/모르는것`은 그 호스트의 지금 볼 것이 아니라 지금처럼 허브의 지금 볼 것이다.
4. **4401:** 중계 소켓이 4401로 닫히면 허브의 `GET /api/hello`를 불러, `paired`가 false면 페어링 화면으로 가고 true면 그 호스트만 끊김으로 보인다(결정 164). 4404는 없는 호스트이고, 4502는 닿지 않음이라 다시 붙는다.
5. **오류:** `ApiError.kind`가 `host_unlinked`(409)면 그 호스트의 화면에 끊김과 다시 잇기를, `host_unreachable`(502)면 닿지 못함과 다시 시도를 보인다. 그 호스트에 없는 API의 오류는 그 화면에만 보인다(결정 171).
6. **설정의 호스트 카드:** Task 4의 읽기 전용 카드를 바꾼다. 잇기 `POST /api/hosts {url, code?, name?}`(201 새로, 200 다시 이음), 이름 `PATCH /api/hosts/{id} {name}`(1~100자), 끊기 `DELETE /api/hosts/{id}`(204), 알림 다시 연결 `POST /api/hosts/{id}/relay`. 호스트마다 연결, 알림(`relay`, 꺼졌으면 `relay_error`), 버전을 보인다.
7. **알림 누르기:** 서비스 워커는 페이로드의 `url`을 연다. `main.tsx`가 같은 출처의 해시를 그대로 넣으므로, 3의 경로 테스트가 `#/h/<ID>/t/<주소>`를 받는지가 이 확인이다.
8. **확인과 문서:** `make test-web`, `make web`, 그리고 단계 10처럼 격리 코어와 헤드리스 Chrome으로 PC·폰, 밝은·어두운 모드의 화면을 본다(이은 호스트는 Task 8 Step 4의 두 서버). README의 "화면" 절과 스펙 §12의 단계 11 상태를 고친다.

- [ ] **Step 1: 선택을 계획에 쓴다**

사용자의 선택과 고칠 점을 받아, 이 태스크 아래에 화면 단위의 태스크(10a, 10b, …)를 이 계획의 형식(실패하는 테스트, 실패 확인, 구현, 통과 확인, 커밋)으로 쓴다. 위 1~8은 그 안에 들어간다. 계획을 커밋하고 푸시한 뒤 구현한다.

```bash
git add docs/superpowers/plans/2026-11-10-mori-multi-host.md
git commit -m "docs: 여러 호스트 화면 계획

Task 9에서 고른 후보로 여러 호스트 화면의 태스크를 쓴다(결정 170).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

## 스펙 반영 (구현 중 확정)

Task 8의 커밋에서 스펙을 고친다. 결정은 그 줄의 결정 칸 끝에 붙이고, 절은 그 절에 한 줄로 넣는다.

- §3 #161, §7.1 (Task 4·5): `/h/`는 서버에 호스트 관리자(`Deps.Links`)가 없어도 늘 등록한다. 그때 중계 요청은 503 `unavailable`, 중계 소켓은 4404이고, `GET /api/hosts`는 목록만 주며 나머지 호스트 API는 503이다.
- §3 #162 (Task 5): 업그레이드 헤더는 소켓 경로에서만 넘긴다. 길이를 밝힌 10 MiB 넘는 본문은 그 호스트에 보내지 않고, 길이를 모르는 본문은 10 MiB에서 끊는다. 둘 다 413 `too_large`다.
- §3 #163, §6.10 (Task 5): 502는 응답 헤더를 보내기 전에만 답한다. 헤더 뒤에 그 호스트가 끊기면 허브는 폰의 연결을 끊는다. 그 호스트가 401을 주면 허브는 그 호스트의 토큰과 중계 정보를 지워 `linked: false`로 두고, 다시 이을 때까지 409로 답한다.
- §3 #164 (Task 5): 그 호스트가 허브를 철회했으면 그 호스트가 업그레이드를 받고 4401로 닫으므로 허브는 그 4401을 그대로 전한다. 허브가 그 호스트를 `linked: false`로 두는 것은 REST 요청이 401을 받을 때다. 거절하는 소켓의 종료 이유는 123바이트 안에서 글자 경계로 자른다.
- §3 #166 (Task 6): 검사 순서는 비밀, 알림기, `Content-Encoding`, 크기, 풀기와 JSON이다. 모르는 비밀(호스트 관리자가 없거나 그 호스트가 끊긴 때도)은 본문을 읽지 않고 410 `not_found`이며, 그 호스트의 알림기는 410을 받으면 그 구독을 지운다. 8 KiB를 넘으면 413 `too_large`다. `GET /api/relay/…`는 기기 검사를 지나므로 401이다.
- §3 #169, §11 (Task 7): 이름으로 고를 때 같은 이름의 호스트가 여럿이면 ID로 고르라며 그 ID들을 보인다. 옵션은 위치 인자 뒤에 와도 된다. 40초 기한은 서버 쪽 작업에도 걸리고, 서버가 멈추면 하던 연결도 그친다.
- §13 (Task 6): 알림 중계 통합 테스트는 이은 호스트의 알림기에 webpush-go의 실제 송신을 쓴다. 테스트 TLS 허브를 믿는 HTTP 클라이언트를 넣어야 하는데, 운영 송신기는 클라이언트를 바꿀 수 없다.
- 상태 줄과 §12 단계 11 상태: Task 8 Step 5의 글.

## Self-Review

1. **스펙 범위:** 결정 158(허브)은 Task 4~7의 서버와 명령, Task 10의 화면이다. 159·160(잇기, 주소)은 Task 3(`Link`, `ParseTarget`), Task 4(`POST /api/hosts`), Task 7(`mori hosts link`)이다. 161~164(중계의 경로, 헤더, 오류, WS)는 Task 5, 165(중계 구독)는 Task 3(`SetupRelay`)과 Task 4(`POST /api/hosts/{id}/relay`), 166(중계 받기)은 Task 6, 167(종류)은 Task 2(`Payload.Kind`, `Relayed`)다. 168(호스트 API)은 Task 1(옛 호스트에 ID)과 Task 4, 169(CLI)는 Task 7, 170(UI 주소)은 Task 10이다. 171(버전)은 Task 3(이을 때 읽은 버전), Task 7(`mori hosts`의 버전 칸), Task 10(없는 API의 오류)이다. §6.9~6.11은 Task 3·5·6, §8의 허브·중계 엔드포인트·비밀은 Task 5·6과 README의 보안(Task 8), §13의 TLS 허브 통합 테스트는 Task 6, 손으로 하는 확인은 Task 8 Step 4다. 실제 iPhone으로 다른 호스트의 알림을 받아 그 터미널로 가는 확인(§13)은 https 허브와 화면이 있어야 하므로 Task 10 뒤에 한다.
2. **자리표시:** Task 10만 일부러 단계를 비워 두었다. 화면이 Task 9의 선택에 달렸기 때문이고, 선택과 상관없는 부분(1~8)은 Task 10에 적었다. 그 밖의 단계에는 코드, 명령, 기대 결과가 있다.
3. **타입 일관성:** `peer.View`의 필드(`id`, `name`, `url`, `linked`, `version`, `relay`, `relay_error`, `linked_ms`)를 Task 4의 웹 `Host`가 그대로, Task 7의 `admin.HostInfo`가 `linked_ms`만 빼고 같은 이름으로 쓴다. `Link(ctx, rawURL, code, name) (View, bool, error)`를 Task 4의 `POST /api/hosts`와 Task 7의 `LinkHost`가 같은 순서로 부르고, `Relay(secret) (id, key, authSecret, ok)`의 네 값을 Task 6의 `handleRelay`가, `MarkUnlinked(id, token)`을 Task 5의 `modifyResponse`가 쓴다. 테스트 도우미 `fakeMori(t, code)`·`withLinks(c)`(Task 4), `(*testEnv).linkHost(origin)`(Task 5), `startTestEnv(t, srv, useTLS, opts...)`(Task 6)는 정의와 부르는 곳의 인자가 맞다.
4. **Review Focus:** 다섯 줄 모두 그 태스크에 테스트가 있다. 말없이 사라진 폰과 먼저 닫는 호스트는 `TestTunnelEndsWhenHostCloses`, `%2F` 주소는 `TestProxyForwardsWithHubCookie`, 8 MB 올리기와 10 MiB 상한은 `TestProxyBodyLimit`(이상 Task 5), 허브를 철회한 호스트는 `TestProxyHostErrors`(Task 5)와 `TestHubRelaysHostNotifications`(Task 6), `kind`가 없는 옛 Mori는 `TestRelayed`(Task 2)다.
