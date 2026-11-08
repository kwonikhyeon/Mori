# Mori 설계

> 상태: 설계 확정 (2026-11-09) · 백엔드 구현 중 · 구현 계획: `docs/superpowers/plans/2026-11-09-mori-backend-v1.md`
> 범위: 호스트마다 herdr-core 옆에 Mori 서버를 둔다. Tailscale로 묶인 여러 OS 기기(모바일 포함)의 브라우저에서 세션을 보고 조작한다.

## 0. 이름

**Mori(몰이)** — 가축몰이의 '몰이'. herdr(무리)를 멀리서 몬다는 뜻이다. 영문 표기와 CLI·패키지 이름은 `mori`를 쓴다.

## 1. 목적과 전제

### 1.1 사용자가 정한 것

- herdr 기반이다. 여러 OS(모바일 포함)에서 쓰는 원격 작업 웹앱이다. 외부 접속은 Tailscale로 한다.
- **Mori가 모든 기기의 주 작업 환경이다.** 호스트 앞 PC에서든 밖의 폰에서든 Mori로 일한다.
- **동기:** 화면 앱을 끄면 세션도 함께 꺼지는 구조가 불편하다. 세션이 어떤 화면과도 독립적으로 사는 구조를 처음부터 만든다.
- **첫 버전 필수 기능:** 폴더 트리·세션 관리, 입력·승인 대기 알림, Git·워크트리. 여러 패인 그리드는 첫 버전 이후로 미룬다.
- **호스트:** 여러 대가 각자 호스트다. `macmini`(macOS), `ikhyeon-desktop`(Windows), `ikhyeon-labtop`(Windows)가 각자 세션을 돌리고, Mori에서 접속할 호스트를 고른다. 여러 호스트를 한 화면에 합치는 방식은 고르지 않았다.
- **진행 방식:** 설계가 끝나면 바로 구현한다. 백엔드를 먼저 만든다. UI는 아티팩트로 후보 여러 개를 만들고, 사용자가 고르거나 고친 뒤에 구현한다.

### 1.2 설계 원칙

1. **세션 수명은 어떤 화면과도 묶이지 않는다.** 브라우저 탭을 닫아도, Mori 서버를 끄거나 업데이트해도 세션은 herdr-core에서 계속 돈다. 모든 결정은 이 기준을 먼저 통과해야 한다.
2. **Mori는 세션을 소유하지 않는 중계자다.** 세션의 진실은 코어에 있다. Mori는 코어 상태를 캐시해 보여 주고 명령을 전달할 뿐이다.
3. **코어의 원시 API를 브라우저에 열지 않는다.** 코어에는 인증이 없다. Mori가 인증 관문이고, 허용한 동작만 중계한다.
4. **호스트는 서로 독립이다.** 한 호스트가 꺼져도 다른 호스트의 Mori는 영향을 받지 않는다.

## 2. 기반: herdr-core

### 2.1 Herdr TUI가 아니라 herdr-core를 쓴다

herdr 제품군에는 두 계열이 있다.

| | Herdr TUI (`herdr` 0.9.x) | herdr-core (`hc` 0.1.19) |
|---|---|---|
| 정체 | 터미널 멀티플렉서(TUI) + 서버 | 지속 터미널 런타임. 공식 Herdr 앱(`Herdr.app`)의 엔진 |
| 외부 클라이언트용 출력 | 실시간 스트림 없음(`pane.read` 폴링뿐) | `terminal.attach` 원시 스트림(첫 화면 + 이후 출력) |
| 상태 | 화면을 보고 추정 | 프로그램이 OSC 7501로 직접 보고, 코어는 추정하지 않음 |
| 이 기기 설치 | 없음 | `~/.local/bin/hc`, `~/Applications/Herdr.app` |
| 라이선스 | Apache-2.0 | Apache-2.0 (github.com/herdrdev/herdr-core) |

브라우저에 터미널을 실시간으로 그리려면 원시 스트림이 있어야 한다. 그래서 Mori는 herdr-core 위에 짓는다. 위험은 herdr-core가 아직 어리다는 점이다(첫 공개 0.1.10은 2026-10-23, 0.1.19는 2026-11-07, "preview, protocol generation 1"). 다만 "API는 늘기만 한다"는 원칙이 있고, `released.openrpc.json` 호환성 테스트가 이를 지킨다.

### 2.2 Mori가 기대는 herdr-core 사실 (0.1.19, 2026-11-09 `hc schema`와 schema README로 확인)

- **연결:** Unix 소켓(`$XDG_RUNTIME_DIR/herdr-core/<session>.sock`, 없으면 `/run/user/<uid>/…`, 그다음 state 디렉터리, `HC_SOCKET`으로 덮어씀) 또는 Windows named pipe(사용자와 SYSTEM만 접근). **`hc connect`가 같은 프로토콜을 stdin/stdout으로 말한다.** macOS의 Unix 소켓 경로는 103바이트까지다.
- **프로토콜:** JSON-RPC 2.0. 처음에는 한 줄에 메시지 하나(plain mode)다. `hello {framed: true}`의 응답 뒤부터 framed mode로 바뀐다. 오류에는 안정된 `data.kind`가 붙는다(`not_found`, `blocked`, `finished`, `unavailable`, `invalid_params` 등).
- **프레임:** `[channel u32 LE][kind u8][len u32 LE][payload]`, payload는 16 MiB까지. kind는 DATA 0, CREDIT 1, CLOSE 2, RESIZE 3(u16 cols, u16 rows), FOCUS 4, FACTS 5(Display JSON), AUTOMATIC_INPUT 6. 채널 0은 JSON-RPC이고, 채널 0 위의 호출은 나란히 실행된다.
- **attach:** `terminal.attach {terminal, cols, rows, observe?, history?, resumed?, display?, resize_notifications?}`는 채널을 돌려준다. 그 채널로 첫 화면(현재 화면, 선택한 history, 최근 상태와 제목, `CSI ?9001h/l`)이 오고, 이어서 프로그램의 원시 출력이 온다. 키 입력은 같은 채널의 DATA로 보낸다. **크기는 마지막 활성 뷰어가 정한다.** attach, 입력, RESIZE, 포커스 획득이 활성으로 친다. observe 뷰어는 입력도 크기 변경도 하지 않는다.
- **흐름 제어:** 스트림은 256 KiB 크레딧으로 시작한다. 뷰어는 내보낸 바이트만큼 CREDIT을 보낸다. 4 MiB 넘게 밀린 뷰어는 밀린 출력 대신 새 화면을 받는다. 막힌 스트림이 채널 0이나 다른 스트림을 막지 않는다. 프로그램이 끝나면 코어가 CLOSE `{"reason":"exited","exit_code":0,"signal":null}`를 보낸다.
- **이벤트:** `events.subscribe`는 스냅숏(`seq`, 터미널 목록)과 채널을 준다. 이후 `event`(created, lost, restarted, keep, finished, removed, status, turn, title, labels, size, foreground, doc), 15초마다 `heartbeat`, 밀리면 `missed`와 새 스냅숏이 온다. `seq`는 코어 프로세스마다 새로 시작한다.
- **상태:** OSC 7501(Program Status Protocol)로 보고된 단어 그대로다(`idle`, `working`, `done`, `blocked`, `error`). `blocked`는 사람이 필요하다는 뜻이다(권한·질문). 보고하지 않는 프로그램은 상태가 없다. `turn`은 상태가 `working`을 떠날 때마다 오른다.
- **수명:** macOS에서 데스크톱 시작은 일회성 launchd 작업을 쓴다. 그래서 띄운 앱을 꺼도 코어와 터미널이 산다. 업데이트와 `hc server restart`는 터미널을 유지한다. `keep`이 켜진 터미널은 프로그램을 잃으면(호스트 종료, 시그널, holder 손실) 마지막 폴더에서 셸로 되살아난다. 원래 명령은 다시 실행하지 않는다. 종료 코드가 있는 정상 종료와 명시적 kill은 최종이다.
- **부모-자식:** 다른 터미널 안에서 띄운 터미널은 부모가 끝날 때 함께 끝난다. Mori는 터미널 밖에서 돌지만, 혹시 몰라 `no_parent: true`를 넘긴다.
- **보안:** 코어에는 인증이 없다. 공식 문서는 "믿지 못할 사람에게 소켓이나 원시 API를 넘기지 말라"고 한다. 코어 상태는 암호화하지 않는다.
- **Windows:** `hc server status`는 코어를 띄우지 않는다. 관리자 권한 코어에는 관리자 권한 클라이언트가 필요하다. Windows에는 시그널이 없다.

### 2.3 스파이크 결과 (2026-11-09, 격리 코어 `HC_SESSION=mori-probe`)

- **Claude Code 2.1.319**는 hc 아래에서 띄우자마자 `status: {app: "claude-code", state: "idle"}`, `reported: true`를 보고했다. 에이전트 상태 보고는 실제로 동작한다.
- **Codex 0.146.0**에는 `--no-daemon` 플래그가 없다(hc 문서는 이 플래그를 요구한다). 플래그 없이 띄우면 폴더 신뢰 대화상자부터 뜨고, 그동안은 상태를 보고하지 않는다. 신뢰한 뒤의 보고 여부는 §15에서 확인한다.
- `hc run`의 결과에는 `agent: "claude"` / `"codex"`가 붙는다. 코어가 알려진 에이전트를 알아본다.
- 스크래치 경로처럼 긴 디렉터리를 쓰면 소켓 경로가 103바이트를 넘는다. 테스트는 짧은 경로를 쓴다.
- **이벤트 채널(§15.1, 격리 코어 `HC_SESSION=mori-p2`):** framed mode에서 이벤트 채널의 DATA는 줄바꿈으로 끝나는 JSON 메시지의 바이트 스트림이다. 메시지 하나가 프레임 여러 개에 걸쳐 온다. 이 채널에도 CREDIT이 필요하다. CREDIT을 보내지 않으면 정확히 262144바이트(256 KiB)에서 멈췄다. 그래서 Mori는 읽어 낸 줄의 바이트 수만큼 CREDIT을 보낸다.
- **입력 방향:** 뷰어가 코어로 DATA 655 KB를 보내는 동안 코어는 CREDIT을 한 번도 보내지 않았다. 쓰기 쪽에는 창이 없다.
- **attach:** 결과 키는 `channel`, `terminal`, `resize_notifications`, `automatic_input`이다. 첫 화면은 셸에서 약 2.3 KB였다. detach는 CLOSE를 보내면 코어가 빈 CLOSE로 답한다.
- **코어 자동 시작:** macOS에서 `hc connect`는 코어가 없으면 띄운다.

아래는 단계 2에서 테스트용 격리 코어(`HC_SESSION=mori-test-<id>`, §13)로 확인한 것이다(2026-11-09).

- **코어 수명(macOS):** 자동으로 뜬 코어는 launchd 작업(`hc --hc-launchd …`, 부모 PID 1)이다. stdio는 `/dev/null`이고 stderr는 `<XDG_STATE_HOME>/herdr-core/<session>/core.log`로 간다. 그래서 Mori가 끝나도 코어는 산다. `hc connect`는 stdin이 닫히면 끝난다. 상태 디렉터리에는 `core.json`, `core.lock`, `core.log`, `holder.log`, `screens/`, `terminals.json`이 있다.
- **attach 바이트:** 첫 화면은 코어가 다시 그린 화면이다(`CAN`, `CSI !p` 리셋, 화면 지우기, 탭 위치, 프롬프트, 커서 위치, `CSI ?9001l`). 그 뒤로는 PTY 원시 출력이 작은 조각으로 온다. `A ESC[31m B ESC[0m C`가 바이트 그대로 왔다.
- **터미널 질의:** 프로그램이 보낸 DA1(`CSI c`), DSR(`CSI 6n`), OSC 11 질의는 뷰어 스트림에서 빠지고 코어가 직접 답한다. 답은 `CSI ?62;22c`, `CSI 1;5R`, 그리고 attach `display`의 배경색으로 만든 `OSC 11;rgb:1111/2222/3333`이었다. 그래서 xterm.js가 겹쳐 답하는 일은 없다. 대신 Mori는 브라우저의 색과 셀 크기를 attach의 `display`나 FACTS로 넘겨야 한다(§6.4).
- **attach 플래그:** 활성 뷰어는 `resize_notifications`를 요청해도 `false`를 받았다. 그래서 크기 변화는 `size` 이벤트로 따라간다(§6.4). `automatic_input`은 `true`였지만 입력은 모두 DATA로 보낸다(§14).
- **RESIZE:** 보내면 `size` 이벤트(`{cols, rows}`)가 오고 셸이 프롬프트를 다시 그린다.
- **이벤트 데이터:** `created`와 `restarted`는 Terminal 레코드 전체다(`identity: "ghostty"`, `screen: "exact"`). `size`는 `{cols, rows}`, `foreground`는 `{argv, cwd, name, pid}`, `lost`와 `finished`는 `{exit_code, finished_ms, reason, signal}`이다. 이벤트의 `terminal`은 짧은 주소(`t1`)이고 `terminal.run` 결과의 `address`와 같다.
- **끝나는 방식:** 결과는 아래와 같다. 이것으로 §6.8의 판정을 확인했다.

  | 경우 | CLOSE와 이벤트 | 레코드 |
  |---|---|---|
  | `exit 3` | `exited`, exit_code 3, `finished` | `finished` |
  | `terminal.kill` | `killed`, signal 1, `finished`(같은 값). 코어는 hangup → terminate → kill 순서로 보내고, 셸은 SIGHUP에서 끝났다 | `finished`, `terminal.list {all: true}`에 남는다(1.5초 안에 `removed` 없음) |
  | `keep: false` 셸에 SIGKILL | `exited`, signal 9, `finished` | `finished` |
  | `keep: true` 셸에 SIGKILL | `signaled`, signal 9, `lost` | `state: "live"`, `pid: null`. 그동안 attach는 `unavailable`("t1 is lost, waiting for its new shell")로 거절된다. 약 2.5초 뒤 같은 주소로 `restarted`가 왔다. 새 argv는 원래의 `/bin/sh`가 아니라 로그인 셸(`/bin/zsh -l`)이고 폴더는 그대로다 |

아래는 단계 5에서 격리 코어로 확인한 것이다(2026-11-09). Mori의 REST API는 이 동작에 기댄다(§7.1).

- **끝난 터미널:** `events.subscribe`의 스냅숏과 `terminal.list {all: true}`에 모두 들어 있다. 그래서 캐시는 끝난 터미널도 안다.
- **결과 형식:** `terminal.run`은 Terminal 레코드에 `output`과 `wait`를 더해 준다. `get`·`kill`·`label`은 Terminal 레코드, `rm`은 `{removed}`, `send`는 `{started, status, turn, wait}`, `keys`는 `{status, turn}`, `read`는 `{text, complete, how}`, `put`은 `{path, bytes}`다. `kill`의 레코드는 `state: "finished"`, `reason: "killed"`, `finished_ms`를 담는다.
- **거절:** 살아 있는 터미널의 `terminal.rm`은 kind `live`("t1 is still running", hint "kill it first: hc kill t1"), 끝난 터미널의 `terminal.send`는 kind `finished`, 없는 터미널의 `terminal.get`은 `not_found`, 모르는 키의 `terminal.keys`는 `invalid_params`("unknown key \"nosuchkey\" (try enter, esc, up, ctrl+c, alt+x, f5, a)")다.
- **라벨 지우기:** `terminal.label`에 빈 값(`{"mori.title": ""}`)을 주면 그 라벨이 지워진다. 돌려준 레코드에도 없다.
- **`terminal.put`:** 한 번에 8,388,608바이트(8 MiB)까지 받고, 1바이트라도 넘으면 `invalid_params`("at most 8 MB per put")다. 파일은 `<XDG_STATE_HOME>/herdr-core/<session>/files/<terminal>/<name>`에 놓인다. 같은 이름이 있으면 `name-2.ext`가 되고, 이름의 공백은 `_`가 된다(`my notes.txt` → `my_notes.txt`).
- **`terminal.interrupt`:** 쉬고 있는 셸에는 `{outcome: "unknown", key: "ctrl+c"}`를 준다. `timeout`은 초 단위 실수이고 기본값은 10이다.
- **`terminal.read`:** `lines`는 화면 위 기록의 줄 수다. 0이면 화면만 읽는다.
- **터미널 인자:** `t7`, 터미널 이름, `machine/t7`을 모두 받는다.

아래는 단계 5의 WebSocket 작업에서 격리 코어로 확인한 것이다(2026-11-09). §7.2와 §7.3이 이 동작에 기댄다.

- **관찰자:** `observe: true`와 `resize_notifications: true`로 붙은 관찰자는 출력 사이에 RESIZE를 받는다. 활성 뷰어는 요청해도 `false`를 받으므로 `size` 이벤트로 크기를 따라간다. 관찰자가 보낸 DATA는 코어가 무시한다.
- **attach 거절:** 끝난 터미널은 kind `finished`, 없는 터미널은 `not_found`, 셸을 되살리는 중인 keep 터미널은 `unavailable`이다.
- **코어 재시작:** `hc server restart`를 하면 `hc connect`의 연결이 EOF로 끝난다. 붙어 있던 스트림은 CLOSE 없이 끊긴다.
- **코어 중지:** `hc server stop`을 하면 붙어 있던 스트림이 CLOSE `server_stop`을 받는다. 코어가 다시 뜨면 약 2초 뒤 keep 터미널은 같은 주소에 로그인 셸로 돌아오고, keep이 아닌 터미널은 `finished`로 남는다.

### 2.4 현재 환경 (2026-11-09)

- 호스트: `macmini`(macOS arm64, 개발 머신), `ikhyeon-desktop`·`ikhyeon-labtop`(Windows). 클라이언트에는 iPhone이 있다.
- 개발 머신 도구: hc 0.1.19, Tailscale 1.102.2, Go 1.26.5, Node 22, git 2.54, Claude Code 2.1.319, Codex 0.146.0.

## 3. 결정 요약

| # | 항목 | 결정 | 버린 대안 | 이유 |
|---|---|---|---|---|
| 1 | 세션 엔진 | herdr-core | Herdr TUI 소켓 API · 직접 만든 PTY 서버 | 실시간 스트림과 화면 독립 수명이 이미 있다(§2.1) |
| 2 | 호스트 구성 | 호스트마다 Mori 하나. 호스트 목록에서 서로 링크 | 허브 Mori 하나 + `hc machine add` · 브라우저가 여러 호스트 API를 직접 호출 | 사용자가 "각자 호스트"를 골랐다. 한 호스트가 꺼져도 나머지는 산다. 허브는 이후 단계 후보 |
| 3 | 코어 연결 | `hc connect`를 자식 프로세스로 띄워 stdio로 framed 통신 | 소켓·named pipe에 직접 연결 | 소켓 경로 규칙과 OS 차이를 hc가 처리한다 |
| 4 | 백엔드 | Go 단일 바이너리. UI를 임베드한다 | Node/TypeScript · Rust | Windows 호스트 두 대에 런타임 없이 파일 하나만 놓는다. 크로스 빌드가 쉽다 |
| 5 | 브라우저 전송 | REST + WebSocket(이벤트 1개, 보고 있는 터미널마다 1개) | SSE + POST · WebSocket 하나에 전부 다중화 | 터미널 바이트는 양방향 이진 스트림이다. 터미널마다 끊고 다시 붙기가 단순하다 |
| 6 | 터미널 그리기 | 원시 스트림을 xterm.js에 그대로 | 서버가 화면 텍스트를 폴링해 보냄 · 채팅형 파싱 UI | 원시 스트림이 가장 정확하다. 에이전트별 파서는 깨지기 쉽다 |
| 7 | 터미널 크기 | 코어 정책(마지막 활성 뷰어)을 따른다. 보기 전용(observe) 접속 지원 | Mori가 크기 소유자를 따로 중재 | 같은 코어를 쓰는 다른 클라이언트(Herdr 앱)와 규칙이 어긋나지 않는다 |
| 8 | HTTPS | Mori는 127.0.0.1에만 열고, `tailscale serve`가 `https://<호스트>.<tailnet>.ts.net`을 준다 | tailnet IP에 HTTP로 bind · Mori가 `tailscale cert`로 TLS 직접 처리 | 웹 푸시와 서비스 워커에는 HTTPS가 필요하다. 인증서 갱신을 Tailscale이 맡는다 |
| 9 | 인증 | 일회용 페어링 코드 → 기기 토큰(HttpOnly 쿠키) | Tailscale 신원 헤더만 신뢰 · 비밀번호 | tailnet에 다른 기기나 사람이 있어도 안전하다. 기기마다 철회할 수 있다 |
| 10 | 페어링 시작점 | 호스트의 `mori pair`(관리 소켓) + 이미 페어링된 기기의 "기기 추가" | 첫 접속 기기를 자동 신뢰 | 호스트 앞에 있는 사람만 첫 기기를 들일 수 있다 |
| 11 | 알림 | Web Push(호스트별 VAPID 키) | ntfy 같은 외부 서비스 · 메신저 봇 | 추가 계정이 없다. 페이로드는 종단 간 암호화된다 |
| 12 | 상태 출처 | 코어의 OSC 7501 보고 | 화면 텍스트 추정 | 코어 원칙과 같다. 추정은 오탐이 많다 |
| 13 | 폴더 | Mori 상태 파일에 등록. 터미널 소속은 라벨 `mori.folder`, 없으면 시작 폴더(cwd)로 정한다 | 코어 문서(`doc.set`)에 저장 · 라벨만 사용 | Herdr 앱이나 `hc run`으로 띄운 터미널도 폴더에 들어간다 |
| 14 | Git | 호스트의 git CLI를 직접 실행 | go-git 라이브러리 · `machine.exec` | 사용자 git 설정(자격 증명, hooks, 워크트리)과 똑같이 동작한다 |
| 15 | 워크트리 위치 | `<저장소 부모>/<저장소 이름>.wt/<브랜치 슬러그>` | 저장소 안 `.worktrees/` | 저장소의 `.gitignore`를 건드리지 않는다 |
| 16 | 세션 복구 | Mori가 만든 세션은 `keep: true` | `keep: false` | 재부팅 뒤에도 그 폴더의 셸이 남아 이어서 일할 수 있다 |
| 17 | 저장 | `state.json` 하나(0600, 임시 파일 + rename) | SQLite | 데이터가 작고 쓰는 프로세스가 하나다 |
| 18 | 상주 방식 | macOS LaunchAgent, Windows `HKCU\…\Run` 키(일반 권한, 콘솔 창 없는 `moriw.exe`) | Windows 서비스 · `schtasks /SC ONLOGON` 작업 | 서비스는 세션 0에서 돌아 사용자 코어와 어긋난다. 로그온 작업은 관리자 권한 없이 만들지 못할 수 있다. Run 키는 비정상 종료 뒤 다시 띄우지 않는다(로그온할 때 다시 뜬다) |
| 19 | PC 화면 | 브라우저 PWA | Electron·Tauri 데스크톱 셸 | 네이티브 창이 필요하면 같은 코어를 쓰는 공식 Herdr 앱이 있다 |
| 20 | 폰 입력 | xterm.js 직접 입력 + 여러 줄 입력창(`terminal.send`) + 빠른 키 바 | 감시·승인 전용 | 폰도 주 작업 환경이다(§1.1) |
| 21 | 알림 대상 | 부모 없는 터미널만(기본값) | 모든 터미널 | 자식 에이전트의 대기는 부모 에이전트가 받는다(hc가 부모에게 알린다) |
| 22 | UI 프레임워크 | 후보 선택 뒤 정한다. 백엔드는 빌드된 정적 파일만 서빙한다 | 지금 고정 | UI는 아티팩트 후보에서 고른다(§1.1) |
| 23 | 이벤트 채널 CREDIT | 읽어 낸 줄의 바이트에 더해, 줄을 기다리는 동안 받은 미완성 줄의 바이트도 CREDIT한다 | 받는 즉시 전부 CREDIT · 완성된 줄만 CREDIT | 받는 즉시 주면 소비자가 느릴 때 버퍼가 끝없이 커진다. 완성된 줄만 주면 256 KiB보다 긴 메시지(큰 스냅숏)에서 멈춘다 |
| 24 | 깨진 이벤트 줄 | 구독을 끝낸다. 소비자는 다시 구독해 새 스냅숏을 받는다 | 그 줄만 건너뛴다 | 건너뛰면 캐시가 모르는 사이 코어와 어긋난다. 스냅숏은 어긋남을 고친다 |
| 25 | 채널별 수신 큐 | 읽기 루프는 채널마다 큐에 넣기만 한다. 큐가 32 MiB를 넘으면 그 스트림만 끊는다 | 읽기 루프에서 소비자에게 바로 넘김 · 한도 없는 큐 | 바로 넘기면 느린 브라우저 하나가 모든 채널과 RPC를 막는다. 코어가 CREDIT을 지키면 큐는 256 KiB를 넘지 않으므로, 한도는 고장 난 코어에만 걸린다 |
| 26 | detach 뒤 읽기 | `Close` 직후 `Recv`는 남은 출력 없이 `ErrDetached`를 돌려준다 | 남은 큐를 다 내준 뒤 끝냄 | 닫은 쪽은 남은 출력을 쓰지 않는다. 닫는 동안 온 출력을 흘리지 않아도 된다 |
| 27 | `hc connect` 오류 | hc의 stderr 마지막 2 KiB를 연결 오류 메시지에 붙인다 | stderr 버림 · 전부 로그로 보냄 | 연결 실패의 이유(설치·권한·소켓 경로)는 대개 hc가 stderr에 쓴다. 로그는 `Options.Stderr`로 따로 받을 수 있다 |
| 28 | 캐시 레코드 복사 | 레코드를 제자리에서 바꾸지 않는다. 바뀐 필드만 다른 얕은 복사본을 새로 넣고, 안의 맵·슬라이스는 공유한 채 읽기만 한다. 이미 가진 값이 다시 오면 바뀐 것이 없다고 본다 | 이벤트마다 JSON 왕복으로 깊은 복사 | foreground 이벤트는 터미널마다 1초에 두 번쯤 온다. 깊은 복사는 그때마다 레코드 전체를 직렬화한다. 같은 값을 걸러야 브라우저에 헛된 갱신이 가지 않는다 |
| 29 | 이벤트 채널 오류 | 연결이 살아 있으면 이벤트 채널만 다시 구독해 새 스냅숏을 받는다. 연달아 3번 넘게 실패하면 연결을 다시 맺는다 | 오류마다 `hc connect`부터 다시 연결 | 연결을 다시 맺으면 그 위의 attach가 모두 끊겨 브라우저의 터미널이 전부 4503으로 닫힌다. 깨진 줄 하나(결정 24) 때문에 그럴 까닭이 없다 |
| 30 | Watch의 시작 상태 | `Watch`는 시작 시점의 터미널 목록과 연결 상태를 함께 준다. 방송과 같은 잠금 안에서 잡고, 방송도 그 잠금 안에서 막히지 않게 보낸다. `OnChange`만 잠금 밖에서 부른다 | `Watch`와 `Terminals`를 따로 부름 · 방송을 잠금 밖에서 보냄 | 따로 부르면 그 사이의 변경이 빠지거나 두 번 온다. 잠금 밖에서 보내면 시작 상태보다 오래된 업데이트가 뒤에 올 수 있다 |
| 31 | API 오류 메시지 | Mori가 만든 `message`는 한국어로 쓴다. hc가 준 `message`는 그대로 넘긴다 | 모두 영어로 두고 UI가 kind로 번역 · hc 메시지까지 번역 | 한 kind(`invalid_params` 등)에 이유가 여럿이라 kind만으로는 무엇이 틀렸는지 말할 수 없다. hc 메시지는 종류를 다 알 수 없어 번역표를 만들 수 없다 |
| 32 | 상태 디렉터리 하나에 서버 하나 | `serve`는 무엇보다 먼저 관리 소켓을 연다. 그 소켓에서 다른 서버가 응답하면 시작하지 않는다. 응답이 없으면 죽은 서버가 남긴 파일로 보고 지운다 | 따로 잠금 파일(flock) · 확인하지 않음 | 두 서버가 같은 `state.json`을 쓰면 서로의 변경을 덮는다. flock은 Windows에서 따로 만들어야 하고, 죽은 서버가 남긴 잠금도 풀어야 한다. 관리 소켓은 어차피 열고, 죽은 서버의 소켓은 연결을 받지 않는다 |
| 33 | 호스트 이름 | Tailscale 머신 이름(MagicDNS 이름의 첫 라벨). 없으면 OS 호스트 이름의 첫 라벨을 소문자로 | OS 호스트 이름만 | macOS의 호스트 이름은 컴퓨터 이름("…의 Mac mini")에서 만들어져 tailnet의 이름과 다르다. 호스트 목록(결정 2)에는 사용자가 tailnet에서 붙인 이름이 보여야 한다 |
| 34 | 철회와 열린 WS | `server.New`가 `Auth.OnRevoke`에 WS 허브를 잇는다. WS는 수락한 뒤 허브에 등록하고, 등록한 다음 기기가 아직 있는지 다시 본다 | `serve`에서 잇기 · 수락과 철회를 한 잠금으로 묶기 | 쿠키를 확인한 뒤 허브에 등록하기 전에 철회되면 그 WS는 열린 채 남는다. 등록한 뒤에 다시 보면 철회와 재확인 중 하나가 반드시 닫는다. 한 잠금으로 묶으려면 auth가 서버의 WS를 알아야 한다. `New`에서 이으면 테스트 서버도 똑같이 동작한다 |
| 35 | 서버의 코어 | `server.Deps.Core`는 필수다. 테스트는 시작하지 않은 관리자를 넣어 코어가 없는 서버를 만든다 | Core를 선택으로 두고 nil 검사 | 코어가 없는 동안의 서버는 실제로 있는 상태이고, 테스트가 그 경로(503 `core_unavailable`)를 그대로 지난다. nil 검사는 실제로는 없는 상태를 하나 더 만든다 |
| 36 | 파일 올리기 한도 | 8 MiB(hc `terminal.put`의 한도, §2.3). Mori가 base64로 바꾸기 전에 재고, 넘으면 413 `too_large` | 413 `invalid_params` · 한도 검사를 hc에 맡김 | `invalid_params`는 400이다(§7.4). hc에 맡기면 11 MB쯤 되는 base64를 다 보낸 뒤에야 영어 메시지로 거절된다 |
| 37 | 세션 만들기 확인 | `terminal.run` 전에 확인한다. `folder_id`와 `preset`은 등록된 것이어야 하고, `worktree`는 절대 경로(정리해서 쓴다), 시작 폴더는 있는 디렉터리, 제목은 100자까지다. 어기면 400 `invalid_params`와 무엇이 틀렸는지 말하는 메시지 | 확인을 코어에 맡김 | 폴더와 프리셋은 Mori만 안다. 시작 폴더가 없을 때 코어가 어떻게 할지에 기대지 않는다 |
| 38 | 작업을 받는 프리셋 | `task: true`인 프리셋은 `argv`가 있어야 한다(`PUT /api/presets`가 거절한다). 작업은 argv의 마지막 인자로만 붙는다 | argv가 빈 프리셋(셸)이면 작업을 입력으로 보냄 | 셸에 보내면 작업 문장이 명령으로 실행된다 |
| 39 | 제목 | 줄바꿈을 포함한 공백 묶음은 공백 하나로 바꾸고 100자까지 받는다. 작업에서 만든 제목은 40자에서 자른다. PATCH에 빈 제목을 주면 `mori.title` 라벨을 지워 프로그램 제목이 다시 보인다. 프리셋·호스트 이름도 같은 규칙이다 | 받은 그대로 저장 | 이름은 목록 한 줄에 들어가야 한다. 줄바꿈이 든 라벨은 목록을 깨뜨린다 |
| 40 | 작업 인자 | 앞뒤 공백을 자르고, 공백뿐이면 붙이지 않는다. `-`로 시작하면 앞에 공백 하나를 붙인다 | `--`를 끼움 · 그대로 넘김 | 그대로 넘기면 프로그램이 작업을 옵션으로 읽는다(`--dangerously-skip-permissions …`). `--`를 받지 않는 프로그램도 있다. 앞의 공백은 프롬프트에 해가 없다 |
| 41 | 중단 대기 | `interrupt`의 `timeout`(초)은 0보다 클 때만 넘기고 60에서 자른다. 없으면 hc 기본값(10초)이다 | 받은 그대로 넘김 | 요청 하나가 HTTP 연결을 오래 붙잡지 않게 한다 |
| 42 | 프리셋 저장 | `PUT /api/presets`는 목록 전체를 바꾼다. 빈 목록, 틀린 id(`a-z0-9_-` 1~32자), 겹친 id, 빈 이름, argv의 빈 항목은 거절한다. 응답은 저장한 목록 그대로다 | 저장 뒤 다시 읽어 응답 · 프리셋 하나씩 고치는 API | 다시 읽으면 그 사이 다른 요청의 변경이 응답에 섞인다. 프리셋이 없으면 세션을 만들 수 없다. 목록이 작아서 통째로 바꾸는 편이 단순하다 |
| 43 | 호스트 링크 | `http`·`https` 절대 URL만 받는다. 호스트가 있어야 하고 사용자 정보(`user@`)는 안 된다. 끝의 `/`는 뗀다. 빈 목록은 된다 | 아무 문자열 | UI가 이 값을 링크로 연다. `javascript:` URL이 들어가면 누른 기기에서 스크립트가 돈다 |
| 44 | 터미널 읽기 | 목록과 overview는 캐시로 답한다. 코어가 없어도 200이다(마지막으로 안 목록, 처음엔 `[]`). 한 터미널은 캐시에 없으면 `terminal.get`을 부른다 | 캐시만 봄 · 코어가 없으면 503 | 코어가 잠깐 없어도 화면은 마지막 목록을 보여 줘야 한다. 방금 만든 터미널의 `created` 이벤트는 아직 안 왔을 수 있고, 코어는 이름으로도 찾는다 |
| 45 | hc 결과 전달 | send·keys·interrupt·read·put의 결과는 hc가 준 그대로 돌려준다. 터미널 레코드를 주는 run·get·label·kill은 `folder_id` 등을 더한 레코드로 바꾼다 | 모두 Mori 형식으로 다시 씀 | 이 결과들에는 Mori가 더할 것이 없다. hc가 필드를 늘려도 Mori를 고치지 않는다 |
| 46 | hc 찾기 | `--hc`를 주면 시작할 때 한 번 찾고, 없으면 연결할 때마다 찾는다(PATH, 다음 `~/.local/bin/hc`). `--hc-session`으로 코어 세션을 고른다. Windows에서는 첫 연결이 실패하면 `hc server start`를 한 번 부른다 | 시작할 때만 찾음 | hc 업데이트가 실행 파일을 옮겨도 Mori를 다시 띄우지 않고 이어 붙는다. Windows의 `hc connect`가 코어를 띄우는지는 아직 모른다(§15) |
| 47 | 종료 순서 | 신호를 받으면 관리 소켓을 멈추고, WS를 1001로 닫고(2초까지, 결정 59), HTTP 서버를 닫고, 코어 관리자를 멈춘 뒤 `hc connect`가 끝나기를 기다린다. 모두 합쳐 5초까지다. 코어와 세션은 그대로 산다 | 관리자를 기다리지 않고 끝냄 · 관리자를 먼저 멈춤 | 관리자가 `hc connect`의 stdin을 닫고 그 프로세스가 끝나는 것을 보게 한다. 기다리지 않으면 프로세스가 먼저 끝나 그 정리가 중간에 끊긴다. 관리자를 먼저 멈추면 붙어 있던 브라우저가 4503을 듣고 오지 않을 코어를 기다린다 |
| 48 | 관리 소켓 경로 길이 | 열기 전에 경로 길이를 잰다. OS 한도(macOS·BSD 103바이트, 그 밖 107바이트)를 넘으면 `--home`이나 `MORI_HOME`을 짧게 하라는 오류로 끝낸다. `mori` 명령도 같은 확인을 한다 | OS 오류를 그대로 보여 줌 | OS는 `bind: invalid argument`라고만 하고, 명령 쪽은 "서버가 돌고 있지 않습니다"로 보여 원인을 알 수 없다 |
| 49 | attach 닫는 코드 | 스트림이 CLOSE로 끝나면 §6.8대로 고른다(keep이고 `exited`·`killed`가 아니면 4409, 아니면 `closed` 뒤 1000). CLOSE 없이 코어 연결이 끊기면 4503, 그 밖의 오류는 로그를 남기고 1011이다. 거절은 kind로 고른다: `not_found`·`machine_unknown` 4404, `unavailable` 4409, `invalid_params` 4400, 코어 없음 4503, `finished`는 결정 58 | 모든 끝을 1000으로 닫고 이유만 보냄 | 브라우저가 할 일(다시 붙기, 복구 대기, 포기)이 코드 하나로 정해진다 |
| 50 | attach 쿼리 오류 | 업그레이드를 받은 뒤 4400으로 닫고, 닫는 이유에 오류 메시지를 담는다 | 업그레이드 전에 HTTP 400 | 브라우저의 WebSocket API로는 업그레이드가 거절된 이유를 볼 수 없다. 닫는 코드와 이유는 볼 수 있다 |
| 51 | attach의 컨텍스트 | 브라우저에서 읽기와 ping은 요청 컨텍스트를 쓴다. 출력과 크기 쓰기는 브라우저가 끝나면 함께 끝나는 컨텍스트를 쓴다 | 컨텍스트 하나 | coder/websocket은 진행 중인 읽기·쓰기의 컨텍스트가 끝나면 소켓을 닫는다. 스트림이 끝난 이유를 말할 때까지 소켓이 열려 있어야 한다 |
| 52 | 폴더 변경 알림 | `FoldersChanged`가 오면 `folders`를 보내고, 소켓마다 보낸 적 있는 터미널 중 소속(`folder_id`·`worktree`)이 바뀐 것만 `terminal`로 다시 보낸다 | 터미널 전체를 다시 보냄(계획의 처음 안) | 폴더를 고칠 때마다 터미널 수만큼 메시지가 가지 않는다. 소켓이 보낸 레코드를 기억하므로 비교가 싸다 |
| 53 | 구독 다음 attach | attach는 코어 관리자를 먼저 구독하고 `terminal.attach`를 부른다. 구독이 밀리면 다시 구독하고 캐시의 크기를 보낸다 | attach한 뒤 구독 | 그 사이에 온 `size` 이벤트를 놓치면 브라우저가 다른 뷰어가 바꾼 크기를 모른 채 그린다 |
| 54 | 관찰자 입력 | 관찰자의 키·`resize`·`display`는 서버가 버리고 `focus`만 받는다 | 코어에 넘기고 코어가 무시하게 함 | 코어가 무시하는 것은 확인했지만(§2.3) 거기에 기대지 않는다. 보기 전용 화면이 터미널을 바꿀 길을 아예 없앤다. 포커스는 알림을 줄이는 데만 쓰므로 받는다 |
| 55 | 포커스 기록 | 서버가 `presence.Registry`에 attach 소켓마다 뷰어 ID로 포커스를 적고, 소켓이 끝나면 지운다. 알림기는 `Deps.Presence`로 같은 것을 받는다(없으면 서버가 만든다) | 알림기가 소켓을 직접 앎 | 알림기는 누가 보고 있는지만 알면 된다. 서버와 알림기가 서로를 몰라도 된다 |
| 56 | 닫는 이유 | WS 닫는 이유는 한국어로 쓰고(결정 31), 123바이트를 넘으면 UTF-8 문자 경계에서 자른다 | 그대로 넘김 | 닫기 프레임의 이유는 123바이트까지다. 넘으면 닫기 프레임을 보내지 못한다. hc의 메시지를 담으면 넘을 수 있다 |
| 57 | keepalive | 두 WS 모두 30초마다 WebSocket ping을 보내고, 10초 안에 pong이 없으면 끊는다 | JSON `ping`만 보냄 | 네트워크에서 사라진 휴대폰은 아무 말 없이 사라진다. TCP가 알아채기까지 몇 분이 걸리고, 그동안 그 뷰어의 포커스가 남아 알림을 막는다 |
| 58 | 끝난 터미널에 붙기 | 코어가 `finished`로 거절하면 `terminal.get`으로 레코드를 읽고(실패하면 캐시) `closed`를 보낸 뒤 1000으로 닫는다. 이유를 모르면 `finished`다 | 4404로 닫음 · 캐시만 봄 | 브라우저는 끝난 세션의 마지막 상태를 보여 줘야 한다. 캐시는 `finished` 이벤트보다 늦을 수 있다 |
| 59 | WS 닫기 | `CloseSockets`는 모든 WS를 1001로 닫고 새 WS도 1001로 거절한 뒤, 핸들러가 다 끝나거나 시간이 다 될 때까지 기다린다 | `http.Server.Shutdown`에 맡김 | `Shutdown`은 하이재킹된 연결을 닫지도 기다리지도 않는다 |
| 60 | 이벤트 WS 밀림 | 보낼 변화가 1024개 넘게 밀리면 1013으로 닫는다. 브라우저는 다시 붙어 새 스냅숏을 받는다 | 밀린 것을 버리고 계속 · 무한 버퍼 | 몇 개를 버리면 브라우저의 목록이 말없이 틀어진다. 다시 붙으면 스냅숏이 맞는 목록을 준다 |

## 4. 구조

```
  [폰 PWA]        [PC 브라우저]        (어느 기기든)
       \              /
        HTTPS  https://<호스트>.<tailnet>.ts.net   ← tailnet 안에서만 닿는다
              |
      tailscale serve  (:443 → http://127.0.0.1:7761)
              |
 ┌──────────────────── 호스트 하나 (macmini, ikhyeon-desktop, ikhyeon-labtop 각각) ────────────────────┐
 │  mori serve                                                                                       │
 │   ├─ HTTP·WS 서버 ── 인증 미들웨어 ── 핸들러                                                        │
 │   ├─ 코어 관리자 ──── hc connect (stdin/stdout, framed) ───────▶ herdr-core 코어 (세션을 소유한다)   │
 │   │    └─ 터미널 캐시 (스냅숏 + 이벤트)                                                             │
 │   ├─ 폴더·Git ─────── git CLI                                                                      │
 │   ├─ 알림 ─────────── Web Push ─────────────────────────────▶ 푸시 서비스 (Apple·Google·Mozilla)   │
 │   ├─ 저장소 ───────── state.json                                                                   │
 │   └─ 관리 소켓 ◀───── mori pair · mori devices (같은 사용자의 CLI)                                  │
 └───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- 호스트마다 위 구성이 따로 있다. 기기에서는 호스트마다 다른 origin이므로 PWA 설치, 페어링, 알림 구독도 호스트마다 따로 한다.
- 각 Mori는 다른 호스트의 주소 목록(`hosts`)을 갖고, UI는 이를 링크로 보여 준다.
- Mori를 끄거나 업데이트해도 코어와 세션은 그대로다. Mori가 다시 뜨면 `hc connect`로 다시 붙고 새 스냅숏을 받는다.

## 5. 컴포넌트

각 단위는 하나의 책임과 좁은 인터페이스를 갖는다. Go 패키지 경로를 함께 적는다.

| 단위 | 하는 일 | 쓰는 쪽에 주는 것 | 기대는 것 |
|---|---|---|---|
| `internal/hc` | 프레임 인코딩, JSON-RPC, `hc connect` 프로세스, attach·이벤트 채널, 크레딧 | `Dial(ctx, opts) → *Conn`; `Conn.Call`, `Conn.Attach → *Stream`, `Conn.Subscribe → *Events`, `Conn.Done()`; 코어 타입(`Terminal`, `Status` 등) | `hc` 실행 파일 |
| `internal/core` | 연결 유지(끊기면 재연결), 터미널 캐시, 변경 방송 | `Manager.Terminals()`, `Manager.Watch(buf) → 시작 상태와 변경 채널`(결정 30), `Manager.Call`·`Manager.Attach`(연결이 없으면 `core_unavailable`), 연결 상태 | `internal/hc` |
| `internal/store` | `state.json` 읽기·쓰기, 동시성 보호 | `Store.Get()`, `Store.Update(func(*State) error)` | 파일 시스템 |
| `internal/auth` | 기기·페어링 코드·쿠키·Origin 검사·시도 제한 | `Middleware`, `Pair(code, name)`, `NewCode()`, `Revoke(id)`, 철회 알림 | `internal/store` |
| `internal/folders` | 폴더 등록과 터미널 소속 계산. 순서는 라벨 `mori.folder` → 시작 cwd를 품는 가장 깊은 등록 폴더나 그 워크트리 → "기타"다 | `Resolve(terminal) → (folderID, worktree)`, 워크트리 경로 캐시(폴더 추가, 워크트리 변경, git 조회, 30초마다 갱신) | `internal/store`, `internal/gitx` |
| `internal/gitx` | git CLI 실행과 출력 파싱 | `Status`, `Worktrees`, `Branches`, `Diff`, `AddWorktree`, `RemoveWorktree` | `git` 실행 파일 |
| `internal/push` | VAPID 키, 구독, 알림 판정, 발송 | `Notifier.OnChange(change)`(바뀌기 전과 후의 레코드, 원인 이벤트), `Subscribe`, `Test` | `internal/store`, `internal/core`, webpush 라이브러리 |
| `internal/server` | 라우팅, REST 핸들러, 이벤트 WS, attach WS 브리지 | `http.Handler` | 위 전부 |
| `internal/admin` | 관리 소켓(Unix 도메인 소켓, Windows 10 이상 포함)과 그 클라이언트 | `Listen(path)`, `Serve(ctx, ln, h)`, `Client.Do(req)` | `internal/auth` |
| `internal/service` | LaunchAgent·Run 키 설치와 제거 | `Install(opts)`, `Uninstall()` | OS 도구(`launchctl`, `reg`) |
| `internal/webui` | 빌드된 UI 임베드. 없으면 자리표시 페이지 | `Handler()` | `web/` 빌드 결과 |
| `cmd/mori` | CLI: `serve`, `pair`, `devices`, `revoke`, `doctor`, `service install/uninstall`, `version` | — | 위 전부 |

## 6. 데이터 흐름

### 6.1 Mori 시작
1. 관리 소켓을 연다. 다른 Mori 서버가 그 소켓에서 응답하면 시작하지 않는다. 응답이 없는 소켓 파일은 지운다(결정 32).
2. `state.json`을 읽는다. 없으면 VAPID 키를 만들어 새로 쓴다.
3. 코어 관리자가 `hc connect`를 띄운다. 그다음 `hello {framed: true, generation: 1}`을 보낸다. 이어서 `events.subscribe {}`로 스냅숏을 받아 캐시를 채운다. 실패하면 Windows에서는 한 번 `hc server start`를 실행한다. 이후 0.5초에서 10초까지 늘어나는 간격으로 다시 시도한다.
4. HTTP 서버가 127.0.0.1:7761에서 듣는다.
5. 시작할 때의 상태로는 알림을 보내지 않는다. 알림은 시작 뒤의 변화에만 반응한다.

### 6.2 페어링
1. 호스트에서 `mori pair --name "iPhone"`을 실행한다. CLI는 관리 소켓으로 서버에 코드를 요청한다.
2. 서버는 8자리 코드(혼동 문자를 뺀 base32, `XXXX-XXXX`)를 만든다. 유효 시간은 5분, 한 번만 쓸 수 있다. CLI는 코드와 `https://<호스트>/pair#code=XXXX-XXXX`의 QR을 터미널에 그린다. 코드는 URL 조각(`#`)에 둬서 서버 로그에 남지 않게 한다.
3. 기기가 `POST /api/pair {code, name}`를 보낸다. 서버는 256비트 토큰을 만들고 SHA-256 해시만 저장한다. 토큰은 쿠키 `mori_device`(HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age 400일, 쓸 때마다 연장)로 준다.
4. 이미 페어링된 기기도 `POST /api/pair-codes`로 코드를 만들 수 있다. PC 화면의 QR을 폰으로 찍어 페어링하는 흐름이다.

### 6.3 세션 만들기
1. UI가 `POST /api/terminals {folder_id, worktree?, preset, task?, title?, cols, rows}`를 보낸다.
2. Mori가 폴더·프리셋·시작 폴더·제목을 확인하고(결정 37) `terminal.run`을 호출한다. 넘기는 값은 `cwd`(폴더 또는 워크트리), `argv`(프리셋 argv, 프리셋이 작업을 받으면 끝에 task. 결정 38, 40), `labels {mori: "1", mori.folder, mori.preset, mori.title}`, `keep: true`, `no_parent: true`, `size {cols, rows}`(10~1000, 기본 80×24), `env {TERM: xterm-256color, COLORTERM: truecolor, TERM_PROGRAM: mori}`이다. `mori.title`은 `title`, 없으면 작업의 앞 40자, 그것도 없으면 프리셋 이름이다(결정 39).
3. 응답은 201과 터미널 레코드(§7.1)다. 캐시는 `created` 이벤트로 갱신되어 모든 브라우저에 퍼진다.
4. 기본 프리셋은 세 가지다. 사용자가 고치거나 더할 수 있다.

   | id | 이름 | argv | task 받음 |
   |---|---|---|---|
   | `claude` | Claude Code | `["claude"]` | 예 |
   | `codex` | Codex | `["codex"]` | 예 |
   | `shell` | 셸 | `[]`(그 머신의 셸) | 아니요 |

   터미널 `name`은 `a-z0-9-_.` 1~32자라는 제한이 있어서 비워 둔다. 보여 줄 이름은 `mori.title` 라벨에 둔다.

### 6.4 터미널 보기와 입력
1. 브라우저가 `/ws/attach?t=t7&cols=…&rows=…&history=1000[&observe=1][&resumed=1]`로 붙는다.
2. Mori는 공유 `hc connect` 연결에서 `terminal.attach`를 열고, 브라우저 하나에 코어 채널 하나를 짝짓는다.
3. 코어에서 온 DATA는 이진 WS 메시지로 보낸다. WS 쓰기가 끝난 바이트만큼 코어에 CREDIT을 보낸다. 채널마다 큐와 쓰기 고루틴을 따로 둬서 느린 브라우저가 다른 채널을 막지 않게 한다.
4. 브라우저의 이진 메시지(키 입력)는 DATA로 보낸다. JSON 텍스트 메시지 중 `resize`는 RESIZE, `focus`는 FOCUS, `display`는 FACTS 프레임이 된다.
5. 크기 변화(`size` 이벤트, observe 뷰어의 RESIZE 프레임)는 `{type: "size"}`로 브라우저에 알린다. 브라우저는 xterm.js를 실제 PTY 크기에 맞춘다.
6. 여러 줄 입력창은 `POST /api/terminals/{t}/send`를 쓴다(`terminal.send`: 붙여넣고 조용해지면 Enter를 누른다). 코어가 `blocked`를 이유로 거절하면 UI는 "승인 대기 중 — 키로 응답"을 보여 준다. 빠른 키(Esc, Enter, Tab, Shift+Tab, 화살표, Ctrl+C)는 지연이 없도록 attach 스트림에 바이트로 보낸다.

### 6.5 상태 변화와 알림
1. 이벤트(`status`, `turn`, `finished`)가 오면 코어 관리자가 캐시를 갱신하고, 바뀌기 전과 후의 레코드를 알림기에 넘긴다.
2. 알림기의 판정은 이렇다.
   - 루트 상태가 `blocked`로 바뀌면 **승인 대기**를 보낸다.
   - `turn` 이벤트가 `done` 또는 `idle`로 끝나면 **입력 대기**를 보낸다.
   - 루트 상태가 `error`로 바뀌면 **오류**를 보낸다.
   - `finished`가 오면 **종료**를 보낸다(기본값은 끔).
   - 부모가 있는 터미널은 건너뛴다(설정으로 켤 수 있다).
3. 두 경우에는 보내지 않는다. 그 터미널을 지금 포커스한 뷰어가 있을 때(브라우저가 `focus`와 페이지 가시성을 보고한다)와, 같은 터미널의 같은 종류 알림을 10초 안에 이미 보냈을 때다.
4. 구독한 기기마다 켠 종류만 보낸다. 페이로드는 `{title, body, tag: 주소, url: "/#/t/<주소>"}`로 최소로 둔다. 푸시 서비스가 404나 410을 돌려주면 그 구독을 지운다.

### 6.6 코어 재시작·업데이트
`hc connect`가 끝나면 열린 attach WS를 모두 코드 4503으로 닫는다. 브라우저는 `resumed=1`로 다시 붙는다. 이벤트 WS에는 `{type: "core", connected: false}`를 보낸다. Mori는 hc 경로를 다시 찾고(업데이트로 링크가 바뀔 수 있다) 다시 연결해 새 스냅숏으로 캐시를 바꾼다. 그 사이의 상태 변화는 바뀌기 전과 후의 스냅숏을 비교해 알림을 판정한다.

### 6.7 Mori 재시작·업데이트
세션은 코어에 있으므로 영향이 없다. 브라우저는 WS가 끊기면 백오프하며 다시 붙는다. 쿠키와 상태는 `state.json`에 있으므로 다시 페어링하지 않는다.

### 6.8 프로그램 손실과 복구(`keep`)
`lost` 이벤트가 오면 attach 스트림이 닫힌다. Mori는 CLOSE 이유로 닫는 방법을 고른다.

- `keep` 터미널이고 이유가 `exited`·`killed`가 아니면(시그널이면 `signaled`, holder 손실 등, §2.3) attach WS를 코드 4409로 닫는다. UI는 "복구 대기"를 보여 주고, `restarted`로 바뀐 레코드가 이벤트 WS의 `terminal`로 오면 다시 붙는다. 그 전의 attach는 `unavailable`로 거절된다.
- 그 밖에는 `{type: "closed", reason, exit_code, signal}`을 보낸 뒤 1000으로 닫는다. 종료 코드가 있는 정상 종료와 명시적 kill은 `keep`이어도 최종이기 때문이다.

## 7. API

모든 요청에는 기기 쿠키가 필요하다. 예외는 "공개"로 표시한 것과 정적 UI 파일이다. 본문은 JSON이다.

### 7.1 REST

| 메서드 · 경로 | 하는 일 |
|---|---|
| `GET /api/hello` (공개) | `{app: "mori", version, host, paired}` |
| `POST /api/pair` (공개) | `{code, name}` → 204 + 쿠키 |
| `POST /api/logout` | 이 기기 철회 |
| `GET /api/devices` · `DELETE /api/devices/{id}` | 기기 목록 · 철회(그 기기의 WS를 바로 끊는다) |
| `POST /api/pair-codes` | 새 페어링 코드 `{code, url, expires_ms}` |
| `GET /api/overview` | 첫 화면용 `{host, core, folders, terminals, presets, hosts}` |
| `GET/POST /api/folders` · `PATCH/DELETE /api/folders/{id}` | 폴더 목록·등록 `{path, name?}` · 이름 변경·등록 해제(파일은 건드리지 않는다) |
| `GET /api/fs?path=&hidden=0` | 폴더 고르기용 하위 디렉터리 목록 `{path, parent, entries: [{name, path, git}]}` |
| `GET /api/folders/{id}/git` | `{repo, branch, upstream, ahead, behind, changes, worktrees: [{path, branch, head, main, locked, prunable}]}` |
| `GET /api/folders/{id}/branches` | 로컬·원격 브랜치 |
| `POST /api/folders/{id}/worktrees` | `{branch, create, base?}` → `git worktree add` |
| `DELETE /api/folders/{id}/worktrees?path=&force=0` | 그 경로에서 살아 있는 세션이 있으면 409 |
| `GET /api/git/status?path=` | 워크트리의 변경 파일(스테이지·작업 트리·추적 안 됨·충돌) |
| `GET /api/git/diff?path=&file=&staged=0` | 파일 하나의 unified diff(읽기 전용, 1 MiB에서 자름) |
| `GET /api/terminals?all=0` | 터미널 목록(각각 `folder_id`, `worktree`, `display_title` 포함). 기본값은 살아 있는 것과 24시간 안에 끝난 것 |
| `POST /api/terminals` | 세션 만들기(§6.3) |
| `GET/PATCH/DELETE /api/terminals/{t}` | 한 터미널 · 제목 변경(`mori.title` 라벨) · 끝난 터미널 지우기(`terminal.rm`) |
| `POST /api/terminals/{t}/send` | `{text, force?}` → `terminal.send` |
| `POST /api/terminals/{t}/keys` | `{keys: ["esc", …]}` → `terminal.keys` |
| `POST /api/terminals/{t}/interrupt` · `/kill` | 현재 턴 중단 · 프로그램 종료 |
| `POST /api/terminals/{t}/files` | multipart `file` 항목 하나(8 MiB까지, 넘으면 413. 결정 36) → `terminal.put`, `{path, bytes}`를 돌려준다 |
| `GET /api/terminals/{t}/text?lines=0` | 화면 텍스트(`terminal.read`) |
| `GET/PUT /api/presets` · `GET/PUT /api/hosts` | 프리셋 · 호스트 링크 목록 |
| `GET /api/push/key` · `POST/DELETE /api/push/subscriptions` · `POST /api/push/test` | VAPID 공개 키 · 구독 `{subscription, kinds}` · 시험 알림 |

`{t}`는 터미널 주소다. 다른 머신의 터미널이면 `machine/t7`처럼 `/`가 들어가므로 URL에서는 `%2F`로 쓴다.

터미널 목록과 overview는 코어가 없어도 캐시로 답한다(결정 44). send·keys·interrupt·text·files는 hc의 결과를 그대로 돌려주고(결정 45, 형식은 §2.3), 만들기·한 터미널·제목 변경·kill은 아래의 터미널 레코드를 돌려준다. `PUT /api/presets`와 `PUT /api/hosts`는 목록 전체를 바꾸고 저장한 목록을 돌려준다(결정 42, 43).

터미널 레코드는 hc의 `Terminal` 필드에 `folder_id`, `worktree`, `display_title`, `preset`을 더한 것이다. `title`은 프로그램이 정한 제목(hc) 그대로다. 보여 줄 이름은 `display_title`이다. 순서는 `mori.title` 라벨 → 프로그램 제목 → 포그라운드 프로그램 이름 → argv[0]의 파일 이름 → "셸"이다.

### 7.2 이벤트 WS `/ws/events` (서버 → 브라우저, JSON)

- 접속 직후: `{type: "snapshot", core, folders, terminals}`. `core`는 `{connected, version, name, error}`다. `terminals`는 `GET /api/terminals`처럼 살아 있는 것과 24시간 안에 끝난 것이고, 코어가 없으면 마지막으로 안 목록이다(결정 44).
- `{type: "terminal", terminal}` — 만들어졌거나 바뀐 터미널 레코드 전체(소속 정보 포함). 이 소켓에 보낸 적 없는 터미널은 24시간 안에 끝난 것까지만 보낸다. 보낸 적 있는 터미널은 오래전에 끝났어도 바뀌면 보낸다.
- `{type: "removed", address}` — 보낸 적 있는 터미널이 지워졌을 때
- `{type: "folders", folders}` — 폴더가 바뀌었을 때. 뒤이어 소속이 바뀐 터미널만 `terminal`로 온다(결정 52).
- `{type: "core", connected, version, name, error}` — 코어 연결이 바뀌었을 때. 다시 연결되면 이 메시지가 먼저 오고, 그 사이의 변화가 `terminal`·`removed`로 뒤따른다.
- 30초마다 `{type: "ping"}`. 서버는 WebSocket ping도 보낸다(결정 57).
- 브라우저는 아무것도 보내지 않는다. 데이터 메시지를 보내면 서버가 1008로 닫는다.
- 닫는 코드: 1001 서버 종료, 1013 보낼 변화가 밀림(다시 붙는다, 결정 60), 4401 인증 없음·철회

### 7.3 attach WS `/ws/attach`

- 쿼리: `t`(주소나 이름, 필수), `cols`, `rows`(10~1000으로 맞추고, 없으면 80×24), `history`(기본값 1000, 10000을 넘으면 10000), `observe`, `resumed`(`1`·`0`)
- 서버 → 브라우저: 처음에 `{type: "attached", terminal, cols, rows}`, 이후 이진 출력, `{type: "size", cols, rows}`, 끝에 `{type: "closed", reason, exit_code, signal}`. `attached`의 크기는 코어가 알려 준 PTY 크기다.
- `size`는 두 곳에서 온다. 관찰자는 출력 사이의 RESIZE로, 다른 뷰어는 코어 관리자가 받은 `size` 이벤트로 안다(§2.3, 결정 53). 브라우저가 이미 아는 크기는 다시 보내지 않는다.
- 브라우저 → 서버: 이진 입력, `{type: "resize", cols, rows}`, `{type: "focus", focused}`, `{type: "display", fg, bg, cursor, cell}`. 메시지 하나는 1 MiB까지다. 읽을 수 없는 JSON과 모르는 `type`은 버린다.
- 관찰자(`observe=1`)의 입력·`resize`·`display`는 서버가 버린다. `focus`는 알림 판정(§6.5)에 쓰려고 받는다(결정 54).
- 서버는 WebSocket ping을 보내고, 답이 없으면 끊는다. 그러면 그 뷰어의 포커스도 풀린다(결정 57).
- 닫는 코드(결정 49):
  - 1000 정상 종료. 이유는 앞선 `closed` 메시지에 있다. 이미 끝난 터미널에 붙어도 `closed`를 보내고 1000으로 닫는다(결정 58).
  - 1001 서버 종료, 1011 서버 내부 오류
  - 4400 쿼리가 틀림(결정 50), 4401 인증 없음·철회, 4404 터미널 없음
  - 4409 사용 불가(복구 대기 등, §6.8). 코어가 멈추며 keep 터미널의 스트림을 `server_stop`으로 닫을 때도 4409다.
  - 4503 코어 연결 끊김(`resumed=1`로 다시 붙기)
- 닫는 이유는 한국어이고 123바이트에서 자른다(결정 56).

### 7.4 오류 형식
`{error: {kind, message, hint?}}`. hc의 `kind`는 그대로 전달하고 HTTP 상태는 이렇게 정한다.

| HTTP 상태 | kind |
|---|---|
| 404 | `not_found`, `machine_unknown` |
| 400 | `invalid_params` |
| 409 | `blocked`, `finished`, `live`, `name_taken`, `conflict`, `already_added` |
| 503 | `unavailable`, `core_unavailable` |
| 500 | 나머지 |

Mori 자체 kind에는 `unauthorized`(401), `forbidden_origin`(403), `rate_limited`(429), `too_large`(413), `git_failed`(422)가 있다. Mori가 만든 `message`는 한국어이고, hc가 준 `message`는 그대로 넘긴다(결정 31).

## 8. 보안

- **노출 범위:** Mori는 127.0.0.1에서만 듣는다. 밖에서는 `tailscale serve`를 거쳐서만, 즉 tailnet 안에서만 닿는다. 인증서 이름(`<호스트>.<tailnet>.ts.net`)은 공개 CT 로그에 남는다.
- **인증:** 기기 토큰은 쿠키로만 오간다. JS에서는 읽을 수 없다. 서버에는 해시만 저장한다. 철회하면 그 기기의 WS를 즉시 닫는다.
- **CSRF·교차 출처:** 쿠키는 SameSite=Strict다. 상태를 바꾸는 요청과 모든 WS 업그레이드는 `Origin`의 호스트가 `Host` 헤더(프록시가 붙였다면 `X-Forwarded-Host`)와 같아야 한다. 다르면 403이다. `X-Forwarded-Host`도 받는 것은 `tailscale serve`가 `Host`를 그대로 넘기는지 확인하지 못했기 때문이다(§15).
- **페어링 남용:** 코드는 한 번만 쓰고 5분 뒤 만료된다. 실패는 10분 동안 10번까지 받는다. 넘으면 그 창이 끝날 때까지 모든 페어링을 거절한다.
- **코어 보호:** 브라우저는 JSON-RPC를 직접 보낼 수 없다. Mori는 표(§7.1)에 있는 동작만 중계한다. `hc connect` 자식 환경에서 `HC_TERMINAL_ID`를 뺀다.
- **입력 검증:** git의 `path`는 그 폴더의 워크트리 목록에 있는 경로여야 한다. `file`은 상대 경로여야 하고, `..`나 절대 경로는 안 된다. 경로 앞에는 항상 `--`를 둔다. 업로드 크기와 diff 크기에 상한이 있다.
- **비밀 저장:** `state.json`은 0600이다(Windows는 사용자 프로필의 기본 ACL을 따른다). VAPID 개인 키와 토큰 해시가 들어 있다.
- **응답 헤더:** 모든 응답에 `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`와 이 CSP를 붙인다.
  - `default-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`
  - `style-src 'self' 'unsafe-inline'`: xterm.js가 요소에 인라인 스타일을 쓴다
  - `img-src 'self' data: blob:`
  - `connect-src 'self' wss://<호스트> ws://<호스트>`: 브라우저에 따라 `'self'`가 WS를 덮지 않는다
  - 스크립트는 `'self'`만 허용한다. 인라인 스크립트는 쓰지 않는다.

## 9. 오류 처리·복구

| 상황 | Mori의 동작 | 사용자에게 보이는 것 |
|---|---|---|
| 코어에 연결할 수 없음 | 백오프 재연결(Windows는 `hc server start`를 한 번 시도). API는 503 `core_unavailable` | "코어 연결 중" 배너 |
| `hc` 실행 파일 없음 | 시작은 하되 연결하지 않는다. `mori doctor`가 원인을 알려 준다 | "herdr-core가 설치되지 않음" |
| 이벤트가 밀림(`missed`) | 새 스냅숏으로 캐시를 바꾸고, 바뀐 것만 방송한다 | 없음 |
| attach 중 프로그램 손실 | WS를 4409로 닫는다 | "복구 대기", `restarted` 뒤 자동으로 다시 붙음 |
| 이벤트 WS가 밀림 | 1024개 넘게 밀리면 1013으로 닫는다 | 잠깐 끊긴 뒤 새 스냅숏으로 다시 그려짐 |
| Mori 종료·업데이트 | WS를 1001로 닫는다. 세션은 코어에 산다 | "서버 재시작 중", 다시 붙으면 그대로 |
| 응답 없는 브라우저(잠긴 휴대폰 등) | ping에 답이 없으면 끊고 포커스를 푼다 | 없음. 다시 열면 다시 붙는다 |
| 브라우저 네트워크 끊김 | 채널을 CLOSE한다 | 재접속하면 `resumed=1`로 크기를 뺏지 않는다 |
| 느린 브라우저 | 크레딧을 늦게 보낸다. 4 MiB 넘게 밀리면 코어가 새 화면을 보낸다 | 잠깐 멈춘 뒤 화면이 새로 그려짐 |
| git 명령 실패 | 422 `git_failed` + stderr 앞부분 | 오류 메시지 |
| 푸시 발송 실패 | 404·410이면 구독을 지운다. 그 밖에는 로그만 남긴다 | 없음 |
| `state.json` 손상 | `state.json.bad`로 옮기고 새로 시작한다(기기 다시 페어링) | 다시 페어링 요구 |

모든 외부 명령(`git`, `hc server start`)에는 시간 제한(git은 기본 10초)이 있다. git에는 `GIT_TERMINAL_PROMPT=0`과 `GIT_OPTIONAL_LOCKS=0`을 준다.

## 10. 저장

- **위치:** `MORI_HOME` 또는 `--home`. 없으면 `os.UserConfigDir()/Mori`를 쓴다(macOS `~/Library/Application Support/Mori`, Windows `%AppData%\Mori`, Linux `~/.config/Mori`).
- **파일:**
  - `state.json`: 폴더, 호스트 링크, 프리셋, 알림 설정, 기기(토큰 해시), 푸시 구독, VAPID 키, 스키마 버전
  - `mori.sock`: 관리 소켓
  - `mori.log`: 서비스로 돌 때의 로그
- **쓰기:** 메모리 사본을 잠금으로 보호한다. 바꿀 때마다 임시 파일에 쓰고 fsync한 뒤 rename한다.
- 페어링 코드와 터미널 캐시는 메모리에만 둔다.

## 11. 배포·운영

- **빌드:** `make build`가 UI(`web/`)를 빌드해 `internal/webui/dist`에 넣는다. 그다음 Go 바이너리를 만든다. UI가 없어도 Go 빌드는 된다(자리표시 페이지). `make release`는 darwin/arm64, darwin/amd64, windows/amd64, windows/arm64, linux/amd64용 바이너리를 만든다. Windows는 `mori.exe`(콘솔)와 `moriw.exe`(콘솔 창 없음)를 만든다.
- **설치:** `mori service install`
  - macOS: `~/Library/LaunchAgents/dev.mori.plist`(RunAtLoad, KeepAlive)를 쓰고 `launchctl bootstrap gui/<uid>`로 올린다. LaunchAgent의 기본 `PATH`에는 `/opt/homebrew/bin`이나 `~/.local/bin`이 없다. 그래서 설치할 때의 `PATH`를 plist의 `EnvironmentVariables`에 넣는다. 그래야 `hc`, `git`, `claude`, `codex`를 찾는다.
  - Windows: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`에 `Mori` 값(`"<moriw.exe>" serve --log "<home>\mori.log"`)을 쓰고 바로 한 번 띄운다. 관리자 권한이 필요 없다.
  - 제거: `mori service uninstall`. LaunchAgent나 Run 키를 지우고 관리 소켓으로 서버를 멈춘다.
- **HTTPS:** `tailscale serve --bg http://127.0.0.1:7761`. tailnet 관리 콘솔에서 MagicDNS와 HTTPS 인증서가 켜져 있어야 한다. `mori doctor`가 설정 여부를 확인하고 명령을 알려 준다. Mori가 Tailscale 설정을 직접 바꾸지는 않는다.
- **점검:** `mori doctor`는 다음을 보고한다.
  - hc 경로·버전, 코어 연결
  - git 경로
  - 상태 디렉터리 권한
  - tailscale serve 설정과 호스트 DNS 이름
  - 서비스 설치 여부
- **hc 찾기:** `--hc`를 먼저 보고, 다음은 `PATH`, 그다음 `~/.local/bin/hc(.exe)`다. 코어 세션은 `--hc-session`(기본값은 사용자의 기본 세션, 공식 Herdr 앱과 같은 코어)이다.
- **포트:** 기본값 7761(`--listen`으로 바꾼다).

## 12. 단계

각 단계가 끝나면 커밋하고 `github.com/kwonikhyeon/Mori`에 푸시한다.

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| 0 | 문서·저장소: 이 설계, 구현 계획, `git init`, `.gitignore`, 첫 푸시 | 원격에 `main` 브랜치가 있다 |
| 1 | 골격: Go 모듈, `mori serve`(`/api/hello`), `internal/store`, 자리표시 UI 임베드, Makefile | `go build`·`go vet`·`go test` 통과, 5개 대상 크로스 빌드 성공 |
| 2 | hc 클라이언트: 프레임, RPC, attach, 이벤트, 크레딧, 격리 코어 테스트 도우미 | 격리 코어에서 셸을 띄워 attach로 `echo` 왕복, `created`·`finished` 이벤트를 받는다 |
| 3 | 코어 관리자: 재연결, 캐시, 방송 | 격리 코어를 재시작해도 다시 붙고 캐시가 맞는다 |
| 4 | 인증: 기기, 페어링, 쿠키, Origin, 시도 제한, 관리 소켓, `mori pair`·`devices`·`revoke` | 미인증 401, 페어링 뒤 200, 철회하면 열린 WS가 닫힌다 |
| 5 | 터미널 API·WS 브리지 | HTTP·WS만으로 세션을 만들고 입출력이 왕복한다. 크기 알림과 종료 이유가 온다. Mori를 다시 띄워도 세션이 살아 있다 |
| 6 | 폴더·Git | 임시 저장소에서 워크트리 추가 → 세션 → 삭제 거부(살아 있는 세션) → 세션 종료 → 삭제 |
| 7 | 알림 | 가짜 발송기로 blocked·turn 이벤트가 알림 한 건이 된다. 중복과 포커스 억제가 동작한다 |
| 8 | 배포: `service`, `doctor`, 릴리스 빌드, README | macmini에서 `mori doctor`가 모든 항목을 보고한다. `service install --dry-run`이 올바른 plist·명령을 낸다 |
| 9 | UI 후보 아티팩트 3개 | 사용자가 하나를 고르거나 고칠 점을 준다 |
| 10 | UI 구현(별도 계획) | 고른 UI로 폰·PC에서 실제로 일할 수 있다 |

## 13. 검증

- **단위 테스트:**
  - 프레임 인코딩·디코딩
  - 가짜 코어(`io.Pipe`)를 쓴 RPC·채널·크레딧
  - 이벤트 적용(README 표의 규칙)
  - 저장 원자성
  - 페어링·쿠키·Origin·시도 제한
  - git 출력 파서(고정 입력)
  - 폴더 소속 계산
  - 알림 판정(중복·포커스·부모 규칙)
- **통합 테스트:** 실제 `hc`로 격리 코어를 띄운다. `HC_SESSION=mori-test-<id>`를 쓰고, `XDG_STATE_HOME`·`XDG_CONFIG_HOME`·`XDG_RUNTIME_DIR`·`HC_SOCKET`은 저장소의 `.dev/test/<id>`에 둔다. 테스트가 끝나면 같은 환경으로 `hc server stop`을 실행한다. 사용자의 기본 코어는 절대 건드리지 않는다. `hc`가 없으면 건너뛴다. `make test-clean`은 남은 격리 코어를 멈춘다.
- **수동 확인(단계 10 뒤):**
  - iPhone 홈 화면 PWA에서 페어링, 세션 입력, 승인 대기 알림 받기
  - Windows 호스트에서 서비스 설치와 세션 생존
  - 브라우저를 닫고 Mori를 다시 띄운 뒤 세션이 그대로인지

## 14. 범위 밖 (첫 버전)

- 여러 패인 그리드 화면. 첫 버전 이후 첫 후보다.
- 여러 호스트를 한 화면에 합치는 허브, 호스트 자동 발견(`tailscale status`로 피어를 찾아 Mori 여부 확인)
- 네이티브 앱과 데스크톱 셸
- 화면 텍스트로 에이전트 상태를 추정하는 기능, 채팅형 UI
- Git 쓰기 작업(commit, push, merge, stage). 첫 버전은 읽기와 워크트리 관리만 한다. 쓰기는 세션 안의 에이전트나 셸이 한다.
- 파일 편집기, 파일 브라우저(폴더 고르기 제외)
- Linux 서비스 설치. 빌드는 한다.
- AUTOMATIC_INPUT 태깅. xterm.js가 만든 응답과 사람 입력을 구분할 수 없어서 모두 DATA로 보낸다.

## 15. 확인할 것 (구현 중)

1. ~~framed mode에서 이벤트 채널의 DATA가 프레임 하나에 메시지 하나인지, 줄 단위 스트림인지. 이벤트 채널에도 CREDIT이 필요한지.~~ 확인함(2026-11-09, §2.3): 줄 단위 바이트 스트림이고 CREDIT이 필요하다.
2. Claude Code가 권한 프롬프트에서 `blocked`를, 턴 끝에서 `done`과 `idle` 중 무엇을 보고하는지.
3. Codex가 폴더를 신뢰한 뒤 상태를 보고하는지. `--no-daemon`이 있는 버전이 나오면 프리셋에 넣는다.
4. Windows:
   - hc 설치 위치
   - `hc connect`가 코어를 띄우는지
   - ConPTY의 `CSI ?9001h`(win32-input-mode)와 xterm.js 입력이 문제없는지
   - Run 키로 띄운 `moriw.exe`가 콘솔 창 없이 뜨는지
5. `tailscale serve`가 원래 `Host` 헤더를 넘기는지, `X-Forwarded-Host`를 붙이는지(§8)
6. OSC 7501 보고 문법. hc 바이너리에는 `]7501;`, `state=`, 질의 응답 `]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth`가 있다. 보고 형식은 `ESC ] 7501 ; state=blocked:kind=permission … BEL`로 보이지만 단계 7 통합 테스트에서 확인한다
7. ~~`terminal.kill`이 attach CLOSE에 주는 이유 문자열(`killed`로 가정, §6.8). 단계 5 통합 테스트에서 확인한다~~ 확인함(2026-11-09, §2.3): `killed`, signal 1(hangup)이다. 시그널로 프로그램을 잃은 `keep` 터미널은 `signaled`다.
8. iOS 홈 화면 PWA에서 `*.ts.net` origin의 Web Push가 오는지(VAPID `sub`는 `https://github.com/kwonikhyeon/Mori`).
9. 프로그램이 kitty 키보드 프로토콜을 켰을 때 xterm.js가 보내는 기존 방식 키가 잘 통하는지.
