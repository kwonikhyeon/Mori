# Claude Code 입력을 Mori 입력창으로 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code 터미널의 입력칸과 그 아래 줄을 Mori의 상태 띠로 덮고, 입력을 Mori 입력창이 넘겨받으며(초점, PC 조작 키), ↑·↓ 지난 글과 회색 안내(Tab)를 입력창에서 쓴다.

**Architecture:** 브라우저가 xterm 버퍼의 맨 아래를 읽어(`readBox`) 입력칸, 그 아래 상태 줄, 모드 줄, 회색 안내를 알아본다. 덮개 겸 상태 띠는 터미널 칸 안에 놓이고(층 4) pty 크기를 바꾸지 않는다. 지난 글은 서버가 Claude Code의 `history.jsonl`에서 읽어 준다(`GET /api/terminals/{t}/prompts`).

**Tech Stack:** Preact 10, @preact/signals, TypeScript, @xterm/xterm 6, vitest(jsdom); Go 서버(net/http).

**Spec:** `docs/superpowers/specs/2026-11-12-mori-claude-input-design.md` (고르는 창 설계 §9를 넓힘). 본 설계 §3의 결정 표.

## Global Constraints

- 작업은 main에서 바로, 커밋 형식은 한국어 제목 + "- " 글머리 + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- AGENTS.md의 astryx 규칙: 값은 토큰, 채움은 `background-color`, hover는 `(hover: hover)` 안의 덧칠, focus는 `:focus-visible`, 꺼짐 .5, 폰 44px, 말은 `announce()`만, 새 `aria-live` 없음, 층 표를 따름.
- pty 크기는 바꾸지 않는다(결정 7, 219).
- 회색: RGB 세 값이 8 안쪽으로 같고 64~200, 또는 팔레트 8번과 240~250번(설계 §4.2).
- 모드 이름: accept edits → 편집 자동 허락, plan mode → 계획, bypass permissions → 묻지 않음, auto mode → 자동, `? for shortcuts` → 기본, 모르면 그대로. `N shell(s)` → "셸 N".
- 알림 글: "터미널 입력칸에 글이 있습니다 — 보내면 그 뒤에 이어 붙습니다". 전환 이름: "터미널 입력칸 보기". 띠 이름: "Claude Code 상태". 모드 단추: "모드: <이름>". 안내 글: "<안내> · Tab".
- 지난 글 API: `GET /api/terminals/{t}/prompts?limit=200` → `{prompts: [{text, at}], source: "claude" | "none"}`, limit 최대 500, 파일 끝 4MB.
- 시험은 진짜 `~/.claude`를 읽지 않는다. 손 확인은 `.dev/test/<id>` 격리 코어에서만. 원시 녹화는 저장소에 넣지 않는다.
- Vitest는 견본 목록을 모듈 캐시에 둔다: 새 견본 파일 뒤에는 `npx vitest --clearCache`.

## Review Focus

1. 색이 있는 실제 글(`ultrathink` 무지개, 색 있는 자리표시) 또는 회색 둘이 섞인 입력칸 → 실제 글로 보고 덮지 않는다(Task 2 시험).
2. 다른 기기가 크기를 정해 이 기기 화면과 터미널 크기가 다를 때, 보기 전용일 때, 뒤로 스크롤해 입력칸이 화면 밖일 때 → 덮지 않는다(Task 6 시험).
3. Mori 입력창이 보내는 중 입력칸에 글이 비칠 때 → 덮개가 깜박이거나 알림이 뜨지 않는다(Task 6 시험).
4. 여러 줄 글에서 캐럿이 첫 줄이 아닐 때 ↑, 빗금 목록이 열려 있을 때 Esc·↑, 고르는 창이 떠 있을 때 ↑ → 지난 글이 아니라 원래 주인이 받는다(Task 5, 7 시험).
5. 깨진 줄, 다른 폴더, 4MB보다 큰 파일, 파일 없음의 `history.jsonl` → 서버가 오류 없이 맞는 목록이나 빈 목록을 준다(Task 4 시험).

---

### Task 1: 화면 조각이 글자색과 화면의 첫 줄을 싣는다

**Files:**
- Modify: `web/src/lib/shot.ts`, `web/test/fakeScreen.ts`, `web/test/screens.ts`
- Test: `web/src/lib/shot.test.ts`(없으면 만든다)

**Interfaces:**
- Produces: `Shot` gains `ink: string[][]` (칸마다 글자색: `''` 기본색, `'rgb:R,G,B'`, `'p:N'`) and `view: number` (지금 보이는 화면 첫 줄의 버퍼 줄, `buffer.active.viewportY`). `toShot(text, cols?, kind?, ink?: (row: number, col: number) => string)`. `FakeScreen.show(text, kind?, ink?)` 같은 모양의 `ink`. `FakeScreen`의 `view`는 0.

- [ ] **Step 1: 실패하는 시험** — `shotOf` on a real xterm `Terminal` (cols 20, rows 3) after writing `'\x1b[38;2;153;153;153mhint\x1b[0m ab\r\n\x1b[90mx\x1b[0m'`: `lines[0]`의 칸 0~3 `ink` `'rgb:153,153,153'`, 칸 5 `''`; 둘째 줄 칸 0 `'p:8'`; `view === 0`. 넓은 글자의 둘째 칸 `ink`는 첫 칸과 같다.
- [ ] **Step 2: 실패 확인** — `npx vitest run src/lib/shot.test.ts` → FAIL(`ink` undefined).
- [ ] **Step 3: 구현** — `shotOf`가 칸마다 `getFgColorMode`/`getFgColor`로 `ink`를 만든다(`isFgDefault()`면 `''`, `isFgRGB()`면 rgb, 아니면 팔레트). `view`는 `b.viewportY`. 견본 도우미와 `FakeScreen`은 `ink`를 주지 않으면 모두 `''`.
- [ ] **Step 4: 통과 확인** — `npx vitest run src/lib/shot.test.ts src/lib/pick.test.ts` → PASS(기존 판독 시험 그대로).
- [ ] **Step 5: 커밋** — `feat(web): 화면 조각이 글자색과 보이는 첫 줄을 싣는다`

### Task 2: 입력칸과 그 아래를 읽는다(`readBox`)

**Files:**
- Create: `web/src/lib/box.ts`, `web/src/lib/box.test.ts`, `web/test/screens/box-*.txt`(손 견본, 대화 글 없음)
- Modify: `web/src/lib/pick.ts`(입력칸 찾기를 `box.ts`와 나눠 쓰도록 `inputBox`와 `isRule`을 내보냄)

**Interfaces:**
- Consumes: `Shot` (Task 1).
- Produces (`box.ts`):
  - `export interface Mode { name: string; label: string; extras: string[] }` — name은 화면의 이름(`bypass permissions`), label은 우리말("묻지 않음"), extras는 `·` 뒤 조각을 우리말로("셸 1").
  - `export interface BoxLook { top: number; rows: number; text: string; hint: string; status: string[]; mode: Mode | null }` — top: 입력칸 위 가로줄의 버퍼 줄; rows: 그 줄부터 마지막으로 쓴 줄까지의 줄 수; text: 실제 글(줄은 `\n`), 비었으면 `''`; hint: 빈 입력칸의 회색 글, 없으면 `''`; status: 아래 가로줄 다음부터 모드 줄을 뺀 줄(앞뒤 빈칸 뺌, 빈 줄 뺌).
  - `export function readBox(shot: Shot): BoxLook | null` — 입력칸이 없거나 고르는 창이 있으면(`look(shot).seen`) null.
  - `export function isGrey(ink: string): boolean`, `export function readMode(line: string): Mode | null`.

- [ ] **Step 1: 실패하는 시험**(`box.test.ts`):
  - 'reads the box, the status lines and the mode line': 견본(가로줄, `❯ `, 가로줄, 상태 줄 세 줄, `  ⏵⏵ bypass permissions on · 1 shell`) → `text ''`, `hint ''`, `status`가 세 줄, `mode`가 `{name: 'bypass permissions', label: '묻지 않음', extras: ['셸 1']}`, `rows === 7`, `top`은 위 가로줄의 버퍼 줄.
  - 'takes grey text for a hint': `❯ describe a task for a new session`, 글 칸 ink `rgb:153,153,153` → `text ''`, `hint 'describe a task for a new session'`.
  - 'takes default text for text': `❯ abc` ink `''` → `text 'abc'`, `hint ''`.
  - 'takes coloured or mixed text for text' (Review Focus 1): `❯ ultrathink` 칸마다 다른 rgb → `text 'ultrathink'`; 회색 둘(`rgb:153,153,153`과 `rgb:102,102,102`) 섞임 → text.
  - 'reads a box of two lines': `❯ first` / `  second` 사이 가로줄 → `text 'first\nsecond'`.
  - 'reads the modes': `⏸ plan mode on (shift+tab to cycle)` → label '계획'; `⏵⏵ accept edits on` → '편집 자동 허락'; `? for shortcuts` → name '', label '기본'; `⏵⏵ auto mode on` → '자동'; 모르는 `⏵⏵ zoom on` → label 'zoom'; 모드 줄 없음 → `mode null`, status는 아래 줄 모두.
  - 'is null for a window or no box': `SCREENS.model`, `SCREENS['answer-list']` → null.
  - `isGrey`: `'rgb:153,153,153'` true, `'rgb:153,153,160'` true(8 안), `'rgb:153,153,170'` false, `'rgb:30,30,30'` false, `'p:8'` true, `'p:244'` true, `'p:2'` false, `''` false.
- [ ] **Step 2: 실패 확인** — `npx vitest --clearCache && npx vitest run src/lib/box.test.ts` → FAIL(모듈 없음).
- [ ] **Step 3: 구현** — 입력칸은 아래에서부터 찾은 마지막 "가로줄, `❯`로 시작하는 줄, … , 가로줄"이다. 칸의 글은 `❯ ` 뒤부터(둘째 줄부터는 들여쓰기 뺌). 비었는지는 설계 §4.2: 글자가 있는 칸의 ink가 모두 같은 하나의 회색이면 비었다. 모드 줄은 맨 아래 줄이 `⏵⏵`, `⏸`, `? `로 시작할 때.
- [ ] **Step 4: 통과 확인** — `npx vitest run src/lib/box.test.ts src/lib/pick.test.ts` → PASS.
- [ ] **Step 5: 커밋** — `feat(web): 터미널 입력칸과 상태 줄, 모드 줄, 회색 안내를 읽는다`

### Task 3: 상태 줄을 조각으로 나눈다(`readStatus`)

**Files:**
- Create: `web/src/lib/status.ts`, `web/src/lib/status.test.ts`

**Interfaces:**
- Produces: `export type StatusPart = { kind: 'chips'; chips: string[] } | { kind: 'bar'; name: string; percent: number; rest: string } | { kind: 'text'; text: string }`; `export function readStatus(lines: string[]): StatusPart[]`.

- [ ] **Step 1: 실패하는 시험**:
  - `'Opus 5.5 │ ✍️ 17% │ ⚡  Mori (main) │ ◑ xhigh'` → `{kind:'chips', chips:['Opus 5.5','✍️ 17%','⚡ Mori (main)','◑ xhigh']}`(조각 안 겹빈칸은 하나로).
  - `'current ○○○○○○○○○○   6% ⟳ 4:00오전'` → `{kind:'bar', name:'current', percent:6, rest:'4:00오전'}`; `'weekly  ●●●○○○○○○○  30% ⟳ 11월 15, 1:00오후'` → percent 30, rest '11월 15, 1:00오후'.
  - `'a | b'` → chips ['a','b']; `'그냥 글'` → `{kind:'text', text:'그냥 글'}`; `'ctx 17%'`(막대 글자 없음) → text.
- [ ] **Step 2: 실패 확인** — `npx vitest run src/lib/status.test.ts` → FAIL.
- [ ] **Step 3: 구현** — 막대 줄: `N%`와 막대 글자 `[○●◐◑▮▯■□█░▒▓]` 둘 다 있을 때; name은 막대 앞, rest는 `%` 뒤에서 `⟳`와 앞뒤 빈칸을 뺀 것. chips: `│` 또는 ` | `로 나눠 둘 이상일 때.
- [ ] **Step 4: 통과 확인** — PASS.
- [ ] **Step 5: 커밋** — `feat(web): 상태 줄을 칩과 막대로 나눈다`

### Task 4: 서버가 Claude Code의 지난 글을 준다

**Files:**
- Create: `internal/history/history.go`, `internal/history/history_test.go`, `internal/server/prompts_test.go`
- Modify: `internal/server/server.go`(Deps에 `ClaudeConfig string`, nil이면 `commands.ConfigDir()`; 라우트), `internal/server/api_terminals.go`(`handlePrompts`), `internal/server/api_proxy.go`(라우트 목록에 `"GET /api/terminals/{t}/prompts"`)

**Interfaces:**
- Produces (Go): `type Prompt struct { Text string `json:"text"`; At int64 `json:"at"` }`; `func Read(config, project string, limit int) ([]Prompt, error)` — 새것부터. 서버 응답 `{prompts, source}`.
- Produces (web, Task 5가 씀): `api.terminals.prompts(addr: string, limit?: number): Promise<{ prompts: { text: string; at: number }[]; source: 'claude' | 'none' }>`.

- [ ] **Step 1: 실패하는 시험**(`history_test.go`, `t.TempDir()`의 `history.jsonl`):
  - 'reads one folder, newest first': 세 폴더가 섞인 줄 → 그 폴더 것만 새것부터.
  - 'drops a repeat': 같은 글이 이어지면 하나.
  - 'expands pasted text': `display: "봐 [Pasted text #1 +3 lines]"`, `pastedContents: {"1": {"id":1,"type":"text","content":"a\nb\nc"}}` → `"봐 a\nb\nc"`; `contentHash`뿐이면 자리표시 그대로.
  - 'skips broken lines' (Review Focus 5): JSON이 아닌 줄, `display`가 없는 줄은 건너뜀.
  - 'reads the last 4MB': 5MB 파일(앞부분은 다른 폴더) → 끝의 줄만, 첫 조각 줄은 버림.
  - 'limit': 600줄, limit 500 → 500.
  - 'no file': 파일 없음 → 빈 목록, 오류 아님(`os.ErrNotExist`면 `nil, nil`).
  - 서버 시험(`prompts_test.go`, hctest 코어, `Deps.ClaudeConfig` = TempDir): 터미널 폴더의 기록 → `source:"claude"`; 기록 파일 없음 → `{prompts:[], source:"none"}`; 없는 터미널 → 404.
- [ ] **Step 2: 실패 확인** — `env -u HC_TERMINAL_ID -u HC_TERMINAL_SOCKET -u HC_SCOPE go test ./internal/history ./internal/server -run 'Prompt|History'` → FAIL.
- [ ] **Step 3: 구현** — 폴더는 `handleCommands`처럼 `Foreground.Cwd`가 있으면 그것, 아니면 `Cwd`. 다른 기계의 터미널(주소에 `/`)이나 상대 경로면 `source:"none"`. 줄은 `bufio.Scanner`(줄 하나 1MB까지)로 읽는다. 웹 `api.ts`에 `prompts`를 더한다.
- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS; `make vet`.
- [ ] **Step 5: 커밋** — `feat: 서버가 Claude Code 기록에서 터미널 폴더의 지난 글을 준다`

### Task 5: 입력창의 ↑·↓ 지난 글

**Files:**
- Create: `web/src/lib/recall.ts`, `web/src/lib/recall.test.ts`
- Modify: `web/src/views/Terminal.tsx`(Composer), `web/src/views/Terminal.test.tsx`

**Interfaces:**
- Consumes: `api.terminals.prompts` (Task 4).
- Produces (`recall.ts`): `export function rememberSent(host: string, addr: string, text: string): void`, `export function sentHere(host: string, addr: string): string[]`(새것부터, 100개까지, localStorage 키 `mori.sent.<host>.<addr>`); `export class Recall { constructor(load: () => Promise<string[]>); older(draft: string): Promise<string | null>; newer(): string | null; reset(): void; get browsing(): boolean }` — older는 처음 부를 때 draft를 두고 한 칸 오래된 글(끝이면 null), newer는 한 칸 새 글, 끝에서 draft, 더 없으면 null.

- [ ] **Step 1: 실패하는 시험**:
  - `recall.test.ts`: `older('쓰던')` → 'b'(목록 ['b','a']), 다시 → 'a', 다시 → null; `newer()` → 'b', 다시 → '쓰던', 다시 → null; `reset()` 뒤 다시 처음부터. `rememberSent`는 100개를 넘으면 오래된 것을 버리고 같은 글이 이어지면 하나.
  - `Terminal.test.tsx`('recalls'): `reply`가 `/prompts`에 `{prompts:[{text:'둘째',at:2},{text:'첫째',at:1}],source:'claude'}`; 빈 입력창에 초점, ArrowUp → `box.value '둘째'`, 캐럿 끝, ArrowUp → '첫째', ArrowDown → '둘째', ArrowDown → ''(쓰던 글).
  - 'leaves ↑ to the text' (Review Focus 4): 값 `'a\nb'`, 캐럿 3(둘째 줄) → ArrowUp은 막지 않음(`fireEvent.keyDown`이 true); 고르는 창(`SCREENS.model`)이 떠 있으면 ArrowUp은 창으로(`ws.input()`에 `'\x1b[A'`), 지난 글 요청 없음.
  - 'falls back to what was sent here': `/prompts`가 `source:'none'` → 이 기기에서 보낸 글(보내기 뒤 `rememberSent`)이 나온다.
  - 'edits leave the recall': 지난 글을 고치면(입력) 다음 ↑는 처음부터.
- [ ] **Step 2: 실패 확인** — `npx vitest run src/lib/recall.test.ts src/views/Terminal.test.tsx -t 'recall'` → FAIL.
- [ ] **Step 3: 구현** — Composer `onKeyDown` 순서: 빗금 목록 → 거절 Esc → 고르는 창 키(결정 221) → 조작 키(Task 7) → ↑·↓ 지난 글 → Tab 안내(Task 8) → ⌘Enter. ↑는 캐럿이 첫 줄(`value.lastIndexOf('\n', caret - 1) < 0`)일 때, ↓는 지난 글을 보는 중이고 캐럿이 마지막 줄일 때. 넣은 글은 `announce(text)`(polite). 보내기에 성공하면 `rememberSent`와 `recall.reset()`.
- [ ] **Step 4: 통과 확인** — PASS, `npx tsc --noEmit`.
- [ ] **Step 5: 커밋** — `feat(web): 입력창에서 ↑·↓로 Claude Code의 지난 글을 불러온다`

### Task 6: 덮개 겸 상태 띠, 전환, 알림

**Files:**
- Create: `web/src/views/Cover.tsx`, `web/src/lib/coverpref.ts`
- Modify: `web/src/views/Terminal.tsx`, `web/src/views/terminal.css`, `web/src/views/Terminal.test.tsx`, `web/src/styles/styles.test.ts`

**Interfaces:**
- Consumes: `readBox`, `BoxLook`, `Mode` (Task 2), `readStatus` (Task 3), `Shot.view` (Task 1).
- Produces: `coverpref.ts`: `export const boxShown = signal<boolean>(…)`(키 `mori.box.shown`, 기본 false), `setBoxShown(on)`, `resetBoxPref()`. `Cover.tsx`: `export function useBox(o: { screen; ready; on: boolean; size }): { box: BoxLook | null; mode: Mode | null }`(mode는 마지막으로 읽은 것), `export function StatusBand(p: { box: BoxLook; rowTop: number; parts: StatusPart[]; phone: boolean; onMode: () => void; onFocus: () => void }): JSX.Element`. Terminal은 `covered: boolean`과 `boxText: boolean`을 계산해 Task 7·8에 쓴다.

- [ ] **Step 1: 실패하는 시험**(`Terminal.test.tsx` 'the cover'):
  - 'covers an empty box with the status band': 화면에 입력칸+상태 줄+모드 줄 견본 → `region "Claude Code 상태"`가 `.term-stage` 안에, 칩 'Opus 5.5', 막대(`role="progressbar"`, `aria-valuenow="6"`), PC 입력창 줄에 단추 "모드: 묻지 않음"; 띠의 `style.top`은 `${padTop + (box.top - view) * cellH}px`.
  - 'the mode button sends shift+tab': 누르면 `ws.input()`에 `'\x1b[Z'`.
  - 'shows the box with text and says so': 입력칸에 기본색 `abc` → 띠 없음, `.term-boxnote` 글 "터미널 입력칸에 글이 있습니다 — 보내면 그 뒤에 이어 붙습니다", polite로 한 번.
  - 'keeps the cover while the box sends' (Review Focus 3): `/send`가 끝나지 않는 동안 입력칸에 기본색 글 → 띠 그대로, 알림 없음.
  - 'does not cover' (Review Focus 2): 보기 전용; `ws.json({type:'size', cols: 120, rows: 40})`로 이 기기 크기와 다름; `FakeScreen.scrollTo(false)`로 입력칸이 화면 밖; 고르는 창(`SCREENS.model`); "Claude Code 창 알아보기" 꺼짐; 클래식 화면(`show(text, 'normal')`) → 모두 띠 없음.
  - 'the switch shows the box': PC 머리글 "터미널 입력칸 보기"(`aria-pressed`) 누르면 띠 없음, 다시 누르면 띠; 폰은 "더 보기" 메뉴의 체크 항목.
  - 'keeps the last mode on the PC button': 띠가 내려간 뒤(고르는 창)에도 "모드: 묻지 않음".
  - `styles.test.ts`: `.term-cover`가 `position: absolute;`, `z-index: 4;`, `background-color: var(--color-background-surface);`.
- [ ] **Step 2: 실패 확인** — `npx vitest --clearCache && npx vitest run src/views/Terminal.test.tsx -t 'cover|switch|mode'` → FAIL.
- [ ] **Step 3: 구현** — `useBox`는 `usePick`처럼 한 프레임에 한 번 `readBox(screen.shot(DEPTH))`. 덮는 조건: Claude Code 터미널 && `pickOn` && `!boxShown` && `canType`(보기 전용 아님) && `kind === 'alternate'` && 이 기기 fit과 터미널 size가 같음 && 입력칸이 화면 안(`box.top - view`가 0 이상) && `box.text === ''`. 보내는 중(Composer가 `onSending(busy)`로 알림)에는 마지막 덮개 상태를 둔다. 띠: `section.term-cover`(층 4), 칩은 `.chip`, 막대는 `.bar`(`role="progressbar"`), 폰의 모드 단추는 띠 첫 칸 44px, 칩 줄은 가로 스크롤, 넘치면 아래 줄부터 뺌. 모드가 바뀌면 "모드: <이름>" polite 한 번. 띠를 누르면(칩과 단추 밖) 입력창에 초점(PC). 결정 행은 Task 9에서 쓴다.
- [ ] **Step 4: 통과 확인** — PASS, `npx tsc --noEmit`, `npx vitest run src/styles/styles.test.ts`.
- [ ] **Step 5: 커밋** — `feat(web): 터미널 입력칸과 그 아래를 Mori 상태 띠로 덮는다`

### Task 7: 덮개가 있을 때의 초점과 PC 조작 키

**Files:**
- Modify: `web/src/views/Terminal.tsx`, `web/src/views/Terminal.test.tsx`

**Interfaces:**
- Consumes: `covered` (Task 6).
- Produces: Composer props `onTermKey?: (e: KeyboardEvent) => boolean`(빈 입력창의 Esc와 Ctrl+글자를 터미널로; true면 보냄), `bind?: { current: ((text: string) => void) | null }`(Terminal이 경로를 입력창에 넣을 때).

- [ ] **Step 1: 실패하는 시험**('with the cover'):
  - PC로 열면 `document.activeElement`가 입력창(덮개가 있을 때), xterm `focused` 늘지 않음.
  - 터미널 칸을 누르면 PC는 입력창에 초점, 폰은 아무 일 없음(`FakeScreen.last().focused` 그대로, 입력창도 초점 없음).
  - 페이지에서 친 글자 'a'(초점 body) → 입력창이 초점을 받고 터미널로 아무것도 안 감(`ws.input()` 빔).
  - 빈 입력창 Esc → `ws.input()` `['\x1b']`; Ctrl+O → `['\x0f']`; Ctrl+V → 보내지 않음(기본 동작); 글이 있으면 Esc·Ctrl+O 보내지 않음; 빗금 목록이 열려 있으면 Esc는 목록을 닫음(Review Focus 4); 한글 조합 중(`isComposing`) 보내지 않음; 덮개가 없으면 보내지 않음.
  - 터미널 칸에 붙여 넣은 파일과 끌어 놓은 파일의 경로 → 입력창(`box.value`)에 들어가고 `ws.input()` 빔.
- [ ] **Step 2: 실패 확인** — `npx vitest run src/views/Terminal.test.tsx -t 'with the cover'` → FAIL.
- [ ] **Step 3: 구현** — 결정 188 처리기: 덮개가 있으면 글자 하나짜리 키는 입력창에 초점만 주고(기본 동작 그대로) 나머지는 보내지 않음. 조작 키 바이트는 `namedBytes('esc')`, Ctrl+글자는 `namedBytes('ctrl+'+key.toLowerCase())`. `upload`는 덮개가 있으면 `bind.current(path)`.
- [ ] **Step 4: 통과 확인** — PASS.
- [ ] **Step 5: 커밋** — `feat(web): 덮개가 있으면 초점과 친 글, PC 조작 키를 입력창이 맡는다`

### Task 8: 회색 안내를 입력창의 안내와 Tab으로

**Files:**
- Modify: `web/src/views/Terminal.tsx`, `web/src/views/Terminal.test.tsx`

**Interfaces:**
- Consumes: `BoxLook.hint` (Task 2), `useBox` (Task 6).
- Produces: Composer prop `hint?: string`.

- [ ] **Step 1: 실패하는 시험**('the hint'):
  - 입력칸 회색 `describe a task for a new session` → 입력창 `placeholder` 'describe a task for a new session · Tab'; 빈 입력창 Tab → 값이 그 글, 캐럿 끝, 기본 동작 막힘; 글이 있으면 Tab은 막지 않음; 빗금 목록이 열려 있으면 Tab은 목록의 것; 안내가 없으면 placeholder 그대로(PC '여러 줄로 보내기 · ⌘Enter').
  - "터미널 입력칸 보기"를 켜도 안내는 입력창에 보인다.
- [ ] **Step 2: 실패 확인** — FAIL.
- [ ] **Step 3: 구현** — 설계 §6.
- [ ] **Step 4: 통과 확인** — PASS.
- [ ] **Step 5: 커밋** — `feat(web): 터미널 입력칸의 회색 안내를 입력창에서 보이고 Tab으로 받는다`

### Task 9: 결정 행, 가짜 claude, 손 확인

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-mori-design.md`(217 고침, 188 덧붙임, 223~226), `docs/superpowers/specs/2026-11-12-mori-claude-input-design.md`(끝에 "만들며 정한 것")

- [ ] **Step 1:** 결정 행을 쓴다(설계 §10).
- [ ] **Step 2:** 가짜 claude(scratch, 저장소 밖)가 입력칸·상태 줄 세 줄·모드 줄을 그리고, 회색 안내(SGR `38;2;153;153;153`)와 친 글을 흉내 내게 한다. `.dev/test/<id>` 격리 코어와 Mori로 띄운다.
- [ ] **Step 3:** 헤드리스 Chrome으로 390×844, 1440×900, 밝음·어둠: 띠 자리와 모양, 모드 단추, 알림, 전환, ↑·↓, Tab, PC Esc, 폰에서 터미널 누름(자판 없음, 크기 그대로). 화면 사진을 본다.
- [ ] **Step 4:** `cd web && npm test`, `make build`, `make test`, `make vet`, `make test-clean`.
- [ ] **Step 5: 커밋** — `docs: 입력 넘겨받기의 결정 행과 만들며 정한 것을 적는다`
