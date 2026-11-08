# Mori 백엔드 v1 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 호스트마다 herdr-core 옆에서 도는 Go 단일 바이너리 `mori`를 만든다. 브라우저가 인증을 거쳐 REST·WebSocket으로 세션을 만들고, 보고, 입력하고, 폴더·Git·워크트리를 다루고, 승인·입력 대기 알림을 받는다(설계 단계 1~8).

**Architecture:** `mori serve`는 `hc connect` 자식 프로세스 하나와 framed JSON-RPC로 말한다. 그 위에 터미널 캐시(스냅숏 + 이벤트)를 두고, 127.0.0.1에서 REST와 WS(이벤트 1개, attach는 터미널마다 1개)를 연다. 세션은 코어가 소유하므로 Mori나 브라우저가 꺼져도 산다. 인증은 페어링 코드 → HttpOnly 쿠키 토큰이고, 상태는 `state.json` 하나에 둔다.

**Tech Stack:** Go 1.26(표준 라이브러리 `net/http` ServeMux 패턴, `log/slog`, `embed`), `github.com/coder/websocket`, `github.com/SherClockHolmes/webpush-go`, `github.com/mdp/qrterminal/v3`, git CLI, herdr-core `hc` 0.1.19.

**Spec:** `docs/superpowers/specs/2026-11-08-mori-design.md`

## Global Constraints

- Go 모듈 경로 `github.com/kwonikhyeon/mori`, `go 1.26` 이상. 외부 의존성은 위 세 개만 쓴다.
- 기본 수신 주소 `127.0.0.1:7761`. 루프백이 아닌 주소는 거부한다.
- 상태 위치: `--home`, 다음 `MORI_HOME`, 다음 `os.UserConfigDir()/Mori`. 파일은 `state.json`(0600, 임시 파일 → fsync → rename), `mori.sock`, `mori.log`. 디렉터리는 0700.
- `hc` 찾기: `--hc` → `PATH` → `~/.local/bin/hc(.exe)`. `hc connect` 자식 환경에서 `HC_TERMINAL_ID`를 뺀다.
- 사용자 기본 코어에 `hc server stop`·`restart`를 절대 하지 않는다. 테스트는 `internal/hctest`의 격리 코어(`HC_SESSION=mori-test-<id>`, XDG 경로와 `HC_SOCKET`은 `<repo>/.dev/test/<id>`)만 쓰고, 끝나면 같은 환경으로 `hc server stop` 한다. `hc`가 없으면 건너뛴다.
- Mori가 만드는 세션: `keep: true`, `no_parent: true`, 라벨 `mori=1`, `mori.folder`, `mori.preset`, `mori.title`, env `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=mori`.
- 오류 본문 `{"error":{"kind","message","hint?"}}`. HTTP 상태: 404 `not_found` · 400 `invalid_params` · 409 `blocked`,`finished`,`live`,`name_taken`,`conflict` · 503 `unavailable`,`core_unavailable` · 401 `unauthorized` · 403 `forbidden_origin` · 429 `rate_limited` · 422 `git_failed` · 나머지 500.
- attach WS 닫는 코드: 1000 정상(먼저 `closed` 메시지), 4401 인증 없음·철회, 4404 터미널 없음, 4409 사용 불가(복구 대기), 4503 코어 연결 끊김.
- 쿠키 `mori_device`: HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age 400일, 쓸 때마다 연장. 토큰 256비트, 서버에는 SHA-256만.
- 페어링 코드: 혼동 문자 없는 base32 8자리(`XXXX-XXXX`), 5분, 한 번만. 실패 10분에 10번 넘으면 창 끝까지 전부 거절.
- 상태를 바꾸는 요청과 모든 WS 업그레이드는 `Origin`의 host가 `Host`(또는 `X-Forwarded-Host`)와 같아야 한다.
- git: 시간 제한 10초, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `-c core.quotepath=off -c color.ui=false`, 경로 앞에 항상 `--`. diff는 1 MiB에서 자른다. 업로드는 8 MB까지.
- 알림 종류 `blocked`(켬), `waiting`(켬), `error`(켬), `exited`(끔). 같은 터미널·같은 종류는 10초에 한 번. 포커스한 뷰어가 있으면 보내지 않는다. 부모 있는 터미널은 기본으로 건너뛴다.
- 사용자에게 보이는 문구는 한국어. 코드 식별자와 로그는 영어.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 단계가 끝날 때마다 `git push`.
- 공개 저장소다. tailnet 도메인, 토큰, 개인 키를 커밋하지 않는다.

## Review Focus

1. **느리거나 멈춘 브라우저.** attach 스트림 하나가 소비되지 않아도 채널 0 호출, 다른 스트림, 이벤트 채널은 계속 흘러야 한다. → Task 4에 "소비 안 되는 스트림 옆에서 Call과 다른 스트림이 동작" 테스트.
2. **attach 응답 직후 첫 화면.** 코어는 attach 응답 바로 뒤에 같은 바이트열로 첫 화면을 보낸다. 호출자가 채널을 등록하기 전에 읽기 루프가 프레임을 버리면 화면이 빈다. → Task 3에 "응답과 첫 프레임을 한 번에 쓰는 가짜 코어" 테스트.
3. **`/`가 든 터미널 주소(`machine/t7`).** REST 경로의 `%2F`와 WS 쿼리 모두 통해야 한다. → Task 9 라우팅 테스트.
4. **코어 재시작 중 열린 화면.** attach WS는 4503으로 닫히고, 이벤트 WS는 `core:false` 뒤 새 상태를 받는다. 재연결 비교는 실제로 바뀐 것만 알린다. → Task 6(재연결 비교), Task 10(4503) 테스트.
5. **한글·공백·심볼릭 링크 경로.** git `-z` 파싱이 한글·공백 파일명을 그대로 돌려주고, macOS `/var` → `/private/var` 같은 링크 경로의 cwd도 폴더에 들어가야 한다. → Task 11 파서 테스트, Task 12 소속 테스트.

---

## 파일 구조

```
go.mod / go.sum
Makefile                       build, test, vet, release, test-clean, web(나중)
README.md
.gitignore
cmd/mori/
  main.go                      하위 명령 분기, 공통 플래그
  serve.go                     serve: 조립과 종료 처리
  admincmd.go                  pair · devices · revoke (관리 소켓 클라이언트)
  doctor.go                    doctor
  servicecmd.go                service install/uninstall
internal/version/version.go    Version (ldflags로 주입)
internal/paths/paths.go        Home, State, Socket, Log
internal/procutil/             HideWindow(cmd) (Windows 콘솔 창 숨김)
internal/store/                state.json 타입과 원자적 저장
internal/hc/                   herdr-core 클라이언트
  frame.go                     프레임 인코딩
  types.go                     코어 타입
  rpc.go                       JSON-RPC 메시지와 Error
  conn.go                      Open, Call, 읽기 루프, 채널 등록
  stream.go                    attach 스트림(큐, 크레딧, CLOSE)
  events.go                    이벤트 채널(NDJSON, 크레딧)
  dial.go                      hc connect 프로세스, Locate
internal/hctest/hctest.go      격리 코어 도우미
internal/core/
  labels.go                    Mori 라벨 이름, DisplayTitle
  apply.go                     이벤트 적용, 스냅숏 비교
  manager.go                   연결 유지, 캐시, Watch, Call/Attach 중계
internal/auth/                 코드, 페어링, 토큰, 쿠키, Origin, 시도 제한
internal/admin/                관리 소켓 서버·클라이언트
internal/gitx/                 git 실행과 파서
internal/folders/              폴더 소속 계산과 워크트리 캐시
internal/presence/             터미널별 포커스한 뷰어
internal/push/                 VAPID, 구독, 알림 판정, 발송
internal/server/               라우팅, REST, 이벤트 WS, attach WS
internal/service/              LaunchAgent, Windows Run 키
internal/tailscale/            tailscale CLI 조회(DNS 이름, serve 설정)
internal/webui/                dist 임베드, 자리표시 페이지
```

한 파일은 한 책임만 갖는다. 서버 핸들러는 묶음마다 파일을 나눈다(`api_auth.go`, `api_terminals.go`, `api_folders.go`, `api_git.go`, `api_push.go`, `api_settings.go`, `ws_events.go`, `ws_attach.go`).

## 실행 방식

사용자가 승인 대기 없이 바로 구현하라고 했다(2026-11-09). 이 세션에서 직접 구현한다(Native, `superpowers:executing-plans`). 각 태스크는 실패하는 테스트 → 구현 → 통과 → 커밋 순서다. 단계가 끝나면 푸시한다.

---

### Task 0: 저장소 준비 (단계 0)

**Files:**
- Create: `.gitignore`
- Modify: `docs/superpowers/specs/2026-11-08-mori-design.md` (구현 중 확정한 사실 반영)

- [ ] **Step 1: `.gitignore` 작성**

```gitignore
.DS_Store
.dev/
/bin/
/dist/
internal/webui/dist/*
!internal/webui/dist/.gitkeep
web/node_modules/
web/dist/
*.test
coverage.out
```

- [ ] **Step 2: 원격과 저장소 전용 자격 증명 도우미**

```bash
git remote add origin https://github.com/kwonikhyeon/Mori.git
git config credential.https://github.com.helper '!gh auth git-credential'
```

전역 설정은 바꾸지 않는다.

- [ ] **Step 3: 문서 커밋과 첫 푸시**

```bash
git add .gitignore docs/
git commit -m "docs: Mori 설계와 백엔드 v1 구현 계획"
git push -u origin main
```

Expected: 원격에 `main`이 생긴다.

---

### Task 1: Go 골격과 `/api/hello` (단계 1)

**Files:**
- Create: `go.mod`, `Makefile`, `cmd/mori/main.go`, `cmd/mori/serve.go`, `internal/version/version.go`, `internal/paths/paths.go`, `internal/procutil/procutil.go`, `internal/procutil/procutil_windows.go`, `internal/webui/webui.go`, `internal/webui/placeholder.html`, `internal/webui/placeholder.js`, `internal/webui/dist/.gitkeep`, `internal/server/server.go`, `internal/server/errors.go`
- Test: `internal/webui/webui_test.go`, `internal/server/server_test.go`, `internal/paths/paths_test.go`

**Interfaces:**
- Produces:
  - `version.Version string` (기본 `"dev"`)
  - `paths.Home(flag string) (string, error)`, `paths.State(home) string`, `paths.Socket(home) string`, `paths.Log(home) string`
  - `procutil.HideWindow(cmd *exec.Cmd)` (Windows 밖에서는 아무것도 안 함)
  - `webui.Handler() http.Handler` — `dist/index.html`이 있으면 dist, 없으면 자리표시. `/pair`도 같은 페이지를 준다.
  - `server.New(d Deps) *Server`, `(*Server).Handler() http.Handler`. 이 태스크의 `Deps`는 `{Version, HostName string; UI http.Handler; Logger *slog.Logger}`이고 이후 태스크가 필드를 더한다.
  - `server.writeJSON(w, status int, v any)`, `server.writeError(w, err error)`, `server.apiError{Status int; Kind, Message, Hint string}`, `server.errorf(status int, kind, format string, args ...any) *apiError`

- [ ] **Step 1: 실패하는 테스트**

`internal/server/server_test.go`:
```go
func TestHelloIsPublicAndHasSecurityHeaders(t *testing.T) {
	s := New(Deps{Version: "v-test", HostName: "macmini", UI: http.NotFoundHandler()})
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/hello", nil))
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	var got struct {
		App, Version, Host string
		Paired             bool
	}
	json.NewDecoder(rec.Body).Decode(&got)
	if got.App != "mori" || got.Version != "v-test" || got.Host != "macmini" || got.Paired {
		t.Fatalf("hello %+v", got)
	}
	for _, h := range []string{"Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy"} {
		if rec.Header().Get(h) == "" {
			t.Errorf("missing %s", h)
		}
	}
}

func TestErrorShape(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, errorf(400, "invalid_params", "bad %s", "x"))
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), `"kind":"invalid_params"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}
```

`internal/webui/webui_test.go`:
```go
func TestPlaceholderServedWithoutBuild(t *testing.T) {
	for _, p := range []string{"/", "/pair"} {
		rec := httptest.NewRecorder()
		Handler().ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "Mori") {
			t.Fatalf("%s: %d", p, rec.Code)
		}
	}
}
```

`internal/paths/paths_test.go`:
```go
func TestHomeOrder(t *testing.T) {
	t.Setenv("MORI_HOME", "/env/home")
	if h, _ := Home("/flag/home"); h != "/flag/home" { t.Fatal(h) }
	if h, _ := Home(""); h != "/env/home" { t.Fatal(h) }
	t.Setenv("MORI_HOME", "")
	h, err := Home("")
	if err != nil || filepath.Base(h) != "Mori" { t.Fatal(h, err) }
}
```

- [ ] **Step 2: 실패 확인** — `go test ./...` → 컴파일 실패(패키지 없음).

- [ ] **Step 3: 구현**

`go.mod`: `module github.com/kwonikhyeon/mori` / `go 1.26`.

`internal/server/errors.go`:
```go
type apiError struct {
	Status  int
	Kind    string
	Message string
	Hint    string
}

func (e *apiError) Error() string { return e.Kind + ": " + e.Message }

func errorf(status int, kind, format string, args ...any) *apiError {
	return &apiError{Status: status, Kind: kind, Message: fmt.Sprintf(format, args...)}
}

// statusFor maps an error kind to its HTTP status (spec §7.4).
func statusFor(kind string) int {
	switch kind {
	case "not_found":
		return 404
	case "invalid_params":
		return 400
	case "blocked", "finished", "live", "name_taken", "conflict", "already_added":
		return 409
	case "unavailable", "core_unavailable":
		return 503
	case "unauthorized":
		return 401
	case "forbidden_origin":
		return 403
	case "rate_limited":
		return 429
	case "git_failed":
		return 422
	}
	return 500
}

func writeError(w http.ResponseWriter, err error) {
	var ae *apiError
	if !errors.As(err, &ae) {
		ae = toAPIError(err) // Task 6·11에서 hc.Error, core.ErrUnavailable, gitx.Error를 더한다
	}
	body := map[string]any{"kind": ae.Kind, "message": ae.Message}
	if ae.Hint != "" {
		body["hint"] = ae.Hint
	}
	writeJSON(w, ae.Status, map[string]any{"error": body})
}

func toAPIError(err error) *apiError {
	return &apiError{Status: 500, Kind: "internal", Message: err.Error()}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
```

`internal/server/server.go`: `Server{d Deps; mux *http.ServeMux}`. `Handler()`는 `securityHeaders(mux)`를 돌려준다. 헤더는 모든 응답에 붙인다.
```go
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "+
			"connect-src 'self' wss://"+r.Host+" ws://"+r.Host+"; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
```
`GET /api/hello` → `{"app":"mori","version","host","paired"}`(`paired`는 Task 8부터 쿠키로 계산, 지금은 false). `/`는 `d.UI`.

`internal/webui/webui.go`:
```go
//go:embed all:dist placeholder.html placeholder.js
var files embed.FS

func Handler() http.Handler {
	if _, err := fs.Stat(files, "dist/index.html"); err == nil {
		sub, _ := fs.Sub(files, "dist")
		return spa(sub)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/placeholder.js":
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			b, _ := files.ReadFile("placeholder.js")
			w.Write(b)
		case "/", "/pair":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			b, _ := files.ReadFile("placeholder.html")
			w.Write(b)
		default:
			http.NotFound(w, r)
		}
	})
}

// spa serves files and answers "/pair" with index.html (the UI routes by hash).
func spa(root fs.FS) http.Handler {
	fileServer := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/pair" {
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})
}
```
자리표시 페이지는 "Mori 서버가 동작 중입니다. UI는 아직 설치되지 않았습니다."를 보이고, `placeholder.js`가 `#code=`가 있으면 이름 입력과 `POST /api/pair` 폼을 그린다(인라인 스크립트 없음, CSP 준수).

`cmd/mori/main.go`: `os.Args[1]`로 `serve|pair|devices|revoke|doctor|service|version`을 고른다. 모르는 명령은 사용법을 stderr에 쓰고 종료 코드 2. `version`은 `mori <Version> (<GOOS>/<GOARCH>)`.

`cmd/mori/serve.go`(이 태스크 범위): 플래그 `--home --listen --log`. 루프백이 아닌 `--listen`은 거부(`net.SplitHostPort` 후 `net.ParseIP(host).IsLoopback()` 또는 `localhost`). `http.Server{ReadHeaderTimeout: 10s, IdleTimeout: 120s}`. SIGINT·SIGTERM이면 `Shutdown(5s)`.

`Makefile`:
```make
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/kwonikhyeon/mori/internal/version.Version=$(VERSION)
TARGETS := darwin/arm64 darwin/amd64 windows/amd64 windows/arm64 linux/amd64

build:
	go build -ldflags '$(LDFLAGS)' -o bin/mori ./cmd/mori
test:
	go test ./...
vet:
	go vet ./...
release:
	@for t in $(TARGETS); do os=$${t%/*}; arch=$${t#*/}; ext=; [ $$os = windows ] && ext=.exe; \
	  GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 go build -ldflags '$(LDFLAGS)' -o dist/mori-$$os-$$arch/mori$$ext ./cmd/mori || exit 1; \
	  if [ $$os = windows ]; then GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 go build -ldflags '$(LDFLAGS) -H=windowsgui' -o dist/mori-$$os-$$arch/moriw.exe ./cmd/mori || exit 1; fi; \
	done
test-clean:
	@for d in .dev/test/*/; do [ -d "$$d" ] || continue; d=$${d%/}; id=$${d##*/}; a=$$PWD/$$d; \
	  HC_SESSION=mori-test-$$id XDG_STATE_HOME=$$a/state XDG_CONFIG_HOME=$$a/config XDG_RUNTIME_DIR=$$a/run HC_SOCKET=$$a/c.sock \
	  hc server stop >/dev/null 2>&1; rm -rf "$$a"; echo "stopped $$id"; done
.PHONY: build test vet release test-clean
```

- [ ] **Step 4: 통과 확인** — `go vet ./... && go test ./... && make release` → 모두 통과, `dist/`에 5개 대상(Windows는 `mori.exe`, `moriw.exe`).

- [ ] **Step 5: 커밋** — `git commit -m "feat: Go 골격, /api/hello, 자리표시 UI, Makefile"`

---

### Task 2: `internal/store` (단계 1)

**Files:**
- Create: `internal/store/state.go`, `internal/store/store.go`
- Test: `internal/store/store_test.go`

**Interfaces:**
- Produces:
```go
const SchemaVersion = 1
type State struct {
	Version  int       `json:"version"`
	Folders  []Folder  `json:"folders"`
	Hosts    []Host    `json:"hosts"`
	Presets  []Preset  `json:"presets"`
	Notify   Notify    `json:"notify"`
	Devices  []Device  `json:"devices"`
	PushSubs []PushSub `json:"push_subscriptions"`
	VAPID    VAPID     `json:"vapid"`
}
type Folder struct{ ID, Name, Path string; CreatedMs int64 }      // json: id,name,path,created_ms
type Host struct{ Name, URL string }                               // json: name,url
type Preset struct{ ID, Name string; Argv []string; Task bool }    // json: id,name,argv,task
type Notify struct{ Children bool }                                // json: children
type Device struct{ ID, Name string; CreatedMs, LastSeenMs int64; UserAgent, TokenHash string }
                                                                   // json: id,name,created_ms,last_seen_ms,user_agent,token_hash
type PushSub struct{ ID, DeviceID, Endpoint, P256dh, Auth string; Kinds []string; CreatedMs int64 }
                                                                   // json: id,device_id,endpoint,p256dh,auth,kinds,created_ms
type VAPID struct{ Public, Private string }                        // json: public,private
func DefaultPresets() []Preset   // claude ["claude"] task · codex ["codex"] task · shell [] no task
func NewID(prefix string) string // prefix + 8 hex (crypto/rand)
func Open(path string) (*Store, error)
func (s *Store) Get() State                           // 깊은 복사
func (s *Store) Update(fn func(*State) error) error   // 복사본에 fn → 디스크에 원자 저장 → 교체. fn 오류면 아무것도 안 바뀜
func (s *Store) Path() string
```

- [ ] **Step 1: 실패하는 테스트**

```go
func TestOpenCreatesDefaultsWith0600(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "state.json")
	s, err := Open(p)
	if err != nil { t.Fatal(err) }
	st := s.Get()
	if st.Version != SchemaVersion || len(st.Presets) != 3 || st.Presets[0].ID != "claude" { t.Fatalf("%+v", st) }
	fi, err := os.Stat(p)
	if err != nil { t.Fatal(err) }
	if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 { t.Fatalf("perm %v", fi.Mode().Perm()) }
}

func TestUpdatePersistsAndGetIsCopy(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state.json")
	s, _ := Open(p)
	if err := s.Update(func(st *State) error {
		st.Folders = append(st.Folders, Folder{ID: "f_1", Name: "a", Path: "/a"}); return nil
	}); err != nil { t.Fatal(err) }
	got := s.Get()
	got.Folders[0].Name = "changed"
	if s.Get().Folders[0].Name != "a" { t.Fatal("Get must return a copy") }
	s2, _ := Open(p)
	if len(s2.Get().Folders) != 1 { t.Fatal("not persisted") }
}

func TestUpdateErrorChangesNothing(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "state.json"))
	err := s.Update(func(st *State) error { st.Hosts = []Host{{Name: "x"}}; return errors.New("no") })
	if err == nil || len(s.Get().Hosts) != 0 { t.Fatal("rollback failed") }
}

func TestCorruptFileMovedAside(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "state.json")
	os.WriteFile(p, []byte("{not json"), 0o600)
	s, err := Open(p)
	if err != nil { t.Fatal(err) }
	if len(s.Get().Presets) != 3 { t.Fatal("fresh state expected") }
	if b, _ := os.ReadFile(p + ".bad"); string(b) != "{not json" { t.Fatal("bad copy missing") }
}

func TestConcurrentUpdates(t *testing.T) {
	s, _ := Open(filepath.Join(t.TempDir(), "state.json"))
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); s.Update(func(st *State) error { st.Hosts = append(st.Hosts, Host{}); return nil }) }()
	}
	wg.Wait()
	if len(s.Get().Hosts) != 20 { t.Fatal(len(s.Get().Hosts)) }
}
```

- [ ] **Step 2: 실패 확인** — `go test ./internal/store/` → 컴파일 실패.

- [ ] **Step 3: 구현**

```go
func (s *Store) Update(fn func(*State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := clone(s.cur)
	if err := fn(&next); err != nil {
		return err
	}
	if err := writeAtomic(s.path, next); err != nil {
		return err
	}
	s.cur = next
	return nil
}

func writeAtomic(path string, st State) error {
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil { return err }
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".state-*.tmp")
	if err != nil { return err }
	tmp := f.Name()
	defer os.Remove(tmp) // rename 뒤에는 실패해도 무해
	if err := f.Chmod(0o600); err != nil && runtime.GOOS != "windows" { f.Close(); return err }
	if _, err := f.Write(append(b, '\n')); err != nil { f.Close(); return err }
	if err := f.Sync(); err != nil { f.Close(); return err }
	if err := f.Close(); err != nil { return err }
	if err := os.Rename(tmp, path); err != nil { return err }
	if d, err := os.Open(dir); err == nil { d.Sync(); d.Close() } // Windows에서는 실패해도 무시
	return nil
}
```
`clone`은 JSON 왕복. `Open`: `MkdirAll(dir, 0o700)`; 없으면 기본값을 쓰고 저장; JSON이 깨졌으면 `os.Rename(path, path+".bad")` 후 `slog.Warn`, 기본값 저장. 읽은 뒤 `Version==0`이면 1, `Presets==nil`이면 기본값, nil 슬라이스는 빈 슬라이스로 정규화.

- [ ] **Step 4: 통과 확인** — `go test -race ./internal/store/` → PASS.

- [ ] **Step 5: 커밋 후 단계 1 푸시** — `git commit -m "feat(store): state.json 원자 저장"` → `git push`.

---

### Task 3: hc 프레임과 JSON-RPC 연결 (단계 2)

**Files:**
- Create: `internal/hc/frame.go`, `internal/hc/types.go`, `internal/hc/rpc.go`, `internal/hc/conn.go`
- Test: `internal/hc/frame_test.go`, `internal/hc/fakecore_test.go`, `internal/hc/conn_test.go`

**Interfaces:**
- Produces:
```go
const (KindData, KindCredit, KindClose, KindResize, KindFocus, KindFacts, KindAutomaticInput byte = 0, 1, 2, 3, 4, 5, 6)
const MaxPayload = 16 << 20
const InitialCredit = 256 << 10
type Frame struct { Channel uint32; Kind byte; Payload []byte }
func AppendFrame(dst []byte, f Frame) []byte
func ReadFrame(r io.Reader) (Frame, error)        // len > MaxPayload → ErrFrameTooLarge
type Error struct { Code int; Message string; Data ErrorData }   // ErrorData{Kind, Hint string}
func (e *Error) Error() string
func KindOf(err error) string                      // *Error → Data.Kind(없으면 -32602 → "invalid_params", 그 밖 "internal"); ErrClosed → "core_unavailable"; 나머지 ""
var ErrClosed = errors.New("hc: connection closed")
func Open(ctx context.Context, rw io.ReadWriteCloser) (*Conn, error)   // plain hello {generation:1, framed:true} → framed
func (c *Conn) Hello() HelloResult
func (c *Conn) Call(ctx context.Context, method string, params, result any) error
func (c *Conn) Done() <-chan struct{}
func (c *Conn) Err() error
func (c *Conn) Close() error
```
타입(`types.go`)은 스키마 그대로다: `Terminal`(필수 address, argv, cols, rows, created_ms, cwd, labels, screen, state; 나머지는 nullable 포인터), `Status{State, App, Kind *string, Msg, Progress *int, Title}`, `Foreground{Pid, Name, Argv, Cwd}`, `Display{FG, BG, Cursor string; Cell []int}`(모두 omitempty), `HelloResult{Version, Generation, Framed, Features, Methods, Core CoreInfo{ID, Name}}`, `Size{Cols, Rows int}`(json cols, rows), `CloseReason{Reason string; ExitCode, Signal *int}`, `RunParams`(argv, cwd, env map, keep, labels map, no_parent, size *Size; 모두 omitempty), `Snapshot{Seq int64; Terminals []Terminal}`, `Event{Seq int64; Type, Terminal, Machine string; Data json.RawMessage}`.

읽기 루프 규칙: 채널 0 DATA는 JSON-RPC. `id`가 있으면 대기 중 호출에 넘긴다. 그 호출이 채널을 여는 호출(attach, subscribe)이면 **응답을 넘기기 전에** 결과의 `channel`로 싱크를 등록한다(Review Focus 2). 다른 채널의 DATA·CLOSE·RESIZE는 등록된 싱크로, 모르는 채널은 버린다. 코어가 보내는 CREDIT은 무시한다(2026-11-09 확인: 뷰어→코어 DATA에는 크레딧이 돌아오지 않는다).

- [ ] **Step 1: 가짜 코어와 실패하는 테스트**

`fakecore_test.go` — 테스트용 가짜 코어:
```go
type fakeCore struct {
	t      *testing.T
	client io.ReadWriteCloser // Conn 쪽
	r      *bufio.Reader      // 코어가 읽는 쪽
	w      io.WriteCloser     // 코어가 쓰는 쪽
	wmu    sync.Mutex
}

func newFakeCore(t *testing.T) *fakeCore {
	cr, cw := io.Pipe() // core → client
	sr, sw := io.Pipe() // client → core
	f := &fakeCore{t: t, r: bufio.NewReader(sr), w: cw}
	f.client = struct {
		io.Reader
		io.Writer
		io.Closer
	}{cr, sw, closerFunc(func() error { sw.Close(); cr.Close(); return nil })}
	t.Cleanup(func() { cw.Close(); sr.Close() })
	return f
}

// handshake answers the plain-mode hello and switches to frames.
func (f *fakeCore) handshake() {
	line, err := f.r.ReadBytes('\n')
	if err != nil { f.t.Error(err); return }
	var req struct{ ID int64; Method string; Params map[string]any }
	json.Unmarshal(line, &req)
	if req.Method != "hello" || req.Params["framed"] != true { f.t.Errorf("hello %s", line) }
	fmt.Fprintf(f.w, `{"jsonrpc":"2.0","id":%d,"result":{"version":"0.1.19","generation":1,"framed":true,"features":["framed","attach","events"],"methods":[],"core":{"id":"c1","name":"fake"}}}`+"\n", req.ID)
}

func (f *fakeCore) readFrame() Frame { fr, err := ReadFrame(f.r); if err != nil { f.t.Fatal(err) }; return fr }

// readCall reads frames until a JSON-RPC request arrives on channel 0.
func (f *fakeCore) readCall() (id int64, method string, params json.RawMessage) { ... }

func (f *fakeCore) send(frames ...Frame) { // 여러 프레임을 한 번의 Write로
	f.wmu.Lock(); defer f.wmu.Unlock()
	var b []byte
	for _, fr := range frames { b = AppendFrame(b, fr) }
	f.w.Write(b)
}

func reply(id int64, result string) Frame {
	return Frame{Kind: KindData, Payload: []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":%s}`, id, result))}
}
```

`frame_test.go`:
```go
func TestFrameRoundTrip(t *testing.T) {
	in := []Frame{{0, KindData, []byte(`{"a":1}`)}, {7, KindCredit, []byte{1, 0, 0, 0}}, {9, KindClose, nil}}
	var b []byte
	for _, f := range in { b = AppendFrame(b, f) }
	r := bytes.NewReader(b)
	for _, want := range in {
		got, err := ReadFrame(r)
		if err != nil || got.Channel != want.Channel || got.Kind != want.Kind || !bytes.Equal(got.Payload, want.Payload) {
			t.Fatalf("got %+v %v want %+v", got, err, want)
		}
	}
	if _, err := ReadFrame(r); err != io.EOF { t.Fatal(err) }
}

func TestFrameHeaderLayout(t *testing.T) {
	b := AppendFrame(nil, Frame{Channel: 0x01020304, Kind: KindResize, Payload: []byte{0x50, 0, 0x18, 0}})
	want := []byte{4, 3, 2, 1, 3, 4, 0, 0, 0, 0x50, 0, 0x18, 0}
	if !bytes.Equal(b, want) { t.Fatalf("% x", b) }
}

func TestFrameTooLarge(t *testing.T) {
	h := []byte{0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x7f}
	if _, err := ReadFrame(bytes.NewReader(h)); !errors.Is(err, ErrFrameTooLarge) { t.Fatal(err) }
}
```

`conn_test.go`:
```go
func openFake(t *testing.T) (*Conn, *fakeCore) {
	f := newFakeCore(t)
	go f.handshake()
	c, err := Open(context.Background(), f.client)
	if err != nil { t.Fatal(err) }
	t.Cleanup(func() { c.Close() })
	return c, f
}

func TestCallResultAndError(t *testing.T) {
	c, f := openFake(t)
	if c.Hello().Core.Name != "fake" { t.Fatal("hello") }
	go func() {
		id, m, _ := f.readCall()
		if m != "terminal.get" { t.Errorf("method %s", m) }
		f.send(reply(id, `{"address":"t1","state":"live"}`))
		id, _, _ = f.readCall()
		f.send(Frame{Kind: KindData, Payload: []byte(fmt.Sprintf(
			`{"jsonrpc":"2.0","id":%d,"error":{"code":-32000,"message":"no t9","data":{"kind":"not_found","hint":"hc ls"}}}`, id))})
	}()
	var term Terminal
	if err := c.Call(context.Background(), "terminal.get", map[string]any{"terminal": "t1"}, &term); err != nil || term.Address != "t1" {
		t.Fatal(term, err)
	}
	err := c.Call(context.Background(), "terminal.get", map[string]any{"terminal": "t9"}, nil)
	if KindOf(err) != "not_found" { t.Fatal(err) }
}

func TestCallsRunSideBySide(t *testing.T) {
	c, f := openFake(t)
	go func() { // 두 호출을 받은 뒤 역순으로 답한다
		a, _, _ := f.readCall()
		b, _, _ := f.readCall()
		f.send(reply(b, `"second"`), reply(a, `"first"`))
	}()
	var wg sync.WaitGroup
	got := make([]string, 2)
	for i := range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); c.Call(context.Background(), "x", nil, &got[i]) }()
		time.Sleep(20 * time.Millisecond) // 순서를 고정
	}
	wg.Wait()
	if got[0] != "first" || got[1] != "second" { t.Fatal(got) }
}

func TestConnClosedFailsPendingCalls(t *testing.T) {
	c, f := openFake(t)
	go func() { f.readCall(); f.w.Close() }()
	err := c.Call(context.Background(), "x", nil, nil)
	if !errors.Is(err, ErrClosed) || KindOf(err) != "core_unavailable" { t.Fatal(err) }
	<-c.Done()
}

func TestCallContextCancel(t *testing.T) {
	c, f := openFake(t)
	go f.readCall()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := c.Call(ctx, "x", nil, nil); !errors.Is(err, context.DeadlineExceeded) { t.Fatal(err) }
}
```

- [ ] **Step 2: 실패 확인** — `go test ./internal/hc/` → 컴파일 실패.

- [ ] **Step 3: 구현**

`frame.go`:
```go
var ErrFrameTooLarge = errors.New("hc: frame payload too large")

func AppendFrame(dst []byte, f Frame) []byte {
	dst = binary.LittleEndian.AppendUint32(dst, f.Channel)
	dst = append(dst, f.Kind)
	dst = binary.LittleEndian.AppendUint32(dst, uint32(len(f.Payload)))
	return append(dst, f.Payload...)
}

func ReadFrame(r io.Reader) (Frame, error) {
	var h [9]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return Frame{}, err // 프레임 경계의 EOF는 io.EOF 그대로
	}
	n := binary.LittleEndian.Uint32(h[5:])
	if n > MaxPayload {
		return Frame{}, ErrFrameTooLarge
	}
	f := Frame{Channel: binary.LittleEndian.Uint32(h[:4]), Kind: h[4], Payload: make([]byte, n)}
	if _, err := io.ReadFull(r, f.Payload); err != nil {
		return Frame{}, io.ErrUnexpectedEOF
	}
	return f, nil
}
```

`conn.go`의 뼈대:
```go
type sink interface {
	data(p []byte)
	resize(cols, rows int)
	closed(reason []byte, err error) // reason: 코어 CLOSE 페이로드, err: 연결 오류
}

type pending struct {
	ch        chan *message
	open      func(channel uint32) sink // 채널을 여는 호출이면 nil이 아님
	abandoned bool                      // 호출자가 떠남: 열린 채널은 바로 CLOSE
}

type Conn struct {
	rw      io.ReadWriteCloser
	br      *bufio.Reader
	wmu     sync.Mutex
	nextID  atomic.Int64
	mu      sync.Mutex
	pending map[int64]*pending
	sinks   map[uint32]sink
	hello   HelloResult
	done    chan struct{}
	err     error
}
```
- `Open`: plain으로 `{"jsonrpc":"2.0","id":0,"method":"hello","params":{"generation":1,"framed":true}}\n`을 쓰고, `br.ReadBytes('\n')`로 `id:0` 응답이 올 때까지 읽는다. 오류 응답이면 `*Error`. ctx가 끝나면 `rw.Close()`. 성공하면 `go c.readLoop()`.
- `writeFrame(f)`: `wmu` 아래 `AppendFrame` 한 번 + `Write` 한 번.
- `call(ctx, method, params, open)`: id 발급 → `pending` 등록 → 채널 0 DATA 전송 → `select { 응답 | ctx.Done → abandoned=true(맵에 남김), ctx.Err() | c.done → ErrClosed }`.
- `readLoop`: 프레임마다 분기. 응답 처리에서 `p.open != nil`이면 `result.channel`을 읽어 `sinks[ch] = p.open(ch)`를 등록한 뒤 응답을 넘긴다. `abandoned`면 등록 직후 `go c.writeFrame(Frame{ch, KindClose, nil})`. CLOSE 프레임은 싱크의 `closed(payload, nil)` 후 등록을 지운다.
- `fail(err)`: 한 번만. `c.err = err`, `close(done)`, 모든 싱크에 `closed(nil, ErrClosed)`.
- `Close()`: `rw.Close()`, 읽기 루프 종료를 기다린다(최대 3초).
- `KindOf`: `errors.As(err, &e)` → `e.Data.Kind`, 비면 `Code == -32602`이면 `"invalid_params"`, 그 밖 `"internal"`; `errors.Is(err, ErrClosed)` → `"core_unavailable"`.

- [ ] **Step 4: 통과 확인** — `go test -race ./internal/hc/` → PASS.

- [ ] **Step 5: 커밋** — `git commit -m "feat(hc): 프레임 인코딩과 framed JSON-RPC 연결"`

---

### Task 4: hc attach 스트림·이벤트·`hc connect`·격리 코어 (단계 2)

**Files:**
- Create: `internal/hc/stream.go`, `internal/hc/events.go`, `internal/hc/dial.go`, `internal/procutil/*`(Task 1에서 만든 것 사용), `internal/hctest/hctest.go`
- Test: `internal/hc/stream_test.go`, `internal/hc/events_test.go`, `internal/hc/integration_test.go`

**Interfaces:**
- Consumes: Task 3의 `Conn`, `Frame`, `sink`.
- Produces:
```go
type AttachParams struct { Terminal string; Cols, Rows int; History int; Observe, Resumed, ResizeNotifications bool; Display *Display }
  // json: terminal, cols, rows, history,omitempty, observe,omitempty, resumed,omitempty, resize_notifications,omitempty, display,omitempty
type AttachResult struct { Channel uint32; Terminal Terminal; ResizeNotifications, AutomaticInput bool }
func (c *Conn) Attach(ctx context.Context, p AttachParams) (*Stream, AttachResult, error)
type StreamMsg struct { Data []byte; Size *Size }
type ClosedError struct { CloseReason }                    // 코어가 스트림을 끝냄
var ErrDetached = errors.New("hc: stream detached")         // 우리가 Close함
func (s *Stream) Channel() uint32
func (s *Stream) Recv(ctx context.Context) (StreamMsg, error) // 큐를 다 비운 뒤에 *ClosedError / ErrClosed / ErrDetached
func (s *Stream) Credit(n int) error
func (s *Stream) Write(p []byte) (int, error)             // 1 MiB씩 DATA
func (s *Stream) Resize(cols, rows int) error
func (s *Stream) Focus(focused bool) error
func (s *Stream) Facts(d Display) error
func (s *Stream) Close() error                            // CLOSE 후 코어의 빈 CLOSE를 최대 2초 기다림
func (s *Stream) Done() <-chan struct{}
type SubscribeParams struct { ChildrenOf string; Labels []string; Terminal string } // 모두 omitempty
type Notification struct { Method string; Event *Event; Seq int64; Snapshot *Snapshot }
func (c *Conn) Subscribe(ctx context.Context, p SubscribeParams) (*Events, Snapshot, error)
func (e *Events) Recv(ctx context.Context) (Notification, error) // 한 줄(NDJSON)씩, 소비한 바이트만큼 CREDIT
func (e *Events) Done() <-chan struct{}
type Options struct { Path, Session string; Env []string; Stderr io.Writer }
func Dial(ctx context.Context, o Options) (*Conn, error)  // hc connect [--session S]
func Locate(explicit string) (string, error)
// internal/hctest
type Core struct { Dir, Session, HC string; Env []string }
func Start(t testing.TB) *Core          // hc 없으면 t.Skip
func (c *Core) Options() hc.Options
func (c *Core) Cmd(t testing.TB, args ...string) []byte   // 같은 환경으로 hc 실행, 실패하면 t.Fatal
```
스트림 큐: 읽기 루프는 절대 막히지 않는다. DATA는 큐 끝 항목이 데이터이고 64 KiB 미만이면 이어 붙인다. 코어가 크레딧을 지키므로 큐는 창 크기 안에 머문다. 32 MiB를 넘으면 오류로 닫는다(코어 오동작 방어).

이벤트 채널(2026-11-09 실험): DATA는 줄바꿈으로 끝나는 JSON 메시지의 **바이트 스트림**이고 프레임 경계와 메시지 경계는 무관하다. 크레딧이 필요하다(CREDIT 없이 정확히 262144바이트에서 멈췄다). `Recv`는 버퍼에서 한 줄을 떼어 그 길이(+1)만큼 CREDIT을 보낸다.

- [ ] **Step 1: 실패하는 테스트(가짜 코어)**

`stream_test.go`:
```go
func attachFake(t *testing.T, c *Conn, f *fakeCore, ch uint32, first ...Frame) *Stream {
	go func() {
		id, m, _ := f.readCall()
		if m != "terminal.attach" { t.Errorf("method %s", m) }
		res := fmt.Sprintf(`{"channel":%d,"terminal":{"address":"t1","state":"live","cols":80,"rows":24},"resize_notifications":false,"automatic_input":false}`, ch)
		f.send(append([]Frame{reply(id, res)}, first...)...) // 응답과 첫 화면을 한 번에
	}()
	s, res, err := c.Attach(context.Background(), AttachParams{Terminal: "t1", Cols: 80, Rows: 24})
	if err != nil || res.Channel != ch { t.Fatal(err, res) }
	return s
}

func TestAttachFirstPaintNotLost(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5, Frame{5, KindData, []byte("PAINT")})
	m, err := s.Recv(context.Background())
	if err != nil || string(m.Data) != "PAINT" { t.Fatal(string(m.Data), err) }
}

func TestStreamInputCreditResizeClose(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5)
	s.Write([]byte("ls\r"))
	s.Credit(1234)
	s.Resize(100, 30)
	s.Focus(true)
	want := []Frame{{5, KindData, []byte("ls\r")}, {5, KindCredit, []byte{0xd2, 0x04, 0, 0}},
		{5, KindResize, []byte{100, 0, 30, 0}}, {5, KindFocus, []byte{1}}}
	for _, w := range want {
		got := f.readFrame()
		if got.Channel != w.Channel || got.Kind != w.Kind || !bytes.Equal(got.Payload, w.Payload) { t.Fatalf("got %+v want %+v", got, w) }
	}
	f.send(Frame{5, KindData, []byte("bye")}, Frame{5, KindClose, []byte(`{"reason":"exited","exit_code":0,"signal":null}`)})
	m, _ := s.Recv(context.Background())
	if string(m.Data) != "bye" { t.Fatal("data before close must drain first") }
	_, err := s.Recv(context.Background())
	var ce *ClosedError
	if !errors.As(err, &ce) || ce.Reason != "exited" || ce.ExitCode == nil || *ce.ExitCode != 0 { t.Fatal(err) }
}

func TestStalledStreamDoesNotBlockOthers(t *testing.T) { // Review Focus 1
	c, f := openFake(t)
	attachFake(t, c, f, 5) // 아무도 Recv하지 않는다
	big := bytes.Repeat([]byte("x"), 200<<10)
	f.send(Frame{5, KindData, big}) // 크레딧 창 안의 큰 출력
	s2 := attachFake(t, c, f, 6, Frame{6, KindData, []byte("ok")})
	if m, err := s2.Recv(context.Background()); err != nil || string(m.Data) != "ok" { t.Fatal(err) }
	go func() { id, _, _ := f.readCall(); f.send(reply(id, `1`)) }()
	var n int
	if err := c.Call(context.Background(), "x", nil, &n); err != nil || n != 1 { t.Fatal(err) }
}

func TestDetach(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5)
	go func() {
		if fr := f.readFrame(); fr.Kind != KindClose { t.Errorf("kind %d", fr.Kind) }
		f.send(Frame{5, KindClose, nil})
	}()
	if err := s.Close(); err != nil { t.Fatal(err) }
	if _, err := s.Recv(context.Background()); !errors.Is(err, ErrDetached) { t.Fatal(err) }
}

func TestConnLossEndsStreams(t *testing.T) {
	c, f := openFake(t)
	s := attachFake(t, c, f, 5)
	f.w.Close()
	if _, err := s.Recv(context.Background()); !errors.Is(err, ErrClosed) { t.Fatal(err) }
}
```

`events_test.go`:
```go
func TestEventsSplitAcrossFramesAndCredited(t *testing.T) {
	c, f := openFake(t)
	go func() {
		id, m, _ := f.readCall()
		if m != "events.subscribe" { t.Errorf("method %s", m) }
		f.send(reply(id, `{"seq":3,"terminals":[{"address":"t1","state":"live"}],"channel":1}`),
			Frame{1, KindData, []byte(`{"jsonrpc":"2.0","method":"event","params":{"seq":4,"type":"title","terminal":"t1","data":{"ti`)},
			Frame{1, KindData, []byte(`tle":"hi"}}}` + "\n" + `{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":4}}` + "\n")})
	}()
	ev, snap, err := c.Subscribe(context.Background(), SubscribeParams{})
	if err != nil || snap.Seq != 3 || len(snap.Terminals) != 1 { t.Fatal(err, snap) }
	n1, _ := ev.Recv(context.Background())
	if n1.Method != "event" || n1.Event.Type != "title" || n1.Event.Seq != 4 { t.Fatalf("%+v", n1) }
	cr := f.readFrame() // 첫 메시지를 소비한 만큼 CREDIT
	if cr.Channel != 1 || cr.Kind != KindCredit || binary.LittleEndian.Uint32(cr.Payload) == 0 { t.Fatalf("%+v", cr) }
	n2, _ := ev.Recv(context.Background())
	if n2.Method != "heartbeat" || n2.Seq != 4 { t.Fatalf("%+v", n2) }
}

func TestMissedCarriesSnapshot(t *testing.T) {
	// missed 메시지 → Notification{Method:"missed", Seq:57, Snapshot:{Seq:57, Terminals:[...]}}
}
```

- [ ] **Step 2: 실패 확인** — `go test ./internal/hc/` → 컴파일 실패.

- [ ] **Step 3: 구현**

`stream.go`의 핵심:
```go
type Stream struct {
	c       *Conn
	ch      uint32
	mu      sync.Mutex
	q       []StreamMsg
	queued  int
	signal  chan struct{} // cap 1
	done    chan struct{}
	err     error         // 큐를 비운 뒤 돌려줄 오류
	closing bool
}

func (s *Stream) data(p []byte) {
	s.mu.Lock()
	if n := len(s.q); n > 0 && s.q[n-1].Size == nil && len(s.q[n-1].Data) < 64<<10 {
		s.q[n-1].Data = append(s.q[n-1].Data, p...)
	} else {
		s.q = append(s.q, StreamMsg{Data: p})
	}
	s.queued += len(p)
	over := s.queued > 32<<20
	s.mu.Unlock()
	s.wake()
	if over {
		s.closed(nil, errors.New("hc: stream backlog exceeded"))
	}
}

func (s *Stream) Recv(ctx context.Context) (StreamMsg, error) {
	for {
		s.mu.Lock()
		if len(s.q) > 0 {
			m := s.q[0]
			s.q = s.q[1:]
			s.queued -= len(m.Data)
			s.mu.Unlock()
			return m, nil
		}
		err := s.err
		s.mu.Unlock()
		if err != nil {
			return StreamMsg{}, err
		}
		select {
		case <-s.signal:
		case <-ctx.Done():
			return StreamMsg{}, ctx.Err()
		}
	}
}

func (s *Stream) closed(reason []byte, err error) {
	s.mu.Lock()
	if s.err == nil {
		switch {
		case err != nil:
			s.err = err
		case s.closing:
			s.err = ErrDetached
		default:
			ce := &ClosedError{}
			if len(reason) > 0 { json.Unmarshal(reason, &ce.CloseReason) }
			s.err = ce
		}
		close(s.done)
	}
	s.mu.Unlock()
	s.wake()
}
```
`Close()`: `closing=true`, CLOSE 전송, `select { <-s.done | 2초 → c.unregister(ch), closed(nil, ErrDetached) }`. `Credit(n)`은 `n<=0`이면 아무것도 안 한다.

`events.go`: `Events{buf []byte; signal; done; err}`. `data(p)`는 버퍼에 붙인다. `Recv`: 버퍼에서 `bytes.IndexByte('\n')`로 한 줄을 떼고, `Credit(len+1)`을 보내고, 빈 줄은 건너뛴다. `{"method","params"}`를 풀어 `event` → `Event`, `heartbeat` → `Seq`, `missed` → `Seq`·`Snapshot`. 모르는 method도 `Notification{Method}`로 돌려준다.

`dial.go`:
```go
func Dial(ctx context.Context, o Options) (*Conn, error) {
	args := []string{"connect"}
	if o.Session != "" { args = append(args, "--session", o.Session) }
	cmd := exec.Command(o.Path, args...)
	env := o.Env
	if env == nil { env = os.Environ() }
	cmd.Env = withoutKey(env, "HC_TERMINAL_ID")
	cmd.Stderr = o.Stderr
	procutil.HideWindow(cmd)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil { return nil, err }
	rw := &procRW{r: stdout, w: stdin, cmd: cmd} // Close: stdin 닫기 → 2초 기다림 → Kill → Wait
	c, err := Open(ctx, rw)
	if err != nil { rw.Close(); return nil, fmt.Errorf("hc connect: %w", err) }
	return c, nil
}

func Locate(explicit string) (string, error) {
	if explicit != "" { return exec.LookPath(explicit) }
	if p, err := exec.LookPath("hc"); err == nil { return p, nil }
	home, _ := os.UserHomeDir()
	name := "hc"
	if runtime.GOOS == "windows" { name = "hc.exe" }
	p := filepath.Join(home, ".local", "bin", name)
	if _, err := os.Stat(p); err != nil { return "", errors.New("hc not found (install herdr-core or pass --hc)") }
	return p, nil
}
```
`procutil_windows.go`: `cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000 /* CREATE_NO_WINDOW */}`.

`internal/hctest/hctest.go`:
```go
func Start(t testing.TB) *Core {
	t.Helper()
	path, err := hc.Locate(os.Getenv("MORI_TEST_HC"))
	if err != nil { t.Skip("hc not installed") }
	id := randHex(3) // 짧게: 소켓 경로는 macOS에서 103바이트까지
	dir := filepath.Join(repoRoot(t), ".dev", "test", id)
	for _, d := range []string{"state", "config", "run"} { os.MkdirAll(filepath.Join(dir, d), 0o700) }
	c := &Core{Dir: dir, Session: "mori-test-" + id, HC: path}
	c.Env = append(withoutKeys(os.Environ(), "HC_TERMINAL_ID", "HC_SESSION", "HC_SOCKET", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"),
		"HC_SESSION="+c.Session, "XDG_STATE_HOME="+filepath.Join(dir, "state"), "XDG_CONFIG_HOME="+filepath.Join(dir, "config"),
		"XDG_RUNTIME_DIR="+filepath.Join(dir, "run"), "HC_SOCKET="+filepath.Join(dir, "c.sock"))
	t.Cleanup(func() {
		cmd := exec.Command(c.HC, "server", "stop")
		cmd.Env = c.Env
		cmd.Run() // 오류는 무시: 이미 멈췄을 수 있다
		os.RemoveAll(dir)
	})
	return c
}
```
`repoRoot`는 작업 디렉터리에서 위로 `go.mod`를 찾는다. `Options()`는 `hc.Options{Path: c.HC, Env: c.Env}`(세션은 env의 `HC_SESSION`이 정한다).

- [ ] **Step 4: 통합 테스트(실제 격리 코어)** — `integration_test.go`:
```go
func TestIntegrationShellEchoAndEvents(t *testing.T) {
	core := hctest.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := Dial(ctx, core.Options())
	if err != nil { t.Fatal(err) }
	defer c.Close()
	ev, _, err := c.Subscribe(ctx, SubscribeParams{})
	if err != nil { t.Fatal(err) }
	var run Terminal
	if err := c.Call(ctx, "terminal.run", RunParams{Argv: []string{"/bin/sh"}, NoParent: true, Size: &Size{80, 24}}, &run); err != nil { t.Fatal(err) }
	waitEvent(t, ctx, ev, "created", run.Address)
	s, _, err := c.Attach(ctx, AttachParams{Terminal: run.Address, Cols: 80, Rows: 24})
	if err != nil { t.Fatal(err) }
	s.Write([]byte("echo mori-$((40+2))\r"))
	waitOutput(t, ctx, s, "mori-42") // Recv 반복, Credit(len) 후 누적 출력에서 찾는다
	s.Write([]byte("exit 3\r"))
	waitEvent(t, ctx, ev, "finished", run.Address)
	var ce *ClosedError
	if _, err := drain(ctx, s); !errors.As(err, &ce) || ce.Reason != "exited" || *ce.ExitCode != 3 { t.Fatal(err) }
}
```
Windows에서는 `/bin/sh` 대신 argv 없이(그 머신의 셸) 돌린다: `runtime.GOOS == "windows"`면 건너뛴다(Windows 통합은 §15에서 수동 확인).

- [ ] **Step 5: 통과 확인** — `go test -race ./internal/hc/ ./internal/hctest/` → PASS. 끝난 뒤 `ls .dev/test`가 비어 있다.

- [ ] **Step 6: 커밋 후 단계 2 푸시** — `git commit -m "feat(hc): attach 스트림, 이벤트 채널, hc connect, 격리 코어 테스트"` → `git push`. 스펙 §15.1을 실험 결과로 고친다(같은 커밋).

---

### Task 5: 이벤트 적용과 스냅숏 비교 (단계 3)

**Files:**
- Create: `internal/core/labels.go`, `internal/core/apply.go`
- Test: `internal/core/apply_test.go`

**Interfaces:**
- Produces:
```go
const (LabelMori = "mori"; LabelFolder = "mori.folder"; LabelPreset = "mori.preset"; LabelTitle = "mori.title")
func DisplayTitle(t hc.Terminal) string   // mori.title → 프로그램 title → foreground name → argv[0] 기본 이름 → "셸"
type Change struct {
	Address string
	Old     *hc.Terminal // nil: 새로 생김
	New     *hc.Terminal // nil: 지워짐
	Event   *hc.Event    // 이 변화를 만든 이벤트, 스냅숏 비교면 nil
}
type Cache map[string]*hc.Terminal
func NewCache(ts []hc.Terminal) Cache
func (c Cache) Apply(ev hc.Event) (Change, bool, error)  // bool: 바뀐 것이 있음
func Diff(a, b Cache) []Change                            // 주소 순
```

적용 규칙(README 표): created·restarted → 전체 교체, lost → `reason/exit_code/signal/finished_ms` 설정·`pid=nil`·`foreground=nil`(state는 그대로), keep → keep, finished → `state="finished"` + 네 값 + `foreground=nil`, removed → 삭제, status → `status/records/reported`, turn → `turn`, title → `title`, labels → `labels`(`record`가 있으면 그 레코드로 교체), size → `cols/rows`, foreground → 값 또는 nil, doc·모르는 type → 무시(false). 캐시에 없는 주소의 부분 이벤트는 무시한다.

- [ ] **Step 1: 실패하는 테스트**

```go
func ev(typ, addr, data string) hc.Event { return hc.Event{Type: typ, Terminal: addr, Data: json.RawMessage(data)} }

func TestApplyTable(t *testing.T) {
	c := NewCache(nil)
	ch, ok, _ := c.Apply(ev("created", "t1", `{"address":"t1","state":"live","argv":["sh"],"cwd":"/w","labels":{},"cols":80,"rows":24,"pid":10,"foreground":{"pid":11,"name":"vim","argv":["vim"],"cwd":"/w"}}`))
	if !ok || ch.Old != nil || ch.New.Address != "t1" { t.Fatal(ch) }
	c.Apply(ev("status", "t1", `{"status":{"state":"blocked","app":"claude-code"},"records":{},"reported":true}`))
	if c["t1"].Status.State != "blocked" || !c["t1"].Reported { t.Fatal("status") }
	ch, _, _ = c.Apply(ev("turn", "t1", `{"turn":2,"state":"done"}`))
	if c["t1"].Turn != 2 || ch.Old.Turn != 0 { t.Fatal("turn") }
	c.Apply(ev("size", "t1", `{"cols":120,"rows":40}`))
	c.Apply(ev("title", "t1", `{"title":"hello"}`))
	c.Apply(ev("labels", "t1", `{"labels":{"mori.title":"작업"}}`))
	c.Apply(ev("lost", "t1", `{"reason":"signaled","exit_code":null,"signal":9,"finished_ms":null}`))
	tt := c["t1"]
	if tt.Cols != 120 || tt.Title != "hello" || tt.Labels["mori.title"] != "작업" || tt.State != "live" || tt.Pid != nil || tt.Foreground != nil || *tt.Reason != "signaled" {
		t.Fatalf("%+v", tt)
	}
	c.Apply(ev("finished", "t1", `{"reason":"exited","exit_code":0,"signal":null,"finished_ms":5}`))
	if c["t1"].State != "finished" || *c["t1"].FinishedMs != 5 { t.Fatal("finished") }
	ch, ok, _ = c.Apply(ev("removed", "t1", `{}`))
	if !ok || ch.New != nil || len(c) != 0 { t.Fatal("removed") }
	if _, ok, _ := c.Apply(ev("title", "t9", `{"title":"x"}`)); ok { t.Fatal("unknown terminal must be ignored") }
	if _, ok, _ := c.Apply(hc.Event{Type: "doc", Data: json.RawMessage(`{"name":"x","version":1}`)}); ok { t.Fatal("doc ignored") }
}

func TestApplyDoesNotMutateOld(t *testing.T) {
	c := NewCache([]hc.Terminal{{Address: "t1", State: "live", Turn: 1}})
	ch, _, _ := c.Apply(ev("turn", "t1", `{"turn":2,"state":"idle"}`))
	if ch.Old.Turn != 1 || ch.New.Turn != 2 { t.Fatal("old must be a copy") }
}

func TestDiff(t *testing.T) {
	a := NewCache([]hc.Terminal{{Address: "t1", Turn: 1}, {Address: "t2"}})
	b := NewCache([]hc.Terminal{{Address: "t1", Turn: 2}, {Address: "t3"}})
	got := Diff(a, b)
	if len(got) != 3 || got[0].Address != "t1" || got[1].Address != "t2" || got[1].New != nil || got[2].Old != nil { t.Fatalf("%+v", got) }
	if len(Diff(b, b)) != 0 { t.Fatal("same snapshot must have no changes") }
}

func TestDisplayTitle(t *testing.T) {
	cases := []struct{ t hc.Terminal; want string }{
		{hc.Terminal{Labels: map[string]string{"mori.title": "리뷰"}, Title: "x"}, "리뷰"},
		{hc.Terminal{Title: "vim a.go"}, "vim a.go"},
		{hc.Terminal{Argv: []string{"/opt/bin/claude", "-p"}}, "claude"},
		{hc.Terminal{}, "셸"},
	}
	for _, c := range cases { if got := DisplayTitle(c.t); got != c.want { t.Errorf("%q want %q", got, c.want) } }
}
```

- [ ] **Step 2: 실패 확인** — `go test ./internal/core/` → 컴파일 실패.
- [ ] **Step 3: 구현** — 규칙대로. 복사는 `cloneTerminal`(JSON 왕복). 비교는 `reflect.DeepEqual`.
- [ ] **Step 4: 통과 확인** — `go test ./internal/core/` → PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(core): 이벤트 적용 규칙과 스냅숏 비교"`

---

### Task 6: 코어 관리자 (단계 3)

**Files:**
- Create: `internal/core/manager.go`
- Modify: `internal/server/errors.go`(`toAPIError`에 `hc.KindOf`, `core.ErrUnavailable`)
- Test: `internal/core/manager_test.go`

**Interfaces:**
- Consumes: `hc.Dial`, `hc.Locate`, `hc.Conn`, `Cache`, `Diff`.
- Produces:
```go
var ErrUnavailable = errors.New("core unavailable") // hc.KindOf와 같이 "core_unavailable"로 매핑
type Options struct {
	HC          string        // --hc; 비면 시도마다 Locate (업데이트로 경로가 바뀔 수 있다)
	Session     string        // --hc-session
	Env         []string      // nil이면 os.Environ()
	StartServer bool          // 첫 연결 실패 뒤 hc server start 한 번 (Windows)
	MinBackoff, MaxBackoff time.Duration // 기본 500ms, 10s
	Logger      *slog.Logger
	OnChange    func(Change)  // 알림기. 첫 스냅숏에는 부르지 않는다. 재연결·missed 비교에는 부른다
}
type Status struct { Connected bool; Version, Name, Error string } // json: connected, version, name, error (omitempty)
type Update struct { Change *Change; Core *Status }
func New(o Options) *Manager
func (m *Manager) Run(ctx context.Context)
func (m *Manager) Status() Status
func (m *Manager) Terminals() []hc.Terminal           // created_ms, address 순 복사본
func (m *Manager) Terminal(addr string) (hc.Terminal, bool)
func (m *Manager) Call(ctx context.Context, method string, params, result any) error
func (m *Manager) Attach(ctx context.Context, p hc.AttachParams) (*hc.Stream, hc.AttachResult, error)
func (m *Manager) Watch(buf int) *Watcher
type Watcher struct { C <-chan Update }
func (w *Watcher) Close()
func (w *Watcher) Lost() <-chan struct{}               // 버퍼가 넘쳐 끊김 → 구독자는 새 스냅숏부터 다시
```

동작:
1. 연결 루프: `Locate` → `Dial` → `Subscribe({})`. 실패하면 상태를 끊김(`Error`에 이유)으로 바꾸고 백오프(두 배씩, 최대 10초). `StartServer`면 첫 실패 뒤 `hc server start`(시간 제한 15초)를 한 번만.
2. 성공하면 백오프를 되돌린다. 새 스냅숏으로 캐시를 바꾼다. 이전 캐시가 있었으면(재연결) `Diff` 결과를 `OnChange`와 Watch로 보낸다. 처음이면 Watch로만 보낸다. 상태를 연결됨(`Version`=hello.version, `Name`=hello.core.name)으로 바꾼다.
3. 이벤트 루프: `seq <= lastSeq`는 버린다. `event`는 `Apply` 후 바뀌었으면 `OnChange` + Watch. `missed`는 새 스냅숏으로 `Diff`. `heartbeat`는 `lastSeq`만 갱신. 오류면 연결을 닫고 1로.
4. 끊길 때 캐시는 마지막 값으로 남긴다(UI는 `core.connected=false`로 표시). `Call`·`Attach`는 연결이 없으면 `ErrUnavailable`.
5. Watch 버퍼가 차면 그 Watcher를 닫고 `Lost`를 닫는다(브로드캐스트는 절대 막히지 않는다).

- [ ] **Step 1: 실패하는 테스트(격리 코어)**

```go
func TestManagerReconnectsAfterCoreRestart(t *testing.T) {
	core := hctest.Start(t)
	var mu sync.Mutex
	var changes []Change
	m := New(Options{HC: core.HC, Env: core.Env, MinBackoff: 100 * time.Millisecond, MaxBackoff: 500 * time.Millisecond,
		OnChange: func(c Change) { mu.Lock(); changes = append(changes, c); mu.Unlock() }})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := m.Watch(64)
	go m.Run(ctx)
	waitFor(t, func() bool { return m.Status().Connected })
	var run hc.Terminal
	if err := m.Call(ctx, "terminal.run", hc.RunParams{Argv: []string{"/bin/sh"}, Keep: true, NoParent: true}, &run); err != nil { t.Fatal(err) }
	waitFor(t, func() bool { _, ok := m.Terminal(run.Address); return ok })
	core.Cmd(t, "server", "restart") // 터미널은 유지된다
	waitFor(t, func() bool { return !m.Status().Connected })          // 끊김을 본다
	waitFor(t, func() bool { return m.Status().Connected })           // 다시 붙는다
	got, ok := m.Terminal(run.Address)
	if !ok || got.State != "live" { t.Fatalf("cache after restart: %+v %v", got, ok) }
	var list struct{ Terminals []hc.Terminal }
	m.Call(ctx, "terminal.list", map[string]any{}, &list)
	if len(list.Terminals) != len(m.Terminals()) { t.Fatal("cache differs from core") }
	sawCoreDown := false
	for drained := false; !drained; {
		select {
		case u := <-w.C:
			if u.Core != nil && !u.Core.Connected { sawCoreDown = true }
		default:
			drained = true
		}
	}
	if !sawCoreDown { t.Fatal("watchers must hear core down") }
}

func TestManagerUnavailableWithoutCore(t *testing.T) {
	m := New(Options{HC: "/nonexistent/hc", MinBackoff: 50 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.Run(ctx)
	if err := m.Call(ctx, "terminal.list", nil, nil); !errors.Is(err, ErrUnavailable) { t.Fatal(err) }
	waitFor(t, func() bool { return m.Status().Error != "" })
}

func TestFirstSnapshotDoesNotNotify(t *testing.T) {
	// 격리 코어에 터미널 하나를 미리 만든 뒤 Manager를 띄운다 → OnChange 호출 0번, Terminals()에는 있음.
}
```
(재연결 비교가 실제로 바뀐 것만 내는지는 Task 5 `TestDiff`가 고정한다. Review Focus 4.)

- [ ] **Step 2: 실패 확인** — `go test ./internal/core/` → 컴파일 실패.
- [ ] **Step 3: 구현** — 위 동작. `mu` 하나로 `conn`, `cache`, `status`, `watchers`를 보호하고, `OnChange`와 Watch 전송은 이벤트 순서대로 이벤트 고루틴 안에서 한다(잠금 밖).
- [ ] **Step 4: 통과 확인** — `go test -race ./internal/core/` → PASS.
- [ ] **Step 5: 커밋 후 단계 3 푸시** — `git commit -m "feat(core): 코어 관리자(재연결, 캐시, 방송)"` → `git push`.

---

### Task 7: 인증 (단계 4)

**Files:**
- Create: `internal/auth/codes.go`, `internal/auth/auth.go`
- Test: `internal/auth/auth_test.go`

**Interfaces:**
- Consumes: `store.Store`, `store.Device`, `store.NewID`.
- Produces:
```go
const CookieName = "mori_device"
var ErrBadCode = errors.New("auth: invalid or expired pairing code")
var ErrRateLimited = errors.New("auth: too many failed pairing attempts")
var ErrNotFound = errors.New("auth: device not found")
type Options struct { Now func() time.Time }
type Code struct { Code string; Name string; Expires time.Time }
func New(st *store.Store, o Options) *Auth
func (a *Auth) NewCode(name string) Code                                    // "XXXX-XXXX", 5분
func (a *Auth) Pair(code, name, userAgent string) (token string, dev store.Device, err error)
func (a *Auth) Device(r *http.Request) (store.Device, string, bool)         // 쿠키 → 기기, 토큰
func (a *Auth) Touch(w http.ResponseWriter, dev store.Device, token, userAgent string) // 1분에 한 번 last_seen, 쿠키 연장
func (a *Auth) Devices() []store.Device
func (a *Auth) Revoke(id string) error                                      // 기기와 그 푸시 구독을 지우고 OnRevoke 호출
func (a *Auth) OnRevoke(fn func(deviceID string))
func SetCookie(w http.ResponseWriter, token string)
func ClearCookie(w http.ResponseWriter)
func SameOrigin(r *http.Request) bool
func NormalizeCode(s string) string                                         // 대문자, -와 공백 제거, O→0, I/L→1
```
코드 문자는 Crockford base32(`0123456789ABCDEFGHJKMNPQRSTVWXYZ`). 기기 이름: 기기가 보낸 이름 → 코드에 붙은 이름 → `"기기"`, 64자에서 자른다. 해시 비교는 `subtle.ConstantTimeCompare`.

시도 제한(고정 창): 실패하면 창이 10분 지났을 때 새 창을 연다. 실패 수가 10 이상이면 창이 끝날 때까지 `Pair`는 코드도 보지 않고 `ErrRateLimited`.

`SameOrigin`: `Origin`이 없으면 false. `url.Parse(origin).Host`가 `r.Host`와 같거나, `X-Forwarded-Host`가 있으면 그것과 같으면 true(대소문자 무시).

- [ ] **Step 1: 실패하는 테스트**

```go
type clock struct{ t time.Time }
func (c *clock) now() time.Time { return c.t }

func newAuth(t *testing.T) (*Auth, *clock) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	c := &clock{time.Unix(1_800_000_000, 0)}
	return New(st, Options{Now: c.now}), c
}

func TestPairOnceAndAuthenticate(t *testing.T) {
	a, _ := newAuth(t)
	code := a.NewCode("iPhone")
	if !regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$`).MatchString(code.Code) { t.Fatal(code.Code) }
	tok, dev, err := a.Pair(strings.ToLower(code.Code), "", "UA")
	if err != nil || dev.Name != "iPhone" || len(tok) < 40 { t.Fatal(dev, err) }
	if _, _, err := a.Pair(code.Code, "x", "UA"); !errors.Is(err, ErrBadCode) { t.Fatal("code must be single use") }
	if strings.Contains(fmt.Sprint(a.Devices()), tok) { t.Fatal("token stored in clear") }
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: tok})
	if d, _, ok := a.Device(r); !ok || d.ID != dev.ID { t.Fatal("cookie auth") }
}

func TestCodeExpires(t *testing.T) {
	a, c := newAuth(t)
	code := a.NewCode("")
	c.t = c.t.Add(5*time.Minute + time.Second)
	if _, _, err := a.Pair(code.Code, "", ""); !errors.Is(err, ErrBadCode) { t.Fatal(err) }
}

func TestRateLimitLocksWindow(t *testing.T) {
	a, c := newAuth(t)
	for range 10 { a.Pair("AAAA-AAAA", "", "") }
	good := a.NewCode("")
	if _, _, err := a.Pair(good.Code, "", ""); !errors.Is(err, ErrRateLimited) { t.Fatal("locked window must refuse even good codes") }
	c.t = c.t.Add(10*time.Minute + time.Second)
	good = a.NewCode("")
	if _, _, err := a.Pair(good.Code, "", ""); err != nil { t.Fatal(err) }
}

func TestRevokeNotifies(t *testing.T) {
	a, _ := newAuth(t)
	tok, dev, _ := a.Pair(a.NewCode("").Code, "pc", "")
	var got string
	a.OnRevoke(func(id string) { got = id })
	if err := a.Revoke(dev.ID); err != nil || got != dev.ID { t.Fatal(err, got) }
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: tok})
	if _, _, ok := a.Device(r); ok { t.Fatal("revoked token still works") }
	if err := a.Revoke(dev.ID); !errors.Is(err, ErrNotFound) { t.Fatal(err) }
}

func TestSameOrigin(t *testing.T) {
	r := httptest.NewRequest("POST", "http://127.0.0.1:7761/api/x", nil)
	r.Host = "macmini.example.ts.net"
	for origin, want := range map[string]bool{"https://macmini.example.ts.net": true, "https://evil.example": false, "": false} {
		r.Header.Set("Origin", origin)
		if SameOrigin(r) != want { t.Errorf("%q", origin) }
	}
	r.Host = "127.0.0.1:7761"
	r.Header.Set("X-Forwarded-Host", "macmini.example.ts.net")
	r.Header.Set("Origin", "https://macmini.example.ts.net")
	if !SameOrigin(r) { t.Error("forwarded host") }
}

func TestCookieAttributes(t *testing.T) {
	rec := httptest.NewRecorder()
	SetCookie(rec, "tok")
	c := rec.Result().Cookies()[0]
	if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.MaxAge != 400*24*3600 { t.Fatalf("%+v", c) }
}
```

- [ ] **Step 2: 실패 확인** — `go test ./internal/auth/` → 컴파일 실패.
- [ ] **Step 3: 구현** — 위 규칙. 토큰은 `crypto/rand` 32바이트 → `base64.RawURLEncoding`. 해시는 `hex(sha256(token))`.
- [ ] **Step 4: 통과 확인** — `go test -race ./internal/auth/` → PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(auth): 페어링 코드, 기기 토큰, Origin 검사, 시도 제한"`

---

### Task 8: 서버 인증 경로, 관리 소켓, `mori pair·devices·revoke` (단계 4)

**Files:**
- Create: `internal/server/middleware.go`, `internal/server/hub.go`, `internal/server/api_auth.go`, `internal/server/ws_events.go`(인증 골격만, Task 10에서 채움), `internal/admin/admin.go`, `internal/tailscale/tailscale.go`, `cmd/mori/admincmd.go`
- Modify: `internal/server/server.go`(Deps에 `Auth`, `Store`, `PublicURL func() string`), `cmd/mori/serve.go`(store·auth·admin 조립)
- Test: `internal/server/auth_test.go`, `internal/admin/admin_test.go`

**Interfaces:**
- Consumes: `auth.*`, `store.*`.
- Produces:
```go
// server
func (s *Server) requireDevice(next http.Handler) http.Handler  // /api/** 중 공개 경로 외에는 401, 상태 변경·WS는 SameOrigin 아니면 403
func deviceFrom(ctx context.Context) (store.Device, bool)
type hub struct{...}                                              // 기기별 열린 WS
func (h *hub) add(deviceID string, close func(code websocket.StatusCode, reason string)) (remove func())
func (h *hub) closeDevice(deviceID string)                       // 4401로 닫는다
// admin
type Request struct { Op, Name, ID string }                       // json: op, name, id (omitempty)
type Response struct { Error, Code, URL string; ExpiresMs int64; Devices []DeviceInfo; Status json.RawMessage }
type DeviceInfo struct { ID, Name, UserAgent string; CreatedMs, LastSeenMs int64 }
type Handler interface {
	PairCode(name string) (code, url string, expires time.Time)
	Devices() []DeviceInfo
	Revoke(id string) error
	Status() any
	Shutdown()
}
func Serve(ctx context.Context, path string, h Handler) error   // 남은 소켓 지움, 0600, 연결마다 요청 한 줄 → 응답 한 줄
type Client struct{ Path string }
func (c Client) Do(req Request) (Response, error)               // 5초 시간 제한; 연결 실패는 "Mori 서버가 돌고 있지 않습니다" 안내
// tailscale
func Find() (string, error)                                      // PATH → /Applications/Tailscale.app/Contents/MacOS/Tailscale
func DNSName(ctx context.Context) (string, error)                // tailscale status --json → Self.DNSName (끝의 . 제거)
func ServeStatus(ctx context.Context) (json.RawMessage, error)   // tailscale serve status --json
func ProxiesTo(cfg json.RawMessage, target string) bool          // JSON 안의 "Proxy" 값 중 target이 있는지
```
REST(§7.1): `POST /api/pair {code, name}` → 204 + 쿠키(오류: 잘못된 코드 400 `invalid_params` "코드가 맞지 않거나 만료되었습니다", 제한 429 `rate_limited`). `POST /api/logout` → 이 기기 철회 + 쿠키 삭제, 204. `GET /api/devices` → `[{id, name, user_agent, created_ms, last_seen_ms, current}]`. `DELETE /api/devices/{id}` → 204 / 404. `POST /api/pair-codes {name?}` → `{code, url, expires_ms}`. `GET /api/hello`의 `paired`는 쿠키가 유효한지.

공개 URL(페어링 링크): `serve --public-url`, 없으면 시작할 때와 코드를 만들 때 `tailscale.DNSName`으로 `https://<이름>`, 그것도 없으면 `http://<listen>`. 링크는 `<url>/pair#code=XXXX-XXXX`.

CLI: `mori pair [--name N] [--home H]` → 코드, 만료 시각, 링크, QR(`qrterminal.GenerateHalfBlock(url, qrterminal.L, os.Stdout)`). `mori devices` → 표. `mori revoke <id>`.

- [ ] **Step 1: 실패하는 테스트**

`internal/server/auth_test.go` (Task 10·12에서 재사용하는 테스트 도우미 포함):
```go
type testEnv struct {
	t     *testing.T
	srv   *httptest.Server
	s     *Server
	auth  *auth.Auth
	store *store.Store
	token string
}

func newTestEnv(t *testing.T, opts ...func(*Deps)) *testEnv {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	a := auth.New(st, auth.Options{})
	d := Deps{Version: "test", HostName: "testhost", Store: st, Auth: a, UI: http.NotFoundHandler(), Logger: slog.Default()}
	for _, o := range opts { o(&d) }
	s := New(d)
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return &testEnv{t: t, srv: srv, s: s, auth: a, store: st}
}

// do sends a request with the device cookie (if paired) and a same-origin Origin header.
func (e *testEnv) do(method, path string, body any) *http.Response { ... }

func (e *testEnv) pair() store.Device {
	code := e.auth.NewCode("test")
	res := e.do("POST", "/api/pair", map[string]string{"code": code.Code, "name": "tester"})
	if res.StatusCode != 204 { e.t.Fatalf("pair %d", res.StatusCode) }
	for _, c := range res.Cookies() { if c.Name == auth.CookieName { e.token = c.Value } }
	return e.auth.Devices()[0]
}

func TestUnauthenticatedIs401ThenPairedIs200(t *testing.T) {
	e := newTestEnv(t)
	if r := e.do("GET", "/api/devices", nil); r.StatusCode != 401 { t.Fatal(r.StatusCode) }
	e.pair()
	if r := e.do("GET", "/api/devices", nil); r.StatusCode != 200 { t.Fatal(r.StatusCode) }
}

func TestCrossOriginPostIs403(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/pair-codes", strings.NewReader(`{}`))
	req.Header.Set("Origin", "https://evil.example")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: e.token})
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != 403 { t.Fatal(res.StatusCode) }
}

func TestRevokeClosesOpenWebSocket(t *testing.T) {
	e := newTestEnv(t)
	dev := e.pair()
	c := e.dialWS("/ws/events") // Cookie·Origin 헤더를 붙인 websocket.Dial
	if err := e.auth.Revoke(dev.ID); err != nil { t.Fatal(err) }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			if websocket.CloseStatus(err) != 4401 { t.Fatal(err) }
			return
		}
	}
}

func TestWebSocketWithoutCookieClosed4401(t *testing.T) { ... } // 쿠키 없이 /ws/events → CloseStatus 4401
```
`ws_events.go`는 이 태스크에서 인증·허브 등록·30초 ping만 하는 골격이다(Task 10에서 스냅숏과 방송을 더한다).

`internal/admin/admin_test.go`:
```go
type fakeHandler struct{ revoked string }
func (f *fakeHandler) PairCode(name string) (string, string, time.Time) { return "ABCD-EFGH", "https://h/pair#code=ABCD-EFGH", time.Unix(100, 0) }
func (f *fakeHandler) Devices() []DeviceInfo { return []DeviceInfo{{ID: "d_1", Name: "iPhone"}} }
func (f *fakeHandler) Revoke(id string) error { f.revoked = id; return nil }
func (f *fakeHandler) Status() any { return map[string]bool{"ok": true} }
func (f *fakeHandler) Shutdown() {}

func TestAdminRoundTrip(t *testing.T) {
	dir, _ := os.MkdirTemp("", "ma") // 짧은 경로(소켓 길이 제한)
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "mori.sock")
	os.WriteFile(path, nil, 0o600) // 남은 파일은 지우고 시작해야 한다
	h := &fakeHandler{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Serve(ctx, path, h)
	waitSocket(t, path)
	c := Client{Path: path}
	r, err := c.Do(Request{Op: "pair", Name: "iPhone"})
	if err != nil || r.Code != "ABCD-EFGH" || r.ExpiresMs != 100000 { t.Fatal(r, err) }
	r, _ = c.Do(Request{Op: "devices"})
	if len(r.Devices) != 1 { t.Fatal(r) }
	c.Do(Request{Op: "revoke", ID: "d_1"})
	if h.revoked != "d_1" { t.Fatal("revoke") }
	if r, _ := c.Do(Request{Op: "nope"}); r.Error == "" { t.Fatal("unknown op must error") }
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(path)
		if fi.Mode().Perm() != 0o600 { t.Fatal(fi.Mode()) }
	}
}
```

- [ ] **Step 2: 실패 확인** — `go test ./internal/server/ ./internal/admin/` → 컴파일 실패.
- [ ] **Step 3: 구현** — 위 인터페이스. 미들웨어는 `/api/`와 `/ws/` 경로에만 걸린다. 공개 경로는 `GET /api/hello`, `POST /api/pair`. `/ws/`는 기기가 없어도 핸들러까지 보내고, 핸들러가 수락 직후 4401로 닫는다. JSON 본문은 `http.MaxBytesReader` 1 MiB. `serve`에서 `auth.OnRevoke(s.hub.closeDevice)`를 잇고, 관리 핸들러를 `admin.Serve`로 연다.
- [ ] **Step 4: 통과 확인** — `go test -race ./internal/server/ ./internal/admin/ ./internal/auth/` → PASS. 수동: `go run ./cmd/mori serve --home .dev/h1`와 `go run ./cmd/mori pair --home .dev/h1`로 코드와 QR이 나온다.
- [ ] **Step 5: 커밋 후 단계 4 푸시** — `git commit -m "feat: 인증 경로, 관리 소켓, mori pair/devices/revoke"` → `git push`.

---

### Task 9: 터미널 REST API (단계 5)

**Files:**
- Create: `internal/server/view.go`, `internal/server/api_terminals.go`, `internal/server/api_settings.go`
- Modify: `internal/server/server.go`(Deps에 `Core *core.Manager`, `Resolve func(hc.Terminal) (folderID, worktree string)`; Task 12에서 실제 폴더 해석기로 바꾼다), `cmd/mori/serve.go`(core.Manager 조립)
- Test: `internal/server/terminals_test.go`

**Interfaces:**
- Consumes: `core.Manager`(`Terminals`, `Terminal`, `Call`, `Status`), `core.DisplayTitle`, `hc.*`, `store.Preset`, `store.Host`.
- Produces:
```go
type TerminalView struct {
	hc.Terminal
	FolderID     string `json:"folder_id"`
	Worktree     string `json:"worktree"`
	DisplayTitle string `json:"display_title"`
	Preset       string `json:"preset,omitempty"`
}
func (s *Server) view(t hc.Terminal) TerminalView
type createReq struct { FolderID, Worktree, Preset, Task, Title string; Cols, Rows int } // json: folder_id, worktree, preset, task, title, cols, rows
func runParams(f store.Folder, cwd string, p store.Preset, req createReq) hc.RunParams      // 순수 함수(테스트 대상)
func terminalParam(r *http.Request) string                                                  // r.PathValue("t") (%2F 풀림)
```
엔드포인트(§7.1): 목록(`?all=1`이면 끝난 것도. 기본은 live와 지난 24시간 안에 끝난 것), 하나, 만들기(201 + view), PATCH `{title}` → `terminal.label {labels: {"mori.title": title}}`(빈 문자열이면 라벨 삭제), DELETE → `terminal.rm`(204), send `{text, force}` → `terminal.send`, keys `{keys}` → `terminal.keys`, interrupt → `terminal.interrupt`, kill → `terminal.kill`, files(multipart `file`, 8 MB 넘으면 413 `invalid_params`) → `terminal.put {name, data(base64)}` → `{path, bytes}`, text `?lines=` → `terminal.read`. `GET /api/overview` → `{host:{name, version}, core, folders, terminals, presets, hosts}`. `GET/PUT /api/presets`(id `^[a-z0-9_-]{1,32}$` 중복 금지, 이름 필수, argv 항목 비지 않음), `GET/PUT /api/hosts`(이름 필수, URL은 http(s) 절대 주소).

`runParams` 규칙: `cwd`는 워크트리(주어지면) 또는 폴더 경로. argv는 프리셋 argv 복사본, `p.Task && req.Task != ""`이면 끝에 task. argv가 비면 생략(그 머신의 셸). 제목은 `req.Title` → task 앞 40자(룬 기준) → 프리셋 이름. cols·rows는 기본 80×24, 10~1000으로 자른다. 라벨·env·keep·no_parent는 Global Constraints대로.

- [ ] **Step 1: 실패하는 테스트**

```go
func TestRunParams(t *testing.T) {
	f := store.Folder{ID: "f_1", Path: "/repo"}
	p := store.Preset{ID: "claude", Name: "Claude Code", Argv: []string{"claude"}, Task: true}
	got := runParams(f, "/repo", p, createReq{Task: "버그 고쳐줘", Cols: 5, Rows: 5000})
	if !slices.Equal(got.Argv, []string{"claude", "버그 고쳐줘"}) || got.Cwd != "/repo" || !got.Keep || !got.NoParent { t.Fatalf("%+v", got) }
	if got.Labels["mori"] != "1" || got.Labels["mori.folder"] != "f_1" || got.Labels["mori.preset"] != "claude" || got.Labels["mori.title"] != "버그 고쳐줘" { t.Fatal(got.Labels) }
	if got.Env["TERM"] != "xterm-256color" || got.Env["COLORTERM"] != "truecolor" || got.Env["TERM_PROGRAM"] != "mori" { t.Fatal(got.Env) }
	if got.Size.Cols != 10 || got.Size.Rows != 1000 { t.Fatal(got.Size) }
	sh := runParams(f, "/repo", store.Preset{ID: "shell", Name: "셸"}, createReq{Task: "ignored"})
	if sh.Argv != nil || sh.Labels["mori.title"] != "셸" { t.Fatalf("%+v", sh) }
}

func TestTerminalAddressWithSlash(t *testing.T) { // Review Focus 3
	var got string
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/terminals/{t}", func(w http.ResponseWriter, r *http.Request) { got = terminalParam(r) })
	mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/terminals/rohan%2Ft7", nil))
	if got != "rohan/t7" { t.Fatalf("%q", got) }
}

func TestTerminalLifecycleOverHTTP(t *testing.T) {
	core := hctest.Start(t)
	e := newTestEnv(t, withCore(t, core)) // Manager를 띄우고 연결될 때까지 기다리는 옵션
	e.pair()
	f := e.addFolder(t.TempDir())          // 이 태스크에서는 store.Update로 직접 넣는다
	var tv TerminalView
	e.json("POST", "/api/terminals", map[string]any{"folder_id": f.ID, "preset": "shell", "title": "테스트", "cols": 90, "rows": 30}, 201, &tv)
	if tv.Address == "" || tv.State != "live" || tv.DisplayTitle != "테스트" { t.Fatalf("%+v", tv) }
	e.waitTerminal(tv.Address) // GET /api/terminals 목록에 보일 때까지
	e.json("POST", "/api/terminals/"+url.PathEscape(tv.Address)+"/send", map[string]any{"text": "echo hi-$((1+1))"}, 200, nil)
	e.eventually(func() bool {
		var r struct{ Text string }
		e.json("GET", "/api/terminals/"+tv.Address+"/text", nil, 200, &r)
		return strings.Contains(r.Text, "hi-2")
	})
	e.json("PATCH", "/api/terminals/"+tv.Address, map[string]any{"title": "새 이름"}, 200, nil)
	e.eventually(func() bool { var v TerminalView; e.json("GET", "/api/terminals/"+tv.Address, nil, 200, &v); return v.DisplayTitle == "새 이름" })
	e.expectError("DELETE", "/api/terminals/"+tv.Address, nil, 409) // 살아 있으면 rm 거부
	e.json("POST", "/api/terminals/"+tv.Address+"/kill", nil, 200, nil)
	e.eventually(func() bool { var v TerminalView; e.json("GET", "/api/terminals/"+tv.Address, nil, 200, &v); return v.State == "finished" })
	e.json("DELETE", "/api/terminals/"+tv.Address, nil, 204, nil)
	e.expectError("GET", "/api/terminals/t999", nil, 404)
}

func TestCoreDownIs503(t *testing.T) {
	e := newTestEnv(t, withManager(core.New(core.Options{HC: "/nonexistent/hc"})))
	e.pair()
	e.expectError("GET", "/api/terminals/t1/text", nil, 503) // kind core_unavailable
}

func TestPresetsValidation(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	e.expectError("PUT", "/api/presets", []map[string]any{{"id": "Bad Id", "name": "x", "argv": []string{}}}, 400)
	e.json("PUT", "/api/presets", []map[string]any{{"id": "aider", "name": "Aider", "argv": []string{"aider"}, "task": false}}, 200, nil)
}
```

- [ ] **Step 2: 실패 확인** — `go test ./internal/server/` → 컴파일 실패.
- [ ] **Step 3: 구현** — 위 규칙. `GET /api/terminals/{t}`는 캐시에서 찾고, 없으면 `terminal.get`을 호출한다(방금 만든 터미널).
- [ ] **Step 4: 통과 확인** — `go test -race ./internal/server/` → PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(server): 터미널 REST API, 프리셋, 호스트 링크"`

---

### Task 10: 이벤트 WS와 attach WS 브리지 (단계 5)

**Files:**
- Modify: `internal/server/ws_events.go`(스냅숏, 방송, folders 신호)
- Create: `internal/server/ws_attach.go`, `internal/presence/presence.go`
- Test: `internal/server/ws_test.go`, `internal/presence/presence_test.go`

**Interfaces:**
- Consumes: `core.Manager.Watch`, `core.Manager.Attach`, `hc.Stream`, `hub`.
- Produces:
```go
// presence
func New() *Registry
func (r *Registry) Set(addr, viewer string, focused bool)
func (r *Registry) Remove(addr, viewer string)
func (r *Registry) Focused(addr string) bool
// server
func (s *Server) FoldersChanged()   // 모든 이벤트 WS에 folders와 소속이 바뀐 terminal을 보내라는 신호(채널 cap 1, 막히지 않음, 스펙 결정 52)
func closeCodeFor(err error, keep bool) (websocket.StatusCode, *closedMsg)  // 순수 함수(테스트 대상)
```
이벤트 WS(§7.2): 접속하면 `{type:"snapshot", core, folders, terminals}`. 그다음 Watcher 업데이트마다 `{type:"terminal", terminal: view}` / `{type:"removed", address}` / `{type:"core", connected, version, name}`. FoldersChanged 신호면 `{type:"folders", folders}`와 소속이 바뀐 터미널(스펙 결정 52). 30초마다 `{type:"ping"}`. Watcher `Lost`면 1013(다시 시도)으로 닫는다.

attach WS(§7.3): 쿼리 `t`, `cols`, `rows`(기본 80×24, 10~1000으로 맞춤), `history`(기본 1000, 최대 10000), `observe`, `resumed`. 수락 → 허브 등록 → `Attach`(observe면 `ResizeNotifications: true`). 실패하면 `not_found` → 4404, `unavailable` → 4409, `finished` → `closed` 메시지(`terminal.get` 레코드의 이유, 스펙 결정 58) + 1000, 연결 없음 → 4503. 성공하면 `{type:"attached", terminal: view, cols, rows}`.
- 코어 → 브라우저: `Recv` → 이진 쓰기 → `Credit(len)`. `Size` → `{type:"size"}`. 같은 터미널의 `size` 이벤트(Watcher)도 `{type:"size"}`로.
- 브라우저 → 코어: 이진 → `Write`. 텍스트 JSON: `resize` → `Resize`, `focus` → `Focus` + presence, `display` → `Facts`. 모르는 type은 무시.
- 끝: `*hc.ClosedError` → keep 터미널이고 이유가 `exited`·`killed`가 아니면 4409(복구 대기), 아니면 `{type:"closed", reason, exit_code, signal}` + 1000. `hc.ErrClosed` → 4503. 브라우저가 끊으면 `stream.Close()`(detach). 언제나 presence에서 뺀다.

- [ ] **Step 1: 실패하는 테스트**

```go
func TestCloseCodeFor(t *testing.T) {
	zero := 0
	exited := &hc.ClosedError{CloseReason: hc.CloseReason{Reason: "exited", ExitCode: &zero}}
	if code, msg := closeCodeFor(exited, true); code != 1000 || msg.Reason != "exited" { t.Fatal(code) }
	lost := &hc.ClosedError{CloseReason: hc.CloseReason{Reason: "holder_lost"}}
	if code, _ := closeCodeFor(lost, true); code != 4409 { t.Fatal(code) }
	if code, _ := closeCodeFor(lost, false); code != 1000 { t.Fatal(code) }
	if code, _ := closeCodeFor(hc.ErrClosed, true); code != 4503 { t.Fatal(code) }
}

func TestAttachRoundTripSizeAndClose(t *testing.T) {
	core := hctest.Start(t)
	e := newTestEnv(t, withCore(t, core))
	e.pair()
	tv := e.createShell() // POST /api/terminals (preset shell)
	ws := e.dialWS("/ws/attach?t=" + url.QueryEscape(tv.Address) + "&cols=80&rows=24")
	first := e.readJSON(ws)
	if first["type"] != "attached" { t.Fatal(first) }
	ws.Write(ctx, websocket.MessageBinary, []byte("echo ws-$((2+3))\r"))
	e.readUntilBinary(ws, "ws-5")
	ws.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":100,"rows":30}`))
	e.readUntilJSON(ws, func(m map[string]any) bool { return m["type"] == "size" && m["cols"] == 100.0 }) // size 이벤트가 돌아온다
	ws.Write(ctx, websocket.MessageBinary, []byte("exit 7\r"))
	msg := e.readUntilJSON(ws, func(m map[string]any) bool { return m["type"] == "closed" })
	if msg["reason"] != "exited" || msg["exit_code"] != 7.0 { t.Fatal(msg) }
	if _, _, err := ws.Read(ctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure { t.Fatal(err) }
}

func TestAttachUnknownTerminal4404(t *testing.T) { ... }       // t=t999 → 4404

func TestAttachCoreLoss4503(t *testing.T) {                       // Review Focus 4
	// attach 후 core.Cmd(t, "server", "restart") → CloseStatus 4503
}

func TestEventsSnapshotThenTerminalUpdates(t *testing.T) {
	// /ws/events → snapshot(core.connected=true) → POST /api/terminals → {type:"terminal"} 중 그 주소 → kill → state finished 업데이트
}

func TestSessionSurvivesMoriRestart(t *testing.T) {
	core := hctest.Start(t)
	e1 := newTestEnv(t, withCore(t, core))
	e1.pair()
	tv := e1.createShell()
	e1.close() // 서버와 Manager(hc connect)를 끈다
	e2 := newTestEnv(t, withCore(t, core), withStore(e1.store)) // 같은 state.json, 새 서버
	e2.token = e1.token
	var v TerminalView
	e2.json("GET", "/api/terminals/"+tv.Address, nil, 200, &v)
	if v.State != "live" { t.Fatal("session died with Mori") }
}
```
`presence_test.go`: 두 뷰어 중 하나만 포커스면 `Focused` true, 그 뷰어를 Remove하면 false.

- [ ] **Step 2: 실패 확인** — `go test ./internal/server/ ./internal/presence/` → FAIL.
- [ ] **Step 3: 구현** — 위 규칙. WS 쓰기는 `context.WithTimeout(10s)`. `websocket.Accept`에는 `InsecureSkipVerify: true`(Origin은 미들웨어가 이미 `SameOrigin`으로 검사했다; `X-Forwarded-Host` 지원 때문)와 `CompressionMode: websocket.CompressionDisabled`를 준다. 읽기 한도는 `SetReadLimit(1 << 20)`.
- [ ] **Step 4: 통과 확인** — `go test -race ./internal/server/ ./internal/presence/` → PASS.
- [ ] **Step 5: 커밋 후 단계 5 푸시** — `git commit -m "feat(server): 이벤트 WS와 attach 브리지"` → `git push`.

---

### Task 11: `internal/gitx` (단계 6)

**Files:**
- Create: `internal/gitx/gitx.go`, `internal/gitx/parse.go`
- Test: `internal/gitx/parse_test.go`, `internal/gitx/gitx_test.go`
- Modify: `internal/server/errors.go`(`*gitx.Error` → 422 `git_failed`, 메시지는 stderr 앞 400자)

**Interfaces:**
- Produces:
```go
type Runner struct { Path string; Timeout time.Duration }    // 기본 "git", 10s
type Error struct { Args []string; Stderr string; Err error }
type Change struct { Path, Orig, Index, Worktree, Kind string } // json: path, orig(omitempty), index, worktree, kind(changed|renamed|unmerged|untracked)
type Status struct { Head, Branch string; Detached bool; Upstream string; Ahead, Behind int; Changes []Change }
type Worktree struct { Path, Head, Branch string; Main, Bare, Detached, Locked, Prunable bool }
type Branch struct { Name, Head, Upstream string; Current, Remote bool }
type Branches struct { Local, Remote []Branch }
func ParseStatus(b []byte) (Status, error)        // git status --porcelain=v2 --branch -z
func ParseWorktrees(b []byte) ([]Worktree, error) // git worktree list --porcelain -z
func ParseBranches(b []byte) (Branches, error)    // for-each-ref (아래 형식)
func (g Runner) Status(ctx, dir string) (Status, error)
func (g Runner) Worktrees(ctx, dir string) ([]Worktree, error)
func (g Runner) Branches(ctx, dir string) (Branches, error)
func (g Runner) Diff(ctx, dir, file string, staged bool, limit int) (diff string, truncated bool, err error)
func (g Runner) AddWorktree(ctx, repo, path, branch string, create bool, base string) error
func (g Runner) RemoveWorktree(ctx, repo, path string, force bool) error
func IsRepo(dir string) bool                       // dir/.git 존재(파일이나 디렉터리)
func WorktreePath(mainRoot, branch string) string  // <부모>/<이름>.wt/<슬러그>; 있으면 -2, -3…
func BranchSlug(branch string) string              // [A-Za-z0-9._-] 밖은 -, 연속 - 하나로, 앞뒤 -. 제거, 비면 "wt"
func SafeRelPath(file string) bool                 // 상대 경로, .. 성분 없음, 비지 않음
```
모든 실행: `git -c core.quotepath=off -c color.ui=false <args>`, `cmd.Dir = dir`, env에 `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, 시간 제한, `procutil.HideWindow`. 브랜치 목록 형식: `for-each-ref --format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD) refs/heads refs/remotes`(`refs/remotes/*/HEAD` 제외). diff: 추적되는 파일은 `diff --no-color --no-ext-diff [--cached] -- <file>`, 추적 안 되는 파일(`status -- <file>`이 `?`)은 `diff --no-color --no-index -- /dev/null <file>`(종료 코드 1도 성공). `limit` 바이트에서 자르고 `truncated=true`. 브랜치·base가 `-`로 시작하면 거부, `check-ref-format --branch`로 검사.

- [ ] **Step 1: 실패하는 테스트(고정 입력)**

```go
func TestParseStatus(t *testing.T) { // Review Focus 5: 한글·공백 파일명
	in := strings.Join([]string{
		"# branch.oid 1111111111111111111111111111111111111111",
		"# branch.head main",
		"# branch.upstream origin/main",
		"# branch.ab +2 -1",
		"1 .M N... 100644 100644 100644 aaaa bbbb 문서/새 파일.md",
		"1 A. N... 000000 100644 100644 0000 cccc added.go",
		"2 R. N... 100644 100644 100644 dddd eeee R100 new name.go", "old name.go",
		"u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.txt",
		"? 추적 안 됨.txt",
		"",
	}, "\x00")
	st, err := ParseStatus([]byte(in))
	if err != nil { t.Fatal(err) }
	if st.Branch != "main" || st.Upstream != "origin/main" || st.Ahead != 2 || st.Behind != 1 || st.Head == "" { t.Fatalf("%+v", st) }
	want := []Change{
		{Path: "문서/새 파일.md", Index: ".", Worktree: "M", Kind: "changed"},
		{Path: "added.go", Index: "A", Worktree: ".", Kind: "changed"},
		{Path: "new name.go", Orig: "old name.go", Index: "R", Worktree: ".", Kind: "renamed"},
		{Path: "conflict.txt", Index: "U", Worktree: "U", Kind: "unmerged"},
		{Path: "추적 안 됨.txt", Index: "?", Worktree: "?", Kind: "untracked"},
	}
	if !reflect.DeepEqual(st.Changes, want) { t.Fatalf("%+v", st.Changes) }
}

func TestParseStatusDetachedInitial(t *testing.T) {
	st, _ := ParseStatus([]byte("# branch.oid (initial)\x00# branch.head (detached)\x00"))
	if !st.Detached || st.Branch != "" || st.Head != "" { t.Fatalf("%+v", st) }
}

func TestParseWorktrees(t *testing.T) {
	in := "worktree /r/app\x00HEAD aaaa\x00branch refs/heads/main\x00\x00" +
		"worktree /r/app.wt/feat x\x00HEAD bbbb\x00branch refs/heads/feat/x\x00locked\x00\x00" +
		"worktree /r/app.wt/old\x00HEAD cccc\x00detached\x00prunable gitdir file points to non-existent location\x00\x00"
	wts, err := ParseWorktrees([]byte(in))
	if err != nil || len(wts) != 3 { t.Fatal(wts, err) }
	if !wts[0].Main || wts[0].Branch != "main" || wts[1].Path != "/r/app.wt/feat x" || wts[1].Branch != "feat/x" || !wts[1].Locked || !wts[2].Detached || !wts[2].Prunable { t.Fatalf("%+v", wts) }
}

func TestBranchSlugAndPath(t *testing.T) {
	for in, want := range map[string]string{"feat/login": "feat-login", "fix//a b": "fix-a-b", "-x-": "x", "한글": "wt"} {
		if got := BranchSlug(in); got != want { t.Errorf("%q → %q want %q", in, got, want) }
	}
	if got := WorktreePath(filepath.FromSlash("/r/app"), "feat/a"); got != filepath.FromSlash("/r/app.wt/feat-a") { t.Fatal(got) }
}

func TestSafeRelPath(t *testing.T) {
	for p, ok := range map[string]bool{"a/b.go": true, "../x": false, "/etc/passwd": false, "a/../../x": false, "": false, `C:\x`: false} {
		if SafeRelPath(p) != ok { t.Errorf("%q", p) }
	}
}
```
`gitx_test.go`(실제 git, 임시 저장소): `git init -b main`, 커밋 하나, 파일 수정·추가 → `Status` 변경 2건, `Diff`가 `+` 줄 포함, 추적 안 된 파일 diff가 `/dev/null` 헤더 포함, `AddWorktree(create)` → `Worktrees` 2개, `RemoveWorktree` → 1개. `git`이 없으면 건너뛴다.

- [ ] **Step 2: 실패 확인** — `go test ./internal/gitx/` → 컴파일 실패.
- [ ] **Step 3: 구현** — 위 규칙. `ParseStatus`는 NUL로 나눈 필드를 차례로 읽고, `2`로 시작하는 항목은 다음 필드를 `Orig`로 먹는다. 경로는 `1` 항목의 9번째 공백 뒤 나머지 전부(공백 포함)다(`strings.SplitN(field, " ", 9)`; `2`는 10, `u`는 11).
- [ ] **Step 4: 통과 확인** — `go test -race ./internal/gitx/` → PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(gitx): git 상태·워크트리·브랜치·diff"`

---

### Task 12: 폴더 소속과 폴더·Git API (단계 6)

**Files:**
- Create: `internal/folders/folders.go`, `internal/server/api_folders.go`, `internal/server/api_git.go`
- Modify: `internal/server/server.go`(Deps에 `Folders *folders.Resolver`, `Git gitx.Runner`; `Resolve`를 해석기로), `cmd/mori/serve.go`(해석기 30초 갱신 고루틴, `onChange: srv.FoldersChanged`)
- Test: `internal/folders/folders_test.go`, `internal/server/folders_test.go`

**Interfaces:**
- Consumes: `store.Folder`, `gitx.Runner`, `gitx.Worktree`, `core.LabelFolder`.
- Produces:
```go
func New(st *store.Store, git gitx.Runner) *Resolver
func (r *Resolver) Resolve(t hc.Terminal) (folderID, worktree string)
func (r *Resolver) Refresh(ctx context.Context, folderID string) ([]gitx.Worktree, error)  // 바뀌면 onChange
func (r *Resolver) RefreshAll(ctx context.Context)
func (r *Resolver) Run(ctx context.Context, every time.Duration, onChange func())
func (r *Resolver) Worktrees(folderID string) []gitx.Worktree
func (r *Resolver) Owner(path string) (folderID string, wt gitx.Worktree, ok bool)          // path가 어느 폴더의 워크트리인가
func Canonical(path string) (string, error)                                                 // Abs → Clean → EvalSymlinks
```
소속 순서(§5): 라벨 `mori.folder`가 등록된 폴더면 그 폴더, 워크트리는 그 폴더 워크트리 중 cwd를 품는 가장 깊은 것. 라벨이 없거나 모르는 폴더면 등록 폴더 경로와 모든 워크트리 경로 중 cwd를 품는 가장 깊은 것. 아무 데도 없으면 `("", "")`(UI의 "기타"). cwd가 바로 맞지 않으면 `EvalSymlinks(cwd)`로 한 번 더 본다(결과는 작은 맵에 캐시, Review Focus 5). Windows는 대소문자를 무시하고 비교한다.

REST(§7.1): 폴더 목록 `[{id, name, path, created_ms, repo}]`; 등록 `{path, name?}` → `Canonical`, 디렉터리여야 함, 같은 경로가 있으면 409 `conflict`, id `f_xxxxxxxx`, 등록 뒤 `Refresh` + `FoldersChanged`; PATCH `{name}`; DELETE(파일은 건드리지 않음). `GET /api/fs?path=&hidden=0`(기본 경로는 홈, 절대 경로만, 디렉터리만, 이름순(대소문자 무시), 숨김 제외, 2000개까지 + `truncated`) → `{path, parent, entries:[{name, path, git}]}`. `GET /api/folders/{id}/git` → 저장소가 아니면 `{repo:false}`, 맞으면 `{repo:true, branch, upstream, ahead, behind, changes(개수), worktrees}`. `/branches`. `POST /worktrees {branch, create, base?}` → 주 워크트리 경로로 `WorktreePath` → `AddWorktree` → `Refresh` → `FoldersChanged` → 201 `{path}`. `DELETE /worktrees?path=&force=0` → 그 폴더의 워크트리이고 주 워크트리가 아니어야 함(아니면 400), 그 워크트리로 해석되는 live 터미널이 있으면 409 `live` "이 워크트리에서 실행 중인 세션이 있습니다" → `RemoveWorktree`. `GET /api/git/status?path=`와 `/api/git/diff?path=&file=&staged=0`은 `Owner(path)`로 검증(모르면 한 번 `RefreshAll` 후 다시), `SafeRelPath(file)`, diff 한도 1 MiB → `{diff, truncated}`.

- [ ] **Step 1: 실패하는 테스트**

`folders_test.go`:
```go
func TestResolveOrder(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	st.Update(func(s *store.State) error {
		s.Folders = []store.Folder{{ID: "f_a", Path: "/w/app"}, {ID: "f_b", Path: "/w/app/sub"}, {ID: "f_c", Path: "/w/other"}}
		return nil
	})
	r := New(st, gitx.Runner{})
	r.setWorktrees("f_a", []gitx.Worktree{{Path: "/w/app", Main: true}, {Path: "/w/app.wt/feat"}}) // 테스트용 비공개 설정
	cases := []struct{ cwd string; labels map[string]string; id, wt string }{
		{"/w/app/src", nil, "f_a", "/w/app"},
		{"/w/app/sub/x", nil, "f_b", ""},                                // 더 깊은 등록 폴더
		{"/w/app.wt/feat/pkg", nil, "f_a", "/w/app.wt/feat"},           // 워크트리
		{"/w/other", map[string]string{"mori.folder": "f_a"}, "f_a", ""}, // 라벨이 먼저
		{"/w/other", map[string]string{"mori.folder": "f_gone"}, "f_c", ""},
		{"/elsewhere", nil, "", ""},
		{"/w/application", nil, "", ""},                                // 접두사만 같은 형제는 아님
	}
	for _, c := range cases {
		id, wt := r.Resolve(hc.Terminal{Cwd: c.cwd, Labels: c.labels})
		if id != c.id || wt != c.wt { t.Errorf("%s → (%s,%s) want (%s,%s)", c.cwd, id, wt, c.id, c.wt) }
	}
}

func TestResolveThroughSymlink(t *testing.T) { // Review Focus 5
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil { t.Skip(err) }
	canon, _ := Canonical(real)
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	st.Update(func(s *store.State) error { s.Folders = []store.Folder{{ID: "f_a", Path: canon}}; return nil })
	if id, _ := New(st, gitx.Runner{}).Resolve(hc.Terminal{Cwd: link}); id != "f_a" { t.Fatal(id) }
}
```

`internal/server/folders_test.go`(단계 6 완료 기준):
```go
func TestWorktreeLifecycleRefusesLiveSession(t *testing.T) {
	core := hctest.Start(t)
	e := newTestEnv(t, withCore(t, core), withFolders())
	e.pair()
	repo := gitRepo(t) // 임시 저장소 + 첫 커밋
	var f struct{ ID string }
	e.json("POST", "/api/folders", map[string]any{"path": repo}, 201, &f)
	var wt struct{ Path string }
	e.json("POST", "/api/folders/"+f.ID+"/worktrees", map[string]any{"branch": "feat/x", "create": true}, 201, &wt)
	if !strings.HasSuffix(wt.Path, filepath.Join(filepath.Base(repo)+".wt", "feat-x")) { t.Fatal(wt.Path) }
	var tv TerminalView
	e.json("POST", "/api/terminals", map[string]any{"folder_id": f.ID, "worktree": wt.Path, "preset": "shell"}, 201, &tv)
	e.eventually(func() bool { var v TerminalView; e.json("GET", "/api/terminals/"+tv.Address, nil, 200, &v); return v.Worktree == wt.Path })
	e.expectError("DELETE", "/api/folders/"+f.ID+"/worktrees?path="+url.QueryEscape(wt.Path), nil, 409)
	e.json("POST", "/api/terminals/"+tv.Address+"/kill", nil, 200, nil)
	e.eventually(func() bool { var v TerminalView; e.json("GET", "/api/terminals/"+tv.Address, nil, 200, &v); return v.State == "finished" })
	e.json("DELETE", "/api/folders/"+f.ID+"/worktrees?path="+url.QueryEscape(wt.Path), nil, 204, nil)
}

func TestGitDiffRejectsEscapingPaths(t *testing.T) {
	// 등록 안 된 path → 400, file=../x → 400, 등록된 워크트리의 수정 파일 → 200 + "+" 줄
}

func TestFsListsDirectoriesOnly(t *testing.T) {
	// tmp/{a, .hidden, f.txt, r/.git} → entries [a, r(git:true)], hidden=1이면 .hidden 포함
}
```

- [ ] **Step 2: 실패 확인** — `go test ./internal/folders/ ./internal/server/` → FAIL.
- [ ] **Step 3: 구현** — 위 규칙. `Refresh`는 저장소가 아니면 빈 목록을 캐시한다.
- [ ] **Step 4: 통과 확인** — `go test -race ./internal/folders/ ./internal/server/` → PASS.
- [ ] **Step 5: 커밋 후 단계 6 푸시** — `git commit -m "feat: 폴더 소속, 폴더·Git·워크트리 API"` → `git push`.

---

### Task 13: 알림 (단계 7)

**Files:**
- Create: `internal/push/decide.go`, `internal/push/push.go`, `internal/push/webpush.go`, `internal/server/api_push.go`
- Modify: `cmd/mori/serve.go`(VAPID 보장, Notifier를 `core.Options.OnChange`에), `internal/server/server.go`(Deps에 `Push *push.Notifier`, `Presence *presence.Registry`)
- Test: `internal/push/decide_test.go`, `internal/push/push_test.go`, `internal/server/push_test.go`

**Interfaces:**
- Consumes: `core.Change`, `core.DisplayTitle`, `presence.Registry.Focused`, `store.PushSub`, `store.VAPID`.
- Produces:
```go
type Kind string
const (KindBlocked Kind = "blocked"; KindWaiting Kind = "waiting"; KindError Kind = "error"; KindExited Kind = "exited")
var DefaultKinds = []Kind{KindBlocked, KindWaiting, KindError}
func Decide(c core.Change, children bool) Kind   // "" = 알림 없음
type Payload struct { Title, Body, Tag, URL string } // json: title, body, tag, url
type Sender interface { Send(ctx context.Context, sub store.PushSub, payload []byte) (status int, err error) }
type Options struct { Store *store.Store; Sender Sender; Focused func(addr string) bool; Host string; Now func() time.Time; Window time.Duration; Logger *slog.Logger }
func New(o Options) *Notifier
func (n *Notifier) OnChange(c core.Change)
func (n *Notifier) Wait()                                           // 테스트: 진행 중 발송을 기다림
func (n *Notifier) Subscribe(deviceID string, sub Subscription, kinds []Kind) (store.PushSub, error) // endpoint 기준 upsert
func (n *Notifier) Unsubscribe(endpoint string) error
func (n *Notifier) Test(ctx context.Context, deviceID string) (int, error)
type Subscription struct { Endpoint string; Keys struct{ P256dh, Auth string } } // PushSubscription.toJSON()
func EnsureVAPID(st *store.Store) (store.VAPID, error)
func NewWebPush(st *store.Store, subject string) Sender           // webpush-go, TTL 1일, Urgency high
```
판정(§6.5): `New==nil`이면 없음. `children==false`이고 부모가 있으면 없음. 이벤트가 있으면 `status`: 새 상태가 `blocked`이고 이전이 아니면 blocked, `error`이고 이전이 아니면 error. `turn`: data의 `state`가 `done`·`idle`이면 waiting. `finished`면 exited. 스냅숏 비교(Event==nil, Old!=nil)면 같은 상태 규칙, 그다음 `New.Turn > Old.Turn`이고 새 상태가 done·idle이면 waiting, live → finished면 exited. Old==nil이면 없음.

발송: 판정 뒤 `Focused(addr)`면 버림. `(addr, kind)`가 `Window`(기본 10초) 안에 이미 나갔으면 버림. 구독마다 그 종류를 켰을 때만 보낸다(`Kinds`가 비면 DefaultKinds). 페이로드 `{title: "<host> · 승인 대기", body: "<제목> — <status.msg>", tag: addr, url: "/#/t/<addr>"}`. 문구: blocked "승인 대기", waiting "입력 대기", error "오류", exited "종료". 응답 404·410이면 그 구독을 지운다.

REST: `GET /api/push/key` → `{key}`. `POST /api/push/subscriptions {subscription, kinds?}` → 201 `{id, kinds}`. `DELETE /api/push/subscriptions {endpoint}` → 204. `POST /api/push/test` → `{sent}`.

- [ ] **Step 1: 실패하는 테스트**

```go
func term(addr, state string, turn int, parent *string) *hc.Terminal {
	t := &hc.Terminal{Address: addr, State: "live", Turn: turn, Parent: parent}
	if state != "" { t.Status = &hc.Status{State: state} }
	return t
}

func TestDecide(t *testing.T) {
	p := "t1"
	evt := func(typ, data string) *hc.Event { return &hc.Event{Type: typ, Data: json.RawMessage(data)} }
	cases := []struct{ name string; c core.Change; children bool; want Kind }{
		{"blocked", core.Change{Old: term("t2", "working", 0, nil), New: term("t2", "blocked", 0, nil), Event: evt("status", `{}`)}, false, KindBlocked},
		{"still blocked", core.Change{Old: term("t2", "blocked", 0, nil), New: term("t2", "blocked", 0, nil), Event: evt("status", `{}`)}, false, ""},
		{"turn done", core.Change{Old: term("t2", "working", 0, nil), New: term("t2", "done", 1, nil), Event: evt("turn", `{"turn":1,"state":"done"}`)}, false, KindWaiting},
		{"turn blocked is not waiting", core.Change{Old: term("t2", "working", 0, nil), New: term("t2", "blocked", 1, nil), Event: evt("turn", `{"turn":1,"state":"blocked"}`)}, false, ""},
		{"error", core.Change{Old: term("t2", "working", 0, nil), New: term("t2", "error", 0, nil), Event: evt("status", `{}`)}, false, KindError},
		{"child skipped", core.Change{Old: term("t3", "working", 0, &p), New: term("t3", "blocked", 0, &p), Event: evt("status", `{}`)}, false, ""},
		{"child allowed", core.Change{Old: term("t3", "working", 0, &p), New: term("t3", "blocked", 0, &p), Event: evt("status", `{}`)}, true, KindBlocked},
		{"snapshot turn", core.Change{Old: term("t2", "working", 3, nil), New: term("t2", "idle", 4, nil)}, false, KindWaiting},
		{"created", core.Change{New: term("t2", "blocked", 0, nil)}, false, ""},
	}
	for _, c := range cases { if got := Decide(c.c, c.children); got != c.want { t.Errorf("%s: %q want %q", c.name, got, c.want) } }
}

type fakeSender struct { mu sync.Mutex; sent []store.PushSub; payloads []Payload; status int }
func (f *fakeSender) Send(ctx context.Context, sub store.PushSub, b []byte) (int, error) { ... 기록, f.status(기본 201) 반환 }

func TestNotifierDedupeFocusAndGone(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	fs := &fakeSender{}
	focused := map[string]bool{}
	clk := time.Unix(1_800_000_000, 0)
	n := New(Options{Store: st, Sender: fs, Focused: func(a string) bool { return focused[a] }, Host: "macmini", Now: func() time.Time { return clk }})
	n.Subscribe("d_1", Subscription{Endpoint: "https://push.example/1"}, nil)
	blocked := core.Change{Address: "t2", Old: term("t2", "working", 0, nil), New: term("t2", "blocked", 0, nil), Event: &hc.Event{Type: "status"}}
	n.OnChange(blocked); n.Wait()
	n.OnChange(blocked); n.Wait() // 10초 안 중복
	if len(fs.sent) != 1 || fs.payloads[0].Tag != "t2" || fs.payloads[0].URL != "/#/t/t2" || !strings.Contains(fs.payloads[0].Title, "승인 대기") { t.Fatalf("%+v", fs.payloads) }
	clk = clk.Add(11 * time.Second)
	focused["t2"] = true
	n.OnChange(blocked); n.Wait() // 포커스 중
	if len(fs.sent) != 1 { t.Fatal("focused viewer must suppress") }
	focused["t2"] = false
	fs.status = 410
	n.OnChange(blocked); n.Wait()
	if len(st.Get().PushSubs) != 0 { t.Fatal("410 must delete the subscription") }
}

func TestKindsFilter(t *testing.T) {
	// kinds=[exited]만 켠 구독은 blocked를 받지 않고 finished 이벤트에서만 받는다
}

func TestEnsureVAPIDStable(t *testing.T) {
	// 두 번 불러도 같은 키, 공개 키는 base64url 65바이트(비압축 P-256)
}
```
`internal/server/push_test.go`: 페어링 → `GET /api/push/key` 200 → `POST /api/push/subscriptions` 201 → `POST /api/push/test`가 가짜 발송기로 1건 → 기기 철회하면 그 구독이 지워진다.

- [ ] **Step 2: 실패 확인** — `go test ./internal/push/ ./internal/server/` → FAIL.
- [ ] **Step 3: 구현** — 위 규칙. 실제 발송기:
```go
func (w *webPush) Send(ctx context.Context, sub store.PushSub, payload []byte) (int, error) {
	v := w.st.Get().VAPID
	res, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
		Endpoint: sub.Endpoint, Keys: webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth},
	}, &webpush.Options{Subscriber: w.subject, VAPIDPublicKey: v.Public, VAPIDPrivateKey: v.Private, TTL: 86400, Urgency: webpush.UrgencyHigh})
	if err != nil { return 0, err }
	defer res.Body.Close()
	return res.StatusCode, nil
}
```
subject는 `https://github.com/kwonikhyeon/Mori`.
- [ ] **Step 4: 통과 확인** — `go test -race ./internal/push/ ./internal/server/` → PASS. 격리 코어에서 OSC 7501(`printf '\033]7501;state=blocked\007'`)로 상태를 만들어 Notifier가 한 건 내는지 통합 테스트도 하나 둔다(문법이 다르면 스펙 §15에 적고 단위 테스트만 남긴다).
- [ ] **Step 5: 커밋 후 단계 7 푸시** — `git commit -m "feat(push): 승인·입력 대기 알림"` → `git push`.

---

### Task 14: 배포 — service, doctor, 릴리스, README (단계 8)

**Files:**
- Create: `internal/service/service.go`, `internal/service/launchd.go`, `internal/service/runkey_windows.go`, `internal/service/runkey_other.go`, `cmd/mori/doctor.go`, `cmd/mori/servicecmd.go`, `README.md`
- Test: `internal/service/service_test.go`

**Interfaces:**
- Produces:
```go
type Options struct { Exe, Home, LogPath string; Args []string; Env map[string]string; DryRun bool; Out io.Writer }
func Install(o Options) error
func Uninstall(o Options) error
func Installed() (bool, string)                          // 설치 여부와 위치(plist 경로 또는 Run 키)
func LaunchdPlist(label, exe string, args []string, env map[string]string, logPath string) []byte
func RunKeyCommand(exe string, args []string) string     // Windows Run 키 값(따옴표 처리)
const Label = "dev.mori"
```
macOS: `~/Library/LaunchAgents/dev.mori.plist`(RunAtLoad, KeepAlive, ProcessType Interactive, StandardOutPath·StandardErrorPath = mori.log, EnvironmentVariables에 설치할 때의 `PATH` — LaunchAgent의 PATH는 최소라 `claude`·`codex`를 못 찾는다), `launchctl bootout gui/<uid>/dev.mori`(오류 무시) → `launchctl bootstrap gui/<uid> <plist>`. Windows: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`의 `Mori` = `"<moriw.exe>" serve --log "<home>\mori.log"`(`reg add … /f`), 그리고 지금 한 번 분리 실행. 제거: macOS `bootout` + plist 삭제, Windows `reg delete … /f` + 관리 소켓 `shutdown`. `--dry-run`은 쓸 파일 내용과 실행할 명령을 Out에 쓰고 아무것도 바꾸지 않는다.

doctor(§11): 줄마다 `✓`/`✗`/`!`와 안내.
1. Mori 버전, 상태 디렉터리와 `state.json` 권한(0700/0600)
2. Mori 서버 동작 여부(관리 소켓 `status` → 코어 연결·버전)
3. hc 경로·`hc --version`, 서버가 꺼져 있으면 `hc server status`
4. git 경로·버전
5. tailscale 경로, `DNSName`, `ServeStatus`가 `http://127.0.0.1:<port>`로 프록시하는지. 아니면 `tailscale serve --bg http://127.0.0.1:7761` 안내(실행하지 않는다)
6. 서비스 설치 여부
7. 프리셋 실행 파일(`claude`, `codex`)이 PATH에 있는지(정보)

- [ ] **Step 1: 실패하는 테스트**

```go
func TestLaunchdPlist(t *testing.T) {
	b := string(LaunchdPlist(Label, "/Users/u/bin/mori", []string{"serve", "--log", "/Users/u/Library/Application Support/Mori/mori.log"},
		map[string]string{"PATH": "/opt/homebrew/bin:/usr/bin"}, "/Users/u/Library/Application Support/Mori/mori.log"))
	for _, want := range []string{
		"<key>Label</key>\n\t<string>dev.mori</string>",
		"<string>/Users/u/bin/mori</string>\n\t\t<string>serve</string>",
		"<key>RunAtLoad</key>\n\t<true/>", "<key>KeepAlive</key>\n\t<true/>",
		"<key>PATH</key>\n\t\t<string>/opt/homebrew/bin:/usr/bin</string>",
		"<key>StandardErrorPath</key>",
	} {
		if !strings.Contains(b, want) { t.Errorf("missing %q in\n%s", want, b) }
	}
	if err := xml.Unmarshal([]byte(b), new(any)); err != nil { t.Fatal(err) } // 올바른 XML
}

func TestPlistEscapesXML(t *testing.T) {
	b := string(LaunchdPlist(Label, "/a&b/mori", nil, nil, "/l"))
	if !strings.Contains(b, "/a&amp;b/mori") { t.Fatal(b) }
}

func TestRunKeyCommand(t *testing.T) {
	got := RunKeyCommand(`C:\Users\u\Mori\moriw.exe`, []string{"serve", "--log", `C:\Users\u\AppData\Roaming\Mori\mori.log`})
	want := `"C:\Users\u\Mori\moriw.exe" serve --log "C:\Users\u\AppData\Roaming\Mori\mori.log"`
	if got != want { t.Fatalf("%s", got) }
}

func TestInstallDryRunChangesNothing(t *testing.T) {
	var out bytes.Buffer
	home := t.TempDir()
	if err := Install(Options{Exe: "/x/mori", Home: home, LogPath: filepath.Join(home, "mori.log"), Args: []string{"serve"}, DryRun: true, Out: &out}); err != nil { t.Fatal(err) }
	if runtime.GOOS == "darwin" && (!strings.Contains(out.String(), "launchctl bootstrap gui/") || !strings.Contains(out.String(), "<plist")) { t.Fatal(out.String()) }
	if ok, _ := Installed(); ok && runtime.GOOS == "darwin" { t.Log("already installed on this machine; dry-run must not have changed it") }
}
```

- [ ] **Step 2: 실패 확인** — `go test ./internal/service/` → 컴파일 실패.
- [ ] **Step 3: 구현** — 위 규칙. plist는 `text/template` + `html.EscapeString` 또는 `xml.EscapeText`. README에는 설치(릴리스 파일 놓기, `mori service install`, `tailscale serve --bg http://127.0.0.1:7761`), 페어링(`mori pair`), 개발(`make test`, `make test-clean`), 보안 요약을 적는다.
- [ ] **Step 4: 통과 확인** — `go test ./... && make release` → PASS. macmini에서 `go run ./cmd/mori doctor`가 7개 항목을 모두 보고하고, `go run ./cmd/mori service install --dry-run`이 plist와 `launchctl` 명령을 낸다.
- [ ] **Step 5: 커밋 후 단계 8 푸시** — `git commit -m "feat: service install, doctor, 릴리스 빌드, README"` → `git push`.

---

## 스펙 반영 (구현 중 확정)

같은 커밋에서 스펙을 고친다.
- §15.1 결과(Task 4): 이벤트 채널은 NDJSON 바이트 스트림이고 CREDIT이 필요하다. 뷰어→코어 DATA에는 크레딧이 돌아오지 않는다. `hc connect`는 macOS에서 코어가 없으면 띄운다.
- §7.1(Task 9): 터미널 보기의 Mori 제목 필드는 `display_title`이다. `title`은 프로그램이 정한 제목 그대로다.
- §8(Task 1·7): CSP에 xterm.js용 `style-src 'self' 'unsafe-inline'`과 같은 호스트의 `ws(s)://`를 더한다. Origin은 `Host` 또는 `X-Forwarded-Host`와 비교한다.
- §3 #18, §11(Task 14): Windows 상주는 HKCU Run 키다. 버린 대안은 `schtasks /SC ONLOGON`(일반 사용자는 모든 사용자 대상 로그온 트리거를 만들 수 없다)과 Windows 서비스(세션 0)다. Run 키에는 비정상 종료 뒤 자동 재시작이 없다. LaunchAgent에는 설치할 때의 PATH를 넣는다.
- §6.2(Task 8): `mori pair --name`의 이름은 코드에 붙는다. 기기가 이름을 보내지 않으면 그 이름을 쓴다. 관리 소켓 동작은 pair, devices, revoke, status, shutdown이다.

## Self-Review

1. **스펙 범위:** §6.1 시작 순서 → Task 1·6·8·13(serve 조립). §6.2 → Task 7·8. §6.3 → Task 9. §6.4 → Task 10. §6.5 → Task 13. §6.6 → Task 6·10. §6.7 → Task 10 `TestSessionSurvivesMoriRestart`. §6.8 → Task 10 `closeCodeFor`. §7 전체 → Task 8·9·10·12·13. §8 → Task 1(헤더)·7(쿠키·Origin·제한)·8(관리 소켓 0600)·11(git 경로)·9(업로드 한도). §9 → Task 2(손상 파일)·6(백오프·hc 없음)·10(4409·4503)·11(git 시간 제한)·13(404·410). §10 → Task 1·2. §11 → Task 1(Makefile)·14. §13 → 각 태스크 테스트, `make test-clean`. 빠진 것 없음.
2. **자리표시:** "TBD"·"나중에" 없음. `TestMissedCarriesSnapshot`, `TestFirstSnapshotDoesNotNotify`, `TestKindsFilter`, `TestAttachUnknownTerminal4404`, `TestEventsSnapshotThenTerminalUpdates`, `TestGitDiffRejectsEscapingPaths`, `TestFsListsDirectoriesOnly`, `TestEnsureVAPIDStable`, `TestAttachCoreLoss4503`, `TestWebSocketWithoutCookieClosed4401`은 주석으로 입력과 기대값을 적었다. 구현할 때 같은 형태로 채운다.
3. **타입 일관성:** `core.Change{Address, Old, New, Event}`는 Task 5·6·13에서 같다. `hc.Stream.Recv`의 오류 세 가지(`*ClosedError`, `ErrClosed`, `ErrDetached`)는 Task 4·10에서 같다. `TerminalView`는 Task 9·10·12에서 같다. `Resolver.Resolve(hc.Terminal) (string, string)`는 Task 9의 `Deps.Resolve`와 같은 모양이다.
4. **Review Focus:** 다섯 줄 모두 소유 태스크에 테스트가 있다(Task 3·4·6·9·10·11·12).
