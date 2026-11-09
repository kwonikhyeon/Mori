# Mori 웹 UI 구현 계획 (단계 10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 후보 B(알림함)로 폰과 PC에서 실제로 일할 수 있는 웹 UI를 만든다. 다크 모드와 너비를 바꿀 수 있는 사이드바를 더한다(결정 113~134, 구현 중에 정한 것은 141~157).

**Architecture:** `web/`의 Preact 앱을 Vite로 빌드해 `internal/webui/dist`에 넣고, Go 바이너리가 그것을 임베드해 준다. 화면 상태는 `/ws/events` 하나가 채우는 signals 저장소에 있고, 터미널 화면마다 `/ws/attach` 하나와 xterm.js 하나를 둔다. 나머지는 REST다. 화면 경로는 URL 해시에 있다.

**Tech Stack:** Preact 10.29.8, `@preact/signals` 2.11.3, TypeScript 6.0.3, Vite 8.3.5, Vitest 5.0.5 + jsdom 30.1.3 + `@testing-library/preact` 3.2.6, `@xterm/xterm` 6.0.0(+ fit 0.11.0, unicode11 0.9.0, web-links 0.12.0), `uqr` 0.1.3, `@fontsource/inter`·`@fontsource/jetbrains-mono` 5.3.0.

**Spec:** `docs/superpowers/specs/2026-11-08-mori-design.md` (§6.2~6.8, §7, §9, 결정 113~157)

## Global Constraints

- 사용자에게 보이는 문구는 모두 한국어다. 코드 식별자는 영어다.
- CSP(`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss://<host> ws://<host>`)를 지킨다. 인라인 스크립트와 바깥 요청(글꼴, CDN)이 없다.
- 모든 상태 변경 요청은 같은 출처의 `fetch`(쿠키 포함)다. 오류 본문은 `{error:{kind, message, hint?}}`이고 화면에는 `message`를 보여 준다.
- 401 `unauthorized`나 WS 4401이면 페어링 화면으로 간다.
- 터미널 주소는 REST 경로에서 `encodeURIComponent`(`/` → `%2F`), WS 쿼리에서도 인코딩한다.
- 색은 `web/src/styles/tokens.css`의 변수만 쓴다. 밝은 값과 어두운 값을 둘 다 둔다.
- 터치 대상은 폰에서 44px 이상이다.
- 공개 저장소다. tailnet 이름은 `example.ts.net`만 쓴다. 캔버스 URL과 스크래치 파일을 커밋하지 않는다.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 작업이 끝날 때마다 `git push`.

## Review Focus

1. **코어 재시작과 네트워크 끊김 중의 터미널 화면.** 4503 뒤에는 코어가 돌아올 때 `resumed=1`로, 4409 뒤에는 pid가 생길 때 다시 붙어야 한다. 다시 붙으면 화면을 비우고 기록을 다시 받는다. → Task 2 `attach.test.ts`.
2. **이벤트 스트림이 밀리거나(1013) 서버가 다시 뜰 때(1001).** 새 스냅숏이 옛 상태를 통째로 바꿔야 하고, 사라진 터미널이 목록에 남으면 안 된다. → Task 2 `store.test.ts`, `events.test.ts`.
3. **`/`가 든 주소(`machine/t7`)와 한글·공백 경로.** 해시 경로와 REST 경로, WS 쿼리를 오가며 그대로여야 한다. → Task 2 `router.test.ts`, `api.test.ts`.
4. **좁은 창에서 사이드바 너비.** 저장된 너비가 창보다 크면 본문이 420px 아래로 줄지 않게 그리되 저장값은 지킨다. 키보드로도 바뀐다. → Task 3 `resize.test.ts`, `Splitter.test.tsx`.
5. **칸이 많은 그래프.** 칸 너비가 줄어도 선이 행 사이에서 이어져야 한다(위 행의 `down` x = 아래 행의 `up`·`pass` x). → Task 7 `graph.test.ts`.

---

## 파일 구조

```
web/
  package.json, package-lock.json, tsconfig.json, vite.config.ts, index.html
  public/            theme.js(첫 테마), sw.js(push·notificationclick), manifest.json, icons/*.png
  scripts/icons.mjs  아이콘 PNG를 만든다(결과는 public/icons에 커밋)
  src/
    main.tsx         진입점: 스타일, 앱, 서비스 워커 등록
    app.tsx          페어링 확인 → 폰/PC 배치 → 경로별 화면
    styles/          tokens.css(밝은·어두운 토큰), base.css, ui.css(공통 부품), 화면별 css
    lib/             UI 없는 논리. 모두 단위 테스트한다
      types.ts       API 타입
      api.ts         fetch 래퍼(ApiError), 엔드포인트 함수
      storage.ts     안전한 localStorage
      backoff.ts     흔들기를 넣은 지수 대기
      events.ts      /ws/events 연결과 다시 연결
      store.ts       signals: terminals·folders·core·연결 상태, 메시지 적용
      queue.ts       "지금 볼 것" 묶음과 정렬, 폴더별 묶음
      router.ts      해시 경로 파싱·만들기, route signal
      time.ts        한국어 상대 시간
      format.ts      상태 이름, 칩 종류, 경로 줄이기(~), 터미널 부제
      keys.ts        빠른 키 바이트
      attach.ts      /ws/attach 세션 상태 기계(xterm에 기대지 않음)
      theme.ts       테마 signal, 적용, xterm 색, display 값
      resize.ts      사이드바 너비 계산과 키 처리
      slug.ts        BranchSlug·워크트리 경로 미리 보기(결정 15와 같은 규칙)
      graph.ts       그래프 행의 SVG 경로
      push.ts        알림 구독 흐름
    components/      Icon, Chip, Splitter, Banner, Sheet, Confirm, Toast, Segmented, QR
    views/           Pair, Queue, Folders, Terminal, Xterm, NewSession, Git, Diff, Graph, Commit, Settings, FolderPicker, PcShell, PhoneShell
internal/webui/      webui.go(캐시 헤더, /pair), webui_test.go(dist 유무와 무관)
Makefile             web 대상, build·release가 web에 기댐
```

## Task 1: 골격·빌드·테마

**Files:** `web/*` 설정 파일, `web/public/{theme.js,sw.js,manifest.json,icons/*}`, `web/scripts/icons.mjs`, `web/src/{main.tsx,app.tsx}`, `web/src/styles/{tokens.css,base.css}`, `web/src/lib/{storage.ts,theme.ts}`, `internal/webui/webui.go`, `internal/webui/webui_test.go`, `Makefile`, `.gitignore`

**Interfaces:**
- Produces: `theme: Signal<'system'|'light'|'dark'>`, `effectiveTheme: ReadonlySignal<'light'|'dark'>`, `setTheme(t)`, `terminalTheme(mode): ITheme`, `displayFacts(mode, cell:[w,h]): {fg,bg,cursor,cell}`; `load(key, fallback)`, `save(key, value)`.
- Go: `webui.Handler()`는 dist가 있으면 `spa(sub)`, 없으면 자리표시. `spa`는 `/assets/`에 immutable, 나머지 no-cache, `/pair` → `/`.

- [ ] `webui_test.go`: `placeholder`를 직접 시험하고, `spa`를 `fstest.MapFS`로 시험한다(`/`·`/pair` → index, `/assets/x.js` immutable, `/sw.js` no-cache, `/nope` 404).
- [ ] `theme.test.ts`: 저장값 없음 → system, `setTheme('dark')` → `data-theme="dark"`·저장, system이면 `matchMedia`를 따른다.
- [ ] `vite build`가 `internal/webui/dist`에 쓰고 `.gitkeep`을 남긴다. `make build`가 UI를 포함한다.
- [ ] 커밋: `feat(web): UI 골격, 빌드, 밝은·어두운 토큰`

## Task 2: 데이터 계층

**Files:** `web/src/lib/{types,api,backoff,events,store,queue,router,time,format,keys,attach}.ts`와 테스트

**Interfaces:**
- `api.ts`: `class ApiError {status, kind, message, hint?}`, `request<T>(method, path, body?)`, 엔드포인트마다 함수(`hello()`, `pair(code,name)`, `overview()`, `terminals.create(...)`, `git.status(path)` …), `termPath(addr)`.
- `events.ts`: `class EventStream { start(); stop(); }` — 메시지를 `store.apply(msg)`로 넘긴다. 닫는 코드 1013은 바로, 4401은 `onUnauthorized`, 그 밖은 `Backoff`.
- `store.ts`: `terminals: Signal<Map<string, TerminalView>>`, `folders`, `core`, `conn: Signal<'connecting'|'open'|'down'|'restarting'>`, `apply(msg)`.
- `queue.ts`: `groupQueue(ts, now): QueueGroups`, `needsCount(groups)`, `groupByFolder(ts, folders)`.
- `router.ts`: `route: Signal<Route>`, `parseHash(h): Route`, `href(r: Route): string`, `navigate(r)`.
- `attach.ts`: `class AttachSession` — `on('data'|'state'|'size'|'attached'|'closed')`, `send(bytes)`, `resize(c,r)`, `focus(b)`, `display(d)`, 상태 `connecting|open|waiting-core|recovering|reconnecting|closed|gone|error`.

- [ ] 각 파일에 실패하는 테스트를 먼저 쓰고 통과시킨다. 가짜 WebSocket(`test/fakeWs.ts`)으로 닫는 코드마다의 동작을 확인한다.
- [ ] 커밋: `feat(web): API·이벤트·저장소·경로·attach 상태 기계`

## Task 3: 앱 틀·사이드바·대기열·페어링

**Files:** `views/{PcShell,PhoneShell,Queue,Folders,Pair}.tsx`, `components/{Icon,Chip,Splitter,Banner,Segmented,Toast}.tsx`, `lib/resize.ts`, css

- [ ] `resize.test.ts`: `clampWidth(saved, viewport, other)`가 본문 420px을 지키고 저장값은 바꾸지 않는다. 키 처리(←→ 16, Shift 64, Home/End).
- [ ] `Splitter.test.tsx`: `role=separator`, `aria-valuenow`, 방향키·두 번 누르기.
- [ ] `Queue.test.tsx`: 묶음 순서와 배지, 접힌 묶음.
- [ ] `Pair.test.tsx`: `#code=`로 채우기, 400 메시지, 성공하면 코드를 주소에서 지운다.
- [ ] 커밋: `feat(web): 앱 틀, 크기 조절 사이드바, 지금 볼 것·폴더, 페어링`

## Task 4: 터미널 화면

**Files:** `views/{Terminal,Xterm}.tsx`, css

- [ ] xterm.js를 `AttachSession`에 잇는다. `attached`·`size`로 크기를 맞추고, 화면이 바뀌면 fit으로 계산해 `resize`를 보낸다. 테마가 바뀌면 색과 `display`를 다시 보낸다.
- [ ] 상태 띠(복구 대기, 코어 연결 중, 다시 연결 중, 종료), 승인 대기 키, 빠른 키(응용 커서 모드), 여러 줄 보내기(409 `blocked`), 파일 올리기, 중단, 종료(확인), 이름 바꾸기, 보기 전용.
- [ ] 커밋: `feat(web): 터미널 화면`

## Task 5: 새 세션·폴더 고르기

**Files:** `views/{NewSession,FolderPicker}.tsx`, `lib/slug.ts`

- [ ] `slug.test.ts`: Go `BranchSlug`와 같은 표(`feat/x` → `feat-x`, `CON` → `wt-CON`, 64자 자르기).
- [ ] 새 브랜치: 워크트리 만들기 → 세션 만들기. 실패해도 워크트리는 남기고 고른 상태로 둔다.
- [ ] 커밋: `feat(web): 새 세션과 폴더 고르기`

## Task 6: Git 패널

**Files:** `views/{Git,Diff}.tsx`

- [ ] 브랜치·앞섬/뒤처짐, 변경 묶음(스테이징됨·변경·추적 안 함·충돌), 펼친 diff, 워크트리(추가, 삭제 409 `live`·`conflict`, 강제 삭제 확인).
- [ ] `format.test.ts`: 변경을 묶는 규칙(`index`·`worktree` 글자).
- [ ] 커밋: `feat(web): Git 패널`

## Task 7: 그래프·커밋 상세

**Files:** `views/{Graph,Commit}.tsx`, `lib/graph.ts`

- [ ] `graph.test.ts`: 직선·곡선 경로, 칸 너비 줄이기, 행 사이 x가 이어짐.
- [ ] PC: 목록 + 커밋 패널(크기 조절). 폰: 목록 + 아래 시트. 해시 복사, HEAD만, 더 불러오기, 파일 diff.
- [ ] 커밋: `feat(web): Git 그래프와 커밋 상세`

## Task 8: 설정·알림

**Files:** `views/Settings.tsx`, `components/QR.tsx`, `lib/push.ts`, `public/sw.js`

- [ ] 테마, 알림 켜기·종류·하위 터미널·시험, 기기 목록·해제, 새 기기 페어링(QR, 남은 시간), 폴더·호스트·프리셋 편집.
- [ ] `push.test.ts`: 키가 다른 구독은 지우고 다시 구독한다. 종류 저장.
- [ ] 커밋: `feat(web): 설정과 알림`

## Task 9: 문서

- [ ] README에 UI 빌드(`make web`, Node 22)와 화면 설명, 명세 §12 단계 10 상태.
- [ ] 커밋: `docs: 단계 10 UI 구현 상태`
