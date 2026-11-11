# Mori Claude Code 고르는 창 구현 계획 (1단계)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code 터미널 맨 아래에 뜬 번호 목록과 안내 줄을 xterm 버퍼에서 알아봐 승인 막대 자리에 단추로 보여 주고, 누르면 알맞은 키를 보내며, 창이 떠 있으면 입력창은 "닫고 보내기"로 보내고, 기기마다 끌 수 있게 한다.

**Architecture:** `Screen.shot(n)`이 버퍼 맨 아래 n줄을 화면 칸 배열로 준다. 순수 함수 `look(shot)`(`lib/pick.ts`)이 그것을 `Look`으로 읽고, 순수 함수 `next()`(`lib/pickpanel.ts`)가 패널이 스스로 일으킨 크기 바뀜에 흔들리지 않게 패널 상태를 정한다. `usePick`과 `PickPanel`(`views/Pick.tsx`)이 읽고 그리며, 누르기는 `lib/pickpress.ts`가 주입받은 `Press`로 한다. Go와 서버는 바꾸지 않는다.

**Tech Stack:** Preact 10과 @preact/signals, TypeScript(strict), @xterm/xterm 6과 Unicode11, vitest 5와 jsdom.

**Spec:** `docs/superpowers/specs/2026-11-11-mori-claude-pickers-design.md` §6, §8, §10, §12–§14. 결정은 `docs/superpowers/specs/2026-11-08-mori-design.md` §3 #212–#214.

## Global Constraints

- 서버, Go, API는 바꾸지 않는다. 키는 지금 있는 `link.send`와 `api.terminals.keys(addr, keys, expect?)`로만 보낸다.
- `lib/xterm`에서는 타입만 가져온다. `Terminal.test.tsx`가 그 모듈의 `openScreen`만 흉내 내기 때문이다. `lib/shot.ts`는 `@xterm/xterm`에서 타입만 쓴다.
- 저장소에는 손으로 만든 견본만 둔다. 사용자 터미널에서 읽은 글(대화, 상태 줄)은 넣지도 인용하지도 않는다.
- AGENTS.md의 astryx 규칙을 따른다: 값은 토큰, 채움은 `background-color`, hover는 `@media (hover: hover)` 안의 덧칠, `:focus-visible`, disabled는 .5, 폰에서 44px, 소리 내는 말은 `announce()`만(새 `aria-live`·`role="alert"` 없음), 목록은 `.qrows`, 고른 줄은 `--color-accent-muted`.
- 값: `DEPTH = 40`, `SETTLE_MS = 1000`, `MIN_CAP = 120`(px), `SEE_MS = 1500`, `CLOSE_MS = 2000`. 마지막 항목 아래 빈 줄이 아닌 줄은 10줄까지, 제목은 3줄까지, 안내만 있는 창의 안내 줄은 빈 줄이 아닌 마지막 3줄 안.
- 글은 그대로 쓴다:
  - 머리: `승인 대기 — 골라서 응답`, `터미널이 고르기를 기다립니다`(제목 없는 목록), `터미널에 창이 떠 있습니다`(안내만 있는 창).
  - 알림: `목록이 바뀌어 고르지 않았습니다`(error), `화면에 보이는 부분만 복사했습니다`, `복사하지 못했습니다`(error).
  - 입력창: 단추 `닫고 보내기`, 실패 `창이 닫히지 않아 보내지 않았습니다`.
  - 읽어 주기: `고르는 목록: <제목>`(polite), 제목이 없으면 머리 글.
  - 설정: 이름 `Claude Code 창 알아보기`, 설명 `번호 목록과 안내 줄을 알아봐 입력창 위에 단추로 보여 줍니다. 끄면 터미널에서 고릅니다. 이 기기에만 적용됩니다.`
  - 빗금 목록: `/${name}: 보내면 아래에 고르는 목록이 뜹니다`, `/${name}: 보내면 터미널에 창이 열립니다`.

## Review Focus

1. Claude의 답 속 번호 목록(입력칸 위, 안내 줄 같은 글까지 있어도)에는 패널이 뜨지 않는다. → Task 3 `answer-list`, Task 5 `no panel for an answer list`
2. 입력칸에 친 번호 목록에는 패널이 뜨지 않는다. → Task 3 `typed-list`, Task 5 `no panel for a typed list`
3. 패널이 터미널을 줄여 Claude Code가 다시 그리는 동안 패널이 사라졌다 다시 뜨지 않는다. → Task 5 `does not flap through its own resize`
4. 누르기 전에 화면 목록이 바뀌었으면 키를 하나도 보내지 않는다. → Task 6 `sends nothing when the list changed`
5. 한글(두 칸), 오른쪽 미리보기 상자, 테두리 `│`, 40칸 줄바꿈을 화면 칸으로 센다. → Task 1 `wide cells`, Task 3 `korean beside a preview box`, `narrow-40`, `each sample reads the same through xterm`

## 파일 구조

| 파일 | 맡는 일 |
|---|---|
| `web/src/lib/shot.ts` (새) | xterm 버퍼 맨 아래 n줄을 칸 배열로 |
| `web/src/lib/hints.ts` (새) | 안내 줄 문법과 단추 이름 |
| `web/src/lib/pick.ts` (새) | `look(shot)`: 목록·안내만 있는 창·입력칸 알아보기 |
| `web/src/lib/pickpanel.ts` (새) | 패널 상태 줄이기 `next`, `restart`, 높이 `capOf` |
| `web/src/lib/pickpress.ts` (새) | `choose`, `tap`, `closeFor` |
| `web/src/lib/pickpref.ts` (새) | 기기 설정 `pickOn` |
| `web/src/views/Pick.tsx` (새) | `usePick`, `PickList`, `PickHints`, `PickPanel` |
| `web/src/views/PickSwitch.tsx` (새) | 설정 스위치 |
| `web/src/lib/xterm.ts` | `Screen.shot` |
| `web/src/lib/keys.ts` | `namedBytes` |
| `web/src/lib/slash.ts`, `web/src/views/Slash.tsx` | `PICK_COMMANDS`, `COMMON`에 btw, 알림 글 |
| `web/src/views/Terminal.tsx` | 패널 자리, AskBar 고르기 모드, 키 보내기, 닫고 보내기 |
| `web/src/views/Settings.tsx` | 스위치 자리 |
| `web/src/views/terminal.css`, `web/src/styles/styles.test.ts` | `.term-pick*` |
| `web/test/cells.ts`, `web/test/screens.ts`, `web/test/screens/*.txt` (새) | 칸 너비, 견본, 견본을 Shot으로 |
| `web/test/fakeScreen.ts` | `show`, `shot` |

## 실행 방식

Native(superpowers:executing-plans): 이 대화에서 작업마다 시험을 먼저 쓰고, 작업마다 `feat/claude-pickers-1`에 커밋한다. 끝에 새 검토자 한 명이 브랜치 전체를 본다. 명령은 `cd /Users/ikhyeon/dev/proj/Mori/web` 기준이다.

---

### Task 1: Shot (1단계)

**Files:**
- Create: `web/src/lib/shot.ts`, `web/src/lib/shot.test.ts`, `web/test/cells.ts`
- Modify: `web/src/lib/xterm.ts` (Screen과 openScreen), `web/test/fakeScreen.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Shot { kind: 'normal' | 'alternate'; top: number; cols: number; lines: string[][] }
  export function shotOf(term: Pick<Terminal, 'buffer' | 'rows' | 'cols'>, n: number): Shot
  // Screen: shot(n: number): Shot
  // test/cells.ts: cellWidth(cp: number): 1 | 2; toCells(text: string, cols: number): string[]
  // FakeScreen: shown: string[]; show(text: string, kind?: Shot['kind']): void; shot(n: number): Shot
  ```

- [ ] **Step 1: 실패하는 시험** (`shot.test.ts`, `open()` 없는 headless Terminal에 Unicode11)
  - `wide cells`: 20×4에 `a한글❯ 1.`을 쓰면 마지막 줄 `lines[0].slice(0, 8)`이 `['a','한','','글','','❯',' ','1']`이고 줄마다 칸이 20개다.
  - `tells the alternate buffer`: 그냥 쓰면 `kind === 'normal'`, `\x1b[?1049h` 뒤에는 `'alternate'`.
  - `gives the live bottom while scrolled back`: 30줄을 쓰고 `scrollLines(-10)` 뒤 `shotOf(t, 2)`는 마지막 두 줄이고 `top === buffer.active.baseY + 2`.
  - `gives fewer lines than asked`: 4줄 화면에 `shotOf(t, 40).lines.length === 4`.
- [ ] **Step 2:** `npx vitest run src/lib/shot.test.ts` → FAIL(모듈 없음)
- [ ] **Step 3: `shotOf` 구현.** 줄은 `baseY + max(0, rows − n)`부터 `baseY + rows − 1`까지(보이는 곳이 아닌 살아 있는 맨 아래). 칸 글자는 `getWidth() === 0 ? '' : (getChars() || ' ')`, 칸 하나를 다시 쓴다(`getCell(x, cell)`). 글자만 담고 속성은 3단계에서(설계 §14에 적는다).
- [ ] **Step 4:** `xterm.ts`의 Screen에 `shot(n: number): Shot`(주석: 살아 있는 맨 아래 n줄)을, openScreen에 `shot: (n) => shotOf(term, n)`을 더한다.
- [ ] **Step 5:** `test/cells.ts`: `cellWidth`는 한글(U+1100–115F, U+AC00–D7A3, U+3130–318F), CJK(U+2E80–A4CF, U+F900–FAFF), 전각(U+FF00–FF60, U+FFE0–FFE6), 그림 문자(U+1F300–1F64F, U+1F900–1F9FF)와 U+2705에서 2, 나머지 1. `toCells`는 넓은 글자 뒤에 `''`를 넣고 `' '`로 채우며 cols를 넘으면 던진다. FakeScreen의 `show(text, kind = 'alternate')`는 줄을 화면 아래에 맞춰 `shown`에 두고 `tell(true)`, `shot(n)`은 `shown`의 마지막 n줄을 `toCells`로(top은 `rows − 줄 수`).
- [ ] **Step 6:** `npx vitest run src/lib/shot.test.ts && npx tsc --noEmit` → PASS
- [ ] **Step 7: 커밋** `feat(web): 화면 맨 아래를 칸으로 읽는 Shot`

### Task 2: 안내 줄과 키 바이트 (1단계)

**Files:**
- Create: `web/src/lib/hints.ts`, `web/src/lib/hints.test.ts`
- Modify: `web/src/lib/keys.ts`, `web/src/lib/keys.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HintPart { keys: string[]; action: string }
  export function hintLine(text: string): HintPart[] | null
  export interface Hint { label: string; aria?: string; key: string; move: boolean; copy?: boolean; danger?: boolean }
  export function readHints(parts: HintPart[]): Hint[]
  // keys.ts
  export function namedBytes(name: string, appCursor: boolean): string | null
  ```

- [ ] **Step 1: 실패하는 시험** (`hints.test.ts`)
  - `reads a list's hint line`: `readHints(hintLine('Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel')!)`의 label이 `['고르기','↑','↓','닫기']`, key가 `['enter','up','down','esc']`, ↑의 aria `위 화살표`, move는 ↑↓만 true.
  - `leaves out amend and notes`: `'Esc to cancel · Tab to amend'` → `['닫기']`.
  - `spreads a modifier over a slash`: `hintLine('shift+←/→ to switch answers')![0].keys` → `['shift+left','shift+right']`, readHints → `이전 답`, `다음 답`, move true.
  - `puts a danger last`: `'x to clear · c to copy · Esc to close'` → `['복사','닫기','x · clear']`, 마지막만 danger, 복사는 copy true.
  - `names an unknown action in English`: `'f to fork'` → `'f · fork'`, `'ctrl+e to explain'` → `'Ctrl+E · explain'`(key `ctrl+e`).
  - `prefers esc for closing`: `'Space, Enter or Esc to close'` → 단추 하나, key `esc`.
  - `maps scroll, effort and this session`: `'↑/↓ to scroll'` → `위로`,`아래로`; `'←/→ to adjust effort'` → `노력 낮추기`,`노력 높이기`; `'s to use this session only'` → `이 세션만`.
  - `is not a hint line`: `'Showing detailed transcript · ctrl+o to toggle'`, `'⏵⏵ accept edits on (shift+tab to cycle)'`, `'Notes: press n to add notes'`, `''` → 모두 null.
  - `keys.test.ts`의 `namedBytes`: `up`은 appCursor에 따라 `\x1bOA`/`\x1b[A`, `shift+right` `\x1b[1;2C`, `space` `' '`, `tab` `'\t'`, `shift+tab` `'\x1b[Z'`, `enter` `'\r'`, `esc` `'\x1b'`, `ctrl+e` `'\x05'`, `alt+x` `'\x1bx'`, `'2'` `'2'`, `'f5'` null.
- [ ] **Step 2:** `npx vitest run src/lib/hints.test.ts src/lib/keys.test.ts` → FAIL
- [ ] **Step 3: `hintLine`.** `' · '`로 나눈 모든 조각이 `^(?:press )?KEYS to (\S.*)$`(대소문자 무시)에 맞아야 하고, 하나라도 어긋나면 null. KEYS는 KEY를 `/`, `, `, ` or `로 이은 것, KEY는 `(ctrl|shift|alt)+`를 앞에 붙인 BASE, BASE는 enter·return·esc·escape·tab·space·backspace·↑·↓·←·→·up·down·left·right·`[a-z0-9[\]?]` 한 글자. `/`로 이은 맨 키는 앞 키의 수식키를 물려받는다. 이름은 코어가 받는 꼴(`enter`, `esc`, `shift+left`, `ctrl+e`)로 내고 `?`는 버린다.
- [ ] **Step 4: `readHints`.** 동작 글(소문자)에 맞춰 이름을 짓는다:

  | 동작 | 단추 |
  |---|---|
  | select, confirm, choose, submit | `고르기` |
  | cancel, exit, close, dismiss | `닫기` (키에 esc가 있으면 esc) |
  | navigate | 키마다 `↑ ↓ ← →` (aria `위 화살표` `아래 화살표` `왼쪽 화살표` `오른쪽 화살표`) |
  | scroll | `위로`, `아래로` |
  | effort | `노력 낮추기`, `노력 높이기` |
  | answer(s), response(s)과 좌우 키 | `이전 답`, `다음 답` |
  | copy | `복사` (copy) |
  | this session only | `이 세션만` |
  | amend, add note(s) | 빼기 |
  | delete, remove, clear, discard | danger, 맨 뒤 |
  | 그 밖 | `` `${보이는 키} · ${동작}` `` |

  보이는 키: Enter, Esc, Tab, ⇧Tab, Space, Ctrl+E, ↑↓←→, ⇧←, ⇧→, 글자는 그대로. `move`는 화살표, shift+화살표, space, tab, shift+tab.
- [ ] **Step 5: `namedBytes`.** 화살표는 `keyBytes`, shift+화살표는 `\x1b[1;2A–D`, ctrl+글자는 `withMods`, alt+c는 `'\x1b' + c`, 한 글자는 그대로, 그 밖은 null.
- [ ] **Step 6:** `npx vitest run src/lib/hints.test.ts src/lib/keys.test.ts` → PASS
- [ ] **Step 7: 커밋** `feat(web): 안내 줄을 단추로 읽고 키 이름을 바이트로`

### Task 3: look과 견본 (1단계)

**Files:**
- Create: `web/src/lib/pick.ts`, `web/src/lib/pick.test.ts`, `web/test/screens.ts`, `web/test/screens/*.txt`

**Interfaces:**
- Consumes: Task 1 `Shot`; Task 2 `hintLine`, `readHints`, `Hint`; Task 1 `toCells`.
- Produces:
  ```ts
  export const DEPTH = 40
  export interface Option { n: number; label: string; desc: string; mark: '' | 'on' | 'off' | 'current' }
  export interface Seen { id: string; sig: string; title: string; options: Option[]; cursor: number; hints: Hint[]; body: string; rows: number }
  export interface Box { top: number; rows: number }
  export interface Look { seen: Seen | null; box: Box | null }
  export const NOTHING: Look // { seen: null, box: null }
  export function look(shot: Shot): Look
  // test/screens.ts
  export const SCREENS: Record<string, string>  // import.meta.glob('./screens/*.txt', { query: '?raw', import: 'default', eager: true })
  export function toShot(text: string, cols?: number, kind?: Shot['kind']): Shot // cols 80, 'alternate', top 0
  export function cursorAt(text: string, n: number): string // ❯를 항목 n 줄로 옮긴 글
  ```

- [ ] **Step 1: 견본을 손으로 만든다** (`web/test/screens/`, 실제 대화 글 없이, 80칸; narrow-40만 40칸)

  | 견본 | 모양 | 나와야 하는 것 |
  |---|---|---|
  | `ask-preview` | `☐ 머리` 탭 줄, `│ 한글 질문`, 한글 항목 둘, 40칸부터 미리보기 상자(안에 상자와 가짜 `❯ 1.`, `├─ ✂ … ─┤`), `Notes: press n to add notes`, 가로줄, `Chat about this`, 목록 안내 줄 | 제목은 질문, 항목 2, cursor 1, 단추 고르기 ↑ ↓ 닫기 |
  | `permission` | 가로줄, 명령 이름과 명령, `Do you want to proceed?`, 항목 3, `Esc to cancel · Tab to amend · ctrl+e to explain` | 제목 `Do you want to proceed?`, 단추 닫기와 `Ctrl+E · explain` |
  | `model` | 가로줄, `Select model`과 설명 한 줄, `❯ 1. Default (recommended) ✔  설명`, 항목 2·3(두 칸 넘는 틈 뒤 설명), `Enter to confirm · ←/→ to adjust effort · s to use this session only · Esc to exit` | 제목 두 줄을 이은 글, mark `current`·''·'', desc |
  | `long-list` | 항목 12개, ` 9.`·`10.`처럼 점 칸을 맞춤 | 항목 12, 번호 1–12 |
  | `btw` | 대화, 가로줄, `/btw` 질문과 답 몇 줄, `↑/↓ to scroll · shift+←/→ to switch answers · c to copy · f to fork · x to clear · Esc to close` | options 없음, title '', body는 답 글, 단추 7개(x · clear가 맨 뒤) |
  | `idle` | 대화, 가로줄, `❯ `, 가로줄, 지어낸 상태 세 줄, `⏵⏵ accept edits on (shift+tab to cycle)` | seen null, box rows 3 |
  | `answer-list` | Claude 답 속 `❯ 1. Yes`, `  2. No`, `Esc to cancel`, 그 아래 입력칸 | seen null, box 있음 |
  | `typed-list` | 입력칸 안 `❯ 1. 첫째`, `  2. 둘째`, `Enter to select · Esc to cancel` | seen null |
  | `narrow-40` | `permission`을 40칸에, 항목 2가 다음 줄로 넘침 | 항목 3, 넘친 줄은 desc |
  | `box-empty`, `box-text`, `box-multiline` | 빈 입력칸, 글 한 줄, 세 줄 | seen null, box rows 3·3·5 |

- [ ] **Step 2: 실패하는 시험** (`pick.test.ts`)
  - 견본마다 위 표의 값을 `expect`로(`look(toShot(SCREENS.x))`).
  - `korean beside a preview box`: `ask-preview`의 label에 `┌│└❯[` 글자가 없고 한글 label이 견본과 같다.
  - `narrow-40`: `toShot(SCREENS['narrow-40'], 40)`에서 항목 3.
  - `keeps the id and changes the sig when the cursor moves`: `cursorAt(SCREENS.model, 2)`는 같은 id, 다른 sig, cursor 2.
  - `needs a hint line`: `model`에서 안내 줄을 지우면 null.
  - `needs exactly one cursor`: ❯를 지우면 null, 둘이면 null.
  - `needs numbers without a gap`: 항목 2를 지우면 null.
  - `needs the list near the bottom`: 마지막 항목 아래에 빈 줄이 아닌 줄을 11줄 넣으면 null.
  - `each sample reads the same through xterm`: 견본마다 rows = 줄 수인 headless Terminal에 `\r\n`으로 이어 쓰고 `shotOf(t, rows).lines`가 `toShot(text, cols, 'normal').lines`와 같다.
- [ ] **Step 3:** `npx vitest run src/lib/pick.test.ts` → FAIL
- [ ] **Step 4: `look` 구현.** 순서:
  1. 상자 자르기: 열 c>0의 `┌`(앞 칸은 공백)부터 같은 열의 `└`까지, 그 줄들의 c 이후 칸을 공백으로. 가장 왼쪽 c부터.
  2. 줄 앞뒤의 `│`는 공백으로 바꿔 열을 지킨다. 글은 칸을 이어 만든다.
  3. `isRule`: 다듬은 글이 `─╭╮╰╯┌┐└┘├┤` 중 하나로 시작하고 끝나며 `─`가 20개 이상이고 cols의 절반 이상.
  4. 항목: `^(\s*)(❯\s+)?(\d{1,2})\.\s+(\S.*)$`. 맨 아래 항목 k에서 위로 k−1 … 1을 찾는다. 숫자 열이나 점 열이 같아야 하고, 사이에는 빈 줄과 더 들여 쓴 줄만.
  5. `❯`가 붙은 항목이 꼭 하나(cursor).
  6. desc: 항목 바로 다음의 더 들여 쓴 줄들(빈 줄 없이, `Notes:`로 시작하지 않음)을 `' '`로 잇고, 같은 줄의 두 칸 넘는 틈 뒤 글도 앞에 붙인다.
  7. mark: label 앞 `[ ]`·☐는 off, `[x]`·`[✔]`·`[✓]`·☑·☒는 on, 끝의 ✔는 current. 표시는 label에서 뺀다.
  8. 제목: 첫 항목 위 빈 줄을 건너뛰고 빈 줄이 아닌 줄을 3줄까지, 가로줄이나 탭 줄(← ☐ ☒ ☑ ✔ ◯로 시작)에서 멈춘다. `│╭╮╰╯─`를 빼고 위에서 아래로 `' '`로 잇는다.
  9. 마지막 항목 아래: 빈 줄이 아닌 줄 10줄까지, 그 안에 `hintLine`이 null이 아닌 줄(맨 아래 것)이 꼭 있어야 한다.
  10. 입력칸: 가로줄, 첫 글자가 `❯`인 줄, 그 아래 어딘가의 닫는 가로줄. 맨 아래 것을 `box`로(`top = shot.top + i`, rows는 두 가로줄을 넣은 줄 수). 첫 항목 줄이 입력칸 안에 있거나 입력칸이 목록 아래에 있으면 seen null.
  11. 목록이 없을 때 안내만 있는 창: 빈 줄이 아닌 마지막 3줄 안에 안내 줄이 있고, 입력칸이 없고, 그 위에 가로줄이 있다. 영역은 가로줄+1 … 안내 줄, options `[]`, cursor 0, title `''`, id는 안내 줄 글의 해시.
  12. id: FNV-1a(`title + '\0' + labels.join('\0')`)의 16진. sig: 영역 첫 줄(제목, 없으면 첫 항목)부터 안내 줄까지 자른 글의 FNV-1a. body: 안내 줄 위 영역의 글(줄 끝 공백 없이). rows: 안내 줄 − 영역 첫 줄 + 1.
- [ ] **Step 5:** `npx vitest run src/lib/pick.test.ts` → PASS, `npx tsc --noEmit` → 오류 없음
- [ ] **Step 6: 커밋** `feat(web): 화면 맨 아래의 고르는 창 알아보기`

### Task 4: 기기 설정, 스위치, 빗금 목록 알림 (1단계)

**Files:**
- Create: `web/src/lib/pickpref.ts`, `web/src/views/PickSwitch.tsx`, `web/src/views/PickSwitch.test.tsx`
- Modify: `web/src/views/Settings.tsx:101-103`, `web/src/lib/slash.ts:10`, `web/src/views/Slash.tsx:88-93`, `web/src/views/Terminal.test.tsx:589`, `web/src/lib/slash.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // pickpref.ts (termfont.ts의 꼴, 키 'mori.pick')
  export const pickOn: Signal<boolean>   // 저장 값이 false가 아니면 true
  export function setPickOn(on: boolean): void
  export function resetPickPref(): void  // 시험용
  // slash.ts
  export const PICK_COMMANDS = ['model', 'output-style', 'theme', 'export', 'copy', 'rewind', 'memory', 'login']
  // COMMON = ['compact', 'clear', 'model', 'resume', 'context', 'btw']
  export function PickSwitch(): JSX.Element
  ```

- [ ] **Step 1: 실패하는 시험**
  - `PickSwitch.test.tsx` `turns the windows off for this device`: 스위치(role switch, 이름 `Claude Code 창 알아보기`)는 처음 켜져 있고, 누르면 `pickOn.value === false`, `localStorage['mori.pick'] === 'false'`.
  - `Terminal.test.tsx:589`: `/model` 고르면 알림 `'/model: 보내면 아래에 고르는 목록이 뜹니다'`.
  - 새 시험 `tells a window the list will not show`: menu인 `config` → `'/config: 보내면 터미널에 창이 열립니다'`.
  - 새 시험 `tells the terminal when the setting is off`: `setPickOn(false)` 뒤 `/model` → `'/model: 보내면 터미널에 창이 열립니다'`.
  - `slash.test.ts`: `COMMON`에 `btw`가 있다.
- [ ] **Step 2:** `npx vitest run src/views/PickSwitch.test.tsx src/views/Terminal.test.tsx src/lib/slash.test.ts` → FAIL
- [ ] **Step 3:** `pickpref.ts`, `PickSwitch.tsx`(SettingsPush.tsx 242–261의 `label.st-row` 꼴, `input.st-check[role=switch]`), Settings.tsx ThemeCard의 글꼴 설명 아래에 `<PickSwitch />`, slash.ts 두 줄, Slash.tsx `choose`의 알림을 `pickOn.value && PICK_COMMANDS.includes(c.name)`로 가른다. Terminal.test의 `beforeEach`에 `resetPickPref()`.
- [ ] **Step 4:** 같은 명령 → PASS
- [ ] **Step 5: 커밋** `feat(web): 고르는 창 기기 설정과 빗금 목록 알림`

### Task 5: 패널 상태, 읽기 훅, 패널, 터미널 자리 (1단계)

**Files:**
- Create: `web/src/lib/pickpanel.ts`, `web/src/lib/pickpanel.test.ts`, `web/src/views/Pick.tsx`
- Modify: `web/src/views/Terminal.tsx` (파생 값 226–247, askBar 469–486, PC 544, 폰 dock, AskBar 664–749), `web/src/views/Terminal.test.tsx`

**Interfaces:**
- Consumes: Task 3 `look`, `Look`, `Seen`, `DEPTH`, `NOTHING`; Task 2 `Hint`; Task 4 `pickOn`.
- Produces:
  ```ts
  // pickpanel.ts
  export interface Panel { seen: Seen | null; stale: boolean; since: number; lost: number | null; held: string | null }
  export const NO_PANEL: Panel  // { seen: null, stale: false, since: 0, lost: null, held: null }
  export const SETTLE_MS = 1000, MIN_CAP = 120
  export function next(p: Panel, l: Look, at: number): Panel
  export function restart(p: Panel, at: number): Panel  // 보이는 패널의 since를 at으로
  export function capOf(total: number, cellH: number, rows: number, viewH: number): number
  // Pick.tsx
  export interface PickOptions { screen: { current: Screen | null }; ready: unknown; on: boolean; size: unknown; measure: () => { total: number; cellH: number; viewH: number } }
  export interface PickState { seen: Seen | null; stale: boolean; cap: number; now(): Look; wait(test: (l: Look) => boolean, ms: number): Promise<Look | null> }
  export function usePick(o: PickOptions): PickState
  export function PickList(p: { seen: Seen; disabled: boolean; onChoose: (n: number) => void }): JSX.Element
  export function PickHints(p: { hints: Hint[]; disabled: boolean; skip?: string; onHint: (h: Hint) => void }): JSX.Element | null
  export function PickPanel(p: { id: string; seen: Seen; cap: number; disabled: boolean; onChoose: (n: number) => void; onHint: (h: Hint) => void }): JSX.Element
  ```

- [ ] **Step 1: 실패하는 시험** (`pickpanel.test.ts`)
  - `shows a new window at once`, `updates the same window`(cursor가 바뀌어도 since 그대로).
  - `keeps a window that went a moment ago, stale`: 보인 지 100ms 뒤 seen 없음 → 같은 seen, `stale`, `lost`.
  - `drops it after SETTLE_MS and holds it`: 보인 지 100ms에 잃고 1000ms 뒤 → seen null, `held === id`; 같은 id가 다시 와도 null; `box`가 오면 held null.
  - `does not hold a window lost late`: 보인 지 2000ms에 잃고 1000ms 뒤 → held null.
  - `drops at once for the box`: 보이는 동안 seen 없이 box → NO_PANEL.
  - `restart` 뒤에는 늦게 잃어도 held.
  - `capOf(0, 17, 10, 768) === 120`, `capOf(800, 17, 10, 900) === 450`, `capOf(800, 17, 30, 2000) === 256`.
- [ ] **Step 2: 실패하는 화면 시험** (`Terminal.test.tsx`의 새 `describe('pickers')`, 가짜 시계 `setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame Date`, 붙인 뒤 `FakeScreen.last().show(...)`와 `frame()`)
  - `shows the list of a window at the bottom`: `model` → region 이름 `Select model Switch …`, 줄 3개, 첫 줄 `aria-current="true"`, 단추 고르기·노력 낮추기·노력 높이기·이 세션만·닫기, 읽어 주기 `고르는 목록: Select model …`.
  - `shows nothing while idle`, `no panel for an answer list`, `no panel for a typed list`: `.term-pick` 없음.
  - `does not flap through its own resize`: `model` → `ws.json({ type: 'size', cols: 80, rows: 20 })` → 반쯤 그린 화면 → 패널이 그대로 있고 단추는 disabled → `model` → enabled, 읽어 주기는 한 번만.
  - `holds a lasting cut until the box shows`: 위에서 1000ms 지나면 패널 없음, `model`이 다시 와도 없음, `idle` 뒤 `model`이면 다시 뜸.
  - `turns off with the setting`: `setPickOn(false)` → 없음.
  - `shows an observed terminal's list with its buttons off`.
  - `answers a blocked window by its list`: blocked `term`과 `permission` → region `승인 대기 — 골라서 응답`, 항목 줄 3개, Esc 키와 `거절하고 지시`는 그대로, `1`·`2`·`3`·`Enter` 키 없음, 안내 단추는 Esc 없이.
  - `keeps the keys for a blocked hint-only window`: blocked와 `btw` → 머리 `승인 대기 — 키로 응답`과 숫자 키.
- [ ] **Step 3:** `npx vitest run src/lib/pickpanel.test.ts src/views/Terminal.test.tsx` → FAIL
- [ ] **Step 4: `pickpanel.ts`.** `next`:
  - seen이 있을 때: id가 held면 p 그대로, 보이는 id와 같으면 `{ ...p, seen, stale: false, lost: null }`, 다르면 `{ seen, stale: false, since: at, lost: null, held: null }`.
  - seen이 없을 때: 보이는 것이 없으면 box가 있으면 `{ ...p, held: null }`, 아니면 p. box가 있으면 NO_PANEL. 그 밖에는 `lost = p.lost ?? at`, `at − lost < SETTLE_MS`면 `{ ...p, stale: true, lost }`, 아니면 `{ ...NO_PANEL, held: lost − p.since < SETTLE_MS ? p.seen.id : null }`.

  `capOf = round(max(MIN_CAP, min(viewH / 2, total − cellH × (rows + 2))))`.
- [ ] **Step 5: `Pick.tsx`.**
  - `usePick`: onView마다 rAF 한 번으로 모아 `look(screen.shot(DEPTH))`를 읽고 `next`에 넣는다. 붙을 때와 `on`이 바뀔 때 읽고, stale이면 `lost + SETTLE_MS`에 다시 읽는다. `size`가 바뀌면 `restart`. cap은 id가 새로 보일 때 한 번 `capOf(…, seen.rows, …)`. `on`이 거짓이면 NO_PANEL. `wait`는 onView마다 시험하고 ms 뒤 null.
  - `PickList`: `ul.qrows.term-pick-list > li > button.qrow.term-pick-row`, cursor 줄은 `.is-selected`와 `aria-current="true"`, 안에 `span.term-pick-n`, `span.qrow-main`(`qrow-title`, `qrow-sub`). mark는 `span.term-pick-mark`: current는 check 아이콘과 `지금 쓰는 것`, on은 check와 `고름`, off는 `안 고름`.
  - `PickHints`: `div.term-pick-hints`에 `.btn.btn-sm`, danger는 `.btn-danger`, `skip` 키는 뺀다.
  - `PickPanel`: `section.term-pick[aria-labelledby]`, `h2.term-pick-title`(한 줄, 말줄임), 몸은 `max-height: cap`으로 안에서 스크롤. 새 id마다 `announce`. `import './lists.css'`.
- [ ] **Step 6: Terminal.tsx.** 
  - 읽기: `on = !!t && isClaude(t) && pickOn.value && active`, `measure`는 stage의 clientHeight + 루트 안 `.term-ask, .term-pick`의 높이, `screen.cell()[1]`, `innerHeight`. `look`과 이름이 겹치지 않게 `usePick`만 가져온다.
  - blocked이고 seen에 options가 있으면 AskBar에 `pick` 속성(`{ list, hints }`)을 넘겨 머리 글을 바꾸고 숫자·Enter 키 대신 PickList, Esc 키와 거절은 두고(stale이어도 누를 수 있음), 안내 단추는 esc 없이.
  - 그 밖에는 `pickPanel`(seen이 있을 때)을 PC와 폰 dock에서 `{askBar || pickPanel}` 자리에. 관찰 중이면 disabled.
  - 이 작업에서 `onChoose`와 `onHint`는 Task 6의 자리이므로 빈 함수로 둔다.
- [ ] **Step 7:** `npx vitest run src/lib/pickpanel.test.ts src/views/Terminal.test.tsx && npx tsc --noEmit` → PASS
- [ ] **Step 8: 커밋** `feat(web): 고르는 창 패널을 승인 막대 자리에`

### Task 6: 누르기 (1단계)

**Files:**
- Create: `web/src/lib/pickpress.ts`, `web/src/lib/pickpress.test.ts`
- Modify: `web/src/views/Terminal.tsx` (answer 276–293 옆), `web/src/views/Terminal.test.tsx`

**Interfaces:**
- Consumes: Task 3 `Look`, `Seen`; Task 2 `Hint`, `namedBytes`; Task 5 `PickState.now`, `PickState.wait`.
- Produces:
  ```ts
  export interface Press { now(): Look; wait(test: (l: Look) => boolean, ms: number): Promise<Look | null>; move(names: string[]): Promise<void>; answer(name: string): Promise<void> }
  export const SEE_MS = 1500, CLOSE_MS = 2000
  export function choose(p: Press, seen: Seen, n: number, blocked: boolean): Promise<boolean>
  export function tap(p: Press, seen: Seen, h: Hint): Promise<boolean>
  export function closeFor(p: Press, seen: Seen): Promise<boolean>
  ```

- [ ] **Step 1: 실패하는 시험** (`pickpress.test.ts`, 기록하는 가짜 Press)
  - `choose`: sig가 다르면 false, 아무것도 안 보냄. blocked·n≤9·여러 고르기 아님 → `answer('2')`만. 그 밖은 `move(['down','down'])`, 같은 id에 cursor n이 보이면 `answer('enter')`. 안 보이면(SEE_MS) false, Enter 없음. 여러 고르기는 옮기기만 하고 true.
  - `tap`: move 단추는 `move([key])`, 아니면 `answer(key)`; sig가 다르면 false.
  - `closeFor`: 창이 이미 없으면 Esc 없이 box를 기다림; sig가 다르면 false; 아니면 `answer('esc')` 뒤 `!seen && box`를 CLOSE_MS까지.
- [ ] **Step 2: 실패하는 화면 시험** (`describe('pressing a window')`)
  - `blocked: a number carries expect`: 줄 2 → keys POST `{ keys: ['2'], expect: ASK }`.
  - `blocked: moves go without expect`: `↓` → `{ keys: ['down'] }`.
  - `blocked: item 10 moves, sees, then Enter`: `long-list`에서 10 → `{ keys: [down×9] }`, `cursorAt(…, 10)`을 보이면 `{ keys: ['enter'], expect: ASK }`.
  - `not blocked: arrows, then Enter once the cursor lands`: `model`에서 3 → `ws.input()`이 `\x1b[B\x1b[B`, `cursorAt(model, 3)` 뒤 `\r`이 더해진다.
  - `sends nothing when the list changed`: 패널을 그린 뒤 frame 없이 다른 화면을 보이고 누름 → 보낸 것 없음, 알림 `목록이 바뀌어 고르지 않았습니다`.
  - `no landing, no Enter`: 화살표 뒤 1500ms → `\r` 없음, 같은 알림.
  - `copies what the screen shows`: `btw`의 복사 → `navigator.clipboard.writeText(body)`, 알림 `화면에 보이는 부분만 복사했습니다`.
- [ ] **Step 3:** `npx vitest run src/lib/pickpress.test.ts src/views/Terminal.test.tsx` → FAIL
- [ ] **Step 4: `pickpress.ts`** (위 시험이 정하는 대로).
- [ ] **Step 5: Terminal.tsx.** `sendKeys(names, final)`: ask가 있으면 keys API, `expect`는 final일 때만; 없으면 `namedBytes`를 이어 `link.send`, 실패하면 keys API. Press는 `{ now, wait, move: (k) => sendKeys(k, false), answer: (k) => sendKeys([k], true) }`. 실행은 `answering`으로 잠그고, false면 `toast('목록이 바뀌어 고르지 않았습니다', 'error')`, 던지면 `fail('키를 보내지 못했습니다')`, 끝나면 `toEnd`. 복사 단추는 같은 id일 때 `copyText(seen.body)` 뒤 알림.
- [ ] **Step 6:** 같은 명령 → PASS
- [ ] **Step 7: 커밋** `feat(web): 고르는 창 단추로 키 보내기`

### Task 7: 닫고 보내기 (1단계)

**Files:**
- Modify: `web/src/views/Terminal.tsx` (ComposerProps 822, Composer 841), `web/src/views/Terminal.test.tsx`

**Interfaces:**
- Consumes: Task 6 `closeFor`; Task 5 `PickState`.
- Produces: `ComposerProps.closeFirst?: () => Promise<boolean>` (창이 보이고, blocked가 아니고, 칠 수 있을 때만).

- [ ] **Step 1: 실패하는 시험** (`describe('close and send')`)
  - `names the send button for an open window`: `model`이 보이면 `닫고 보내기`, `idle`이면 `보내기`.
  - `closes, waits for the box, then sends`: 글을 치고 누름 → `ws.input()`에 `\x1b`, `idle`을 보이면 send POST에 그 글.
  - `keeps the text when the window stays`: 2000ms 뒤 `p.term-held` `창이 닫히지 않아 보내지 않았습니다`, assertive 읽어 주기, 글이 남고 send 없음.
  - `keeps the blocked path`: blocked면 단추가 `보내기`이고 409 길 그대로.
- [ ] **Step 2:** `npx vitest run src/views/Terminal.test.tsx` → FAIL
- [ ] **Step 3:** 단추 글은 `rejecting ? '거절하고 보내기' : closeFirst ? '닫고 보내기' : '보내기'`. 보내기 전에 `closeFirst`가 false면 `stuck`을 켜고 `announce(…, 'assertive')` 뒤 그만둔다. `closeFirst`가 없어지면 `stuck`을 끈다. `import { announce } from '../lib/announce'`.
- [ ] **Step 4:** 같은 명령 → PASS
- [ ] **Step 5: 커밋** `feat(web): 창이 떠 있으면 닫고 보내기`

### Task 8: 모양 (1단계)

**Files:**
- Modify: `web/src/views/terminal.css`, `web/src/styles/styles.test.ts`

- [ ] **Step 1: 실패하는 시험** (`styles.test.ts`)
  - `a picker row is a touch target on a phone`: `phoneRules(sheets['../views/terminal.css']).get('.term-pick-row')`가 `/min-height: 44px/`.
  - 지금 있는 검사(토큰만, hover, background-color, 스크롤 상자의 `position:`)가 새 규칙에도 통과.
- [ ] **Step 2:** `npx vitest run src/styles/styles.test.ts` → FAIL
- [ ] **Step 3:** `.term-pick`(승인 막대와 같은 자리, 위 1px 선, `--spacing-*`), `.term-pick-title`(heading이 아닌 label 크기, semibold, 한 줄 말줄임), `.term-pick-body`(`position: relative; overflow-y: auto`), `.term-pick-row`(버튼 초기화 `width: 100%; border-width: 0 0 1px; background-color: transparent; text-align: start; font: inherit`), `.term-pick-n`(`--text-code-*`, 너비 고정), `.term-pick-mark`, `.term-pick-hints`(줄 바꿈 되는 flex, gap `--spacing-2`). 폰에서 줄과 단추 44px. `.term-ask-key:disabled, .term-ask-reject:disabled`를 `opacity: .5`로.
- [ ] **Step 4:** `npm test` → 모두 PASS
- [ ] **Step 5: 커밋** `style(web): 고르는 창 패널 모양`

### Task 9: 손으로 확인과 문서 (1단계)

**Files:**
- Modify: `docs/superpowers/specs/2026-11-11-mori-claude-pickers-design.md` (5행, §14), 메모리 `picker-ui-review.md`
- Scratch: 가짜 `claude`(셸 감싸개와 `python3 -I`로 도는 그리기 프로그램)

- [ ] **Step 1:** `cd /Users/ikhyeon/dev/proj/Mori && make build && make vet && make test && (cd web && npm test)` → 모두 통과
- [ ] **Step 2:** `.dev/test/<id>`에 격리 코어를 띄우고 가짜 `claude`를 `hc run --bg`로. 가짜는 `/model`, 승인, `/btw`, 입력칸을 그리고 ↑↓·Enter·Esc에 따라 다시 그린다.
- [ ] **Step 3:** `bin/mori serve -hc-session mori-test-<id> -home .dev/test/<id>/home -listen 127.0.0.1:<port> -log …`, 화면 밖 WKWebView로 390×844와 1440×900, 밝게와 어둡게, 쉼·hover·누름·focus-visible·disabled(stale, 관찰) 모습을 찍어 본다. 포커스를 빼앗지 않는다.
- [ ] **Step 4:** 설계 글 5행과 §14 #16을 고치고(결정 행은 이미 옮겼다), §14에 만든 사람의 결정을 더한다: 안내 줄 필수와 입력칸 `❯` 줄 거부, desc는 이어진 줄만이고 `Notes:`는 아님, 실패는 알림, cursor 규칙은 엄격, 관찰 중에도 패널, 안내만 있는 창은 위 가로줄 필요와 자기 머리 글, 붙잡기는 보인 직후나 크기 바뀐 뒤만, 높이는 id마다 한 번이고 최소 120px, 닫기는 esc 먼저, /btw의 이전·다음 답 이름은 짐작, `/` 키 없음, 창이 이미 없으면 Esc 없이 기다림, Shot은 글자만, 제목은 이어서 말줄임, mode·empty는 3단계로.
- [ ] **Step 5:** `make test-clean`(`env -u HC_TERMINAL_ID -u HC_TERMINAL_SOCKET -u HC_SCOPE`), 메모리 갱신.
- [ ] **Step 6: 커밋** `docs: 고르는 창 1단계에서 정한 것`
