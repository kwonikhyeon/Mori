// The terminal screen (B-PC, B-Terminal; spec §3 #123–#127, #133). The
// program's screen fills the middle; above it the title and the tools,
// under it the keys a blocked program waits for, the quick keys on a
// phone and a box that sends several lines at once.
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { Chip } from '../components/Chip'
import { Confirm } from '../components/Confirm'
import { ConnBanner } from '../components/ConnBanner'
import { Icon } from '../components/Icon'
import { Menu, type MenuItem } from '../components/Menu'
import { ApiError } from '../lib/api'
import type { Closed, Size } from '../lib/attach'
import { now } from '../lib/clock'
import { fitSize } from '../lib/fit'
import { appName, askText, chip, endText, place, type EndFacts } from '../lib/format'
import { QUICK_KEYS } from '../lib/keys'
import { isApple } from '../lib/platform'
import { navigate, parseHash } from '../lib/router'
import { others, useHost } from '../lib/scope'
import { TermLink } from '../lib/termlink'
import { attachNote, BLOCKED_KEYS, quotePath, type AnswerKey, type AttachNote } from '../lib/termview'
import { effectiveTheme, terminalTheme } from '../lib/theme'
import { relTime } from '../lib/time'
import { toast, toastError } from '../lib/toast'
import type { TerminalView } from '../lib/types'
import { openScreen, type Screen } from '../lib/xterm'
import { gitFrom } from './Git'
import { nameOf } from './HostSwitch'
import { titleOf, type Variant } from './rows'
import './terminal.css'

/** The box settles before the terminal follows it, as when a keyboard slides in. */
const FIT_DELAY = 120
/** How long the sizes differ before 이 화면에 맞추기 is offered. */
const FIT_LATE = 600
const MAX_UPLOAD = 8 << 20
const ARROWS = new Set(['up', 'down', 'left', 'right'])
const NO_END: EndFacts = { reason: null, exit_code: null, signal: null }
const BROKEN: AttachNote = { kind: 'error', title: '터미널을 열 수 없습니다', detail: '화면을 그리지 못했습니다.', spin: false, late: false }

/** Keeps the focus where it is, in the terminal or the keyboard on a phone. */
const keep = (e: Event) => e.preventDefault()

export interface TerminalProps {
  addr: string
  variant: Variant
  /** The Git aside is open beside it (PC). */
  git?: boolean
  /** Where the phone's back button goes. */
  back?: string
}

export function Terminal({ addr, variant, git = false, back }: TerminalProps) {
  const h = useHost()
  const backTo = back ?? h.href({ name: 'queue' })
  const phone = variant === 'phone'
  const id = useId()
  const t = h.terminals.value.get(addr)
  const stage = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const screen = useRef<Screen | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const [link, setLink] = useState<TermLink | null>(null)
  const [broken, setBroken] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [killing, setKilling] = useState(false)
  const [killBusy, setKillBusy] = useState(false)
  const [drop, setDrop] = useState(false)

  // The cells that fit the stage inside the scroll box's padding.
  const measure = (): Size | null => {
    const st = stage.current
    const sc = scroll.current
    const s = screen.current
    if (!st || !sc || !s) return null
    const cs = getComputedStyle(sc)
    const px = (v: string) => parseFloat(v) || 0
    return fitSize(
      st.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
      st.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
      s.cell(),
    )
  }

  useEffect(() => {
    let dead = false
    let lk: TermLink | null = null
    let sc: Screen | null = null
    const t0 = h.terminals.peek().get(addr)
    setBroken(false)
    openScreen(host.current!, {
      fontSize: phone ? 12 : 13,
      theme: terminalTheme(effectiveTheme.peek()),
      cols: t0?.cols || 80,
      rows: t0?.rows || 24,
    }).then(
      (s) => {
        if (dead) {
          s.dispose()
          return
        }
        sc = s
        screen.current = s
        lk = new TermLink({
          addr,
          screen: s,
          fit: measure(),
          start: t0 ? { cols: t0.cols, rows: t0.rows } : null,
          api: h.api,
          store: h,
          url: h.ws('/ws/attach'),
          onUnauthorized: () => void h.unauthorized(),
        })
        setLink(lk)
        // A phone would open its keyboard.
        if (!phone) s.focus()
      },
      () => {
        if (!dead) setBroken(true)
      },
    )
    return () => {
      dead = true
      lk?.dispose()
      sc?.dispose()
      screen.current = null
      setLink(null)
    }
  }, [addr, phone, h])

  // The terminal follows the stage once it has settled.
  useEffect(() => {
    const el = stage.current
    if (!link || !el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(() => link.setFit(measure()), FIT_DELAY)
    }
    let stop: () => void
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(later)
      ro.observe(el)
      stop = () => ro.disconnect()
    } else {
      window.addEventListener('resize', later)
      stop = () => window.removeEventListener('resize', later)
    }
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [link])

  const st = link?.state.value ?? 'connecting'
  const observing = link?.observing.value ?? false
  const size = link?.size.value ?? null
  const fit = link?.fit.value ?? null
  const ended = link?.ended.value ?? null
  const reason = link?.reason.value ?? ''
  const finished = t?.state === 'finished' || st === 'closed'
  const active = !finished && st !== 'gone'
  const canType = active && !observing
  const blocked = canType && t?.status?.state === 'blocked'
  const open = st === 'open'
  const differs = open && canType && !!fit && !!size && (fit.cols !== size.cols || fit.rows !== size.rows)
  const showFit = useLater(differs, FIT_LATE)
  const note = broken ? BROKEN : finished ? null : attachNote(st, reason)
  const title = t ? titleOf(t, h.presets.value) : addr
  // Git opens for a session in a folder that is a repository.
  const repo = !!t?.folder_id && !!h.folders.value.find((f) => f.id === t.folder_id)?.repo
  const sub = t ? `${appName(t, h.presets.value)} · ${place(t, h.folders.value)}` : ''
  // With other hosts about, the header says which one the session runs on.
  const hostTag = others.value.length > 0 ? nameOf(h) : ''

  const fail = (what: string) => (e: unknown) => toastError(e, what)
  const answer = (k: AnswerKey) => {
    if (link?.send(k.bytes)) return
    h.api.terminals.keys(addr, [k.name]).catch(fail('키를 보내지 못했습니다'))
  }
  // What is sent another way than the stream shows the screen's end too.
  const toEnd = () => screen.current?.scrollToBottom()
  const interrupt = () => {
    h.api.terminals.interrupt(addr).then(toEnd, fail('중단하지 못했습니다'))
  }
  const kill = async () => {
    setKillBusy(true)
    try {
      await h.api.terminals.kill(addr)
    } catch (e) {
      toastError(e, '종료하지 못했습니다')
    } finally {
      // closed either way, so a toast is not under the dialog
      setKillBusy(false)
      setKilling(false)
    }
  }
  const remove = async () => {
    try {
      await h.api.terminals.remove(addr)
      if (phone) navigate(parseHash(backTo), { replace: true })
      else h.go({ name: 'queue' }, { replace: true })
    } catch (e) {
      toastError(e, '지우지 못했습니다')
    }
  }
  const rename = (next: string | null) => {
    setRenaming(false)
    if (next !== null) h.api.terminals.rename(addr, next).catch(fail('이름을 바꾸지 못했습니다'))
  }
  const upload = async (files: File[]) => {
    for (const f of files) {
      if (f.size > MAX_UPLOAD) {
        toast(`${f.name}: 8 MB를 넘는 파일은 올릴 수 없습니다`, 'error')
        continue
      }
      try {
        const r = await h.api.terminals.upload(addr, f)
        // The path goes where the cursor is; a person sees it typed.
        if (!link?.send(quotePath(r.path) + ' ')) toast(`올렸습니다: ${r.path}`)
      } catch (e) {
        toastError(e, '파일을 올리지 못했습니다')
      }
    }
  }
  const pickFile = () => file.current?.click()
  const observe = (on: boolean) => link?.setObserve(on)

  const titleEl =
    renaming && t ? (
      <RenameField initial={t.labels?.['mori.title'] ?? titleOf(t, h.presets.value)} onDone={rename} />
    ) : (
      <h1 class="term-title">{title}</h1>
    )

  const stageEl = (
    <div
      ref={stage}
      class={'term-stage' + (drop ? ' is-drop' : '')}
      onClick={() => {
        if (canType) screen.current?.focus()
      }}
      onDragOver={(e) => {
        if (!canType || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
        e.preventDefault()
        setDrop(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(false)
      }}
      onDrop={(e) => {
        setDrop(false)
        const fs = Array.from(e.dataTransfer?.files ?? [])
        if (!canType || fs.length === 0) return
        e.preventDefault()
        void upload(fs)
      }}
      onPasteCapture={(e) => {
        const fs = Array.from(e.clipboardData?.files ?? [])
        if (!canType || fs.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        void upload(fs)
      }}
    >
      <div ref={scroll} class="term-scroll">
        <div ref={host} class="term-host" />
      </div>
      <div class="term-status" role="status" aria-live="polite">
        {note && (
          <div class={`banner banner-${note.kind} term-note` + (note.late ? ' is-late' : '')}>
            <Icon name={note.spin ? 'refresh' : 'warning'} size={16} class={note.spin ? 'banner-icon spin' : 'banner-icon'} />
            <span class="banner-text">
              <b>{note.title}</b>
              {note.detail && <> {note.detail}</>}
            </span>
            {(st === 'gone' || st === 'error' || broken) && (
              <a class="term-note-link" href={h.href({ name: 'queue' })}>
                목록으로
              </a>
            )}
          </div>
        )}
      </div>
      {showFit && (
        <button
          type="button"
          class="btn btn-sm term-fit"
          onClick={(e) => {
            e.stopPropagation()
            link?.fitNow()
          }}
        >
          <Icon name="monitor" size={15} />이 화면에 맞추기
        </button>
      )}
      {drop && (
        <div class="term-drop" aria-hidden="true">
          여기에 놓으면 올립니다
        </div>
      )}
    </div>
  )

  const fileInput = (
    <input
      ref={file}
      type="file"
      multiple
      hidden
      onChange={(e) => {
        const fs = Array.from(e.currentTarget.files ?? [])
        e.currentTarget.value = ''
        if (fs.length) void upload(fs)
      }}
    />
  )

  const confirm = (
    <Confirm
      open={killing}
      title="이 세션을 종료할까요?"
      text="먼저 종료를 요청하고, 끝나지 않으면 강제로 끝냅니다."
      confirm="종료"
      danger
      busy={killBusy}
      onConfirm={() => void kill()}
      onCancel={() => setKilling(false)}
    />
  )

  const askBar = blocked && t && <AskBar t={t} phone={phone} id={id} onKey={answer} />
  const observeBar = observing && active && <ObserveBar onOff={() => observe(false)} />
  const endBar = finished && <EndBar t={t} ended={ended} onRemove={() => void remove()} />
  const composer = canType && <Composer addr={addr} phone={phone} id={id} onSent={toEnd} />

  if (!phone) {
    return (
      <div class="term term-pc">
        <header class="term-bar">
          <div class="term-id">
            <div class="term-title-row">
              {titleEl}
              {t && !renaming && <Chip info={chip(t)} />}
              {t && !renaming && (
                <button type="button" class="btn btn-icon btn-sm btn-ghost" aria-label="이름 바꾸기" title="이름 바꾸기" onClick={() => setRenaming(true)}>
                  <Icon name="pencil" size={15} />
                </button>
              )}
            </div>
            {sub && <p class="term-sub">{hostTag ? `${hostTag} · ${sub}` : sub}</p>}
          </div>
          <div class="term-tools">
            {canType && (
              <button type="button" class="btn btn-sm" onClick={pickFile}>
                <Icon name="paperclip" size={15} />
                파일 올리기
              </button>
            )}
            {active && (
              <button type="button" class="btn btn-sm" aria-pressed={observing} onClick={() => observe(!observing)}>
                <Icon name="eye" size={15} />
                보기 전용
              </button>
            )}
            {repo && (
              <button
                type="button"
                class="btn btn-sm"
                aria-pressed={git}
                aria-controls={git ? 'pc-aside' : undefined}
                onClick={() => h.go({ name: 'terminal', addr, git: !git })}
              >
                <Icon name="git" size={15} />
                Git
              </button>
            )}
            {active && (
              <button type="button" class="btn btn-sm" onClick={interrupt}>
                <Icon name="stop" size={15} />
                중단
              </button>
            )}
            {active && (
              <button type="button" class="btn btn-sm btn-danger" onClick={() => setKilling(true)}>
                <Icon name="power" size={15} />
                종료
              </button>
            )}
          </div>
        </header>
        {stageEl}
        {askBar}
        {observeBar}
        {endBar}
        {composer}
        {fileInput}
        {confirm}
      </div>
    )
  }

  const items: MenuItem[] = []
  if (active) {
    if (canType) items.push({ label: '파일 올리기', icon: 'paperclip', onSelect: pickFile })
    items.push({ label: '보기 전용', icon: 'eye', checked: observing, onSelect: () => observe(!observing) })
    if (t) items.push({ label: '이름 바꾸기', icon: 'pencil', onSelect: () => setRenaming(true) })
    items.push({ label: '중단', icon: 'stop', onSelect: interrupt })
    if (differs) items.push({ label: '이 화면에 맞추기', icon: 'monitor', onSelect: () => link?.fitNow() })
    items.push({ label: '종료', icon: 'power', danger: true, onSelect: () => setKilling(true) })
  } else {
    if (t) items.push({ label: '이름 바꾸기', icon: 'pencil', onSelect: () => setRenaming(true) })
    if (finished) items.push({ label: '목록에서 지우기', icon: 'trash', danger: true, onSelect: () => void remove() })
  }

  return (
    <div class="term term-phone">
      <header class="term-head">
        <a class="btn btn-icon btn-ghost term-back" href={backTo} aria-label="뒤로">
          <Icon name="back" size={22} />
        </a>
        <div class="term-id">
          {titleEl}
          {t && !renaming && (
            <div class="term-sub-row">
              {hostTag && <span class="term-hosttag">{hostTag}</span>}
              <Chip info={chip(t)} />
              <span class="term-sub">{sub}</span>
            </div>
          )}
        </div>
        {t && repo && !renaming && (
          <a
            class="btn btn-ghost term-git"
            href={h.href({ name: 'git', folder: t.folder_id, path: t.worktree || undefined })}
            onClick={() => {
              gitFrom.value = addr
            }}
          >
            <Icon name="git" size={18} />
            Git
          </a>
        )}
        {items.length > 0 && !renaming && <Menu label="더 보기" items={items} buttonClass="btn btn-icon btn-ghost term-more" />}
      </header>
      <ConnBanner class="term-banner" />
      <div class="term-body">
        {stageEl}
        <div class="term-dock">
          {askBar}
          {observeBar}
          {endBar}
          {canType && <QuickKeys link={link} open={open} />}
          {composer}
        </div>
      </div>
      {fileInput}
      {confirm}
    </div>
  )
}

/** on, once it has stayed on for ms. */
function useLater(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    setLate(false)
    if (!on) return
    const timer = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(timer)
  }, [on, ms])
  return on && late
}

/** The title in place: Enter or leaving keeps it, Escape does not. */
function RenameField({ initial, onDone }: { initial: string; onDone: (next: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (keepIt: boolean) => {
    if (done.current) return
    done.current = true
    const v = (ref.current?.value ?? '').trim()
    onDone(keepIt && v !== initial ? v : null)
  }
  return (
    <input
      ref={ref}
      class="input term-rename"
      aria-label="세션 이름"
      maxLength={100}
      defaultValue={initial}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}

interface AskBarProps {
  t: TerminalView
  phone: boolean
  id: string
  onKey: (k: AnswerKey) => void
}

/** What a blocked program asks, and the keys that answer it. */
function AskBar({ t, phone, id, onKey }: AskBarProps) {
  const head = id + '-ask'
  const msg = askText(t, 'blocked')
  const keys = BLOCKED_KEYS[phone ? 'phone' : 'pc'].map((k) => (
    <button
      key={k.name}
      type="button"
      class={'term-ask-key' + (k.label.length > 1 ? ' is-word' : '')}
      onPointerDown={keep}
      onMouseDown={keep}
      onClick={() => onKey(k)}
    >
      {k.label}
    </button>
  ))
  if (phone) {
    return (
      <section class="term-ask" aria-labelledby={head}>
        <div class="term-ask-head">
          <h2 id={head}>
            <Icon name="warning" size={18} />
            승인 대기 — 키로 응답
          </h2>
          <span class="term-ask-msg">{msg}</span>
        </div>
        <div class="term-ask-grid">{keys}</div>
      </section>
    )
  }
  return (
    <section class="term-ask" aria-labelledby={head}>
      <p class="term-ask-text">
        <Icon name="warning" size={18} />
        <span>
          <b id={head} class="term-ask-title">
            승인 대기 — 키로 응답
          </b>
          <span class="term-ask-msg"> · {msg}</span>
        </span>
      </p>
      <div class="term-ask-keys">{keys}</div>
    </section>
  )
}

/** The keys a phone keyboard does not have, typed down the stream. */
function QuickKeys({ link, open }: { link: TermLink | null; open: boolean }) {
  return (
    <section class="term-keys" aria-label="빠른 키">
      {QUICK_KEYS.map((q) => (
        <button
          key={q.key}
          type="button"
          class={'term-key' + (ARROWS.has(q.key) ? ' is-arrow' : '')}
          aria-label={q.label !== q.text ? q.label : undefined}
          disabled={!open}
          onPointerDown={keep}
          onMouseDown={keep}
          onClick={() => link?.key(q.key)}
        >
          {q.text}
        </button>
      ))}
    </section>
  )
}

/** Several lines sent at once with POST send (spec §3 #124). */
function Composer({ addr, phone, id, onSent }: { addr: string; phone: boolean; id: string; onSent: () => void }) {
  const h = useHost()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [held, setHeld] = useState(false)
  const field = id + '-send'
  const apple = isApple()
  const submit = async () => {
    if (busy || text.trim() === '') return
    setBusy(true)
    setHeld(false)
    try {
      await h.api.terminals.send(addr, text)
      setText('')
      onSent()
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'blocked') setHeld(true)
      else toastError(e, '보내지 못했습니다')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="term-compose">
      {held && (
        <p class="term-held" role="alert">
          승인 대기 중 — 키로 응답
        </p>
      )}
      <form
        class="term-send"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label class="sr-only" for={field}>
          터미널에 여러 줄 보내기
        </label>
        <textarea
          id={field}
          class="input term-send-input"
          rows={phone ? 1 : 2}
          value={text}
          readOnly={busy}
          placeholder={phone ? '여러 줄로 보내기' : `여러 줄로 보내기 · ${apple ? '⌘Enter' : 'Ctrl+Enter'}`}
          aria-keyshortcuts={apple ? 'Meta+Enter' : 'Control+Enter'}
          onInput={(e) => {
            setText(e.currentTarget.value)
            setHeld(false)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return
            e.preventDefault()
            void submit()
          }}
        />
        <button type="submit" class="btn btn-primary term-send-btn" aria-label={phone ? '보내기' : undefined} disabled={busy || text.trim() === ''}>
          <Icon name="send" size={phone ? 20 : 16} stroke={2} />
          {!phone && '보내기'}
        </button>
      </form>
    </div>
  )
}

function ObserveBar({ onOff }: { onOff: () => void }) {
  return (
    <div class="term-observe" role="status">
      <Icon name="eye" size={16} />
      <span>보기 전용 — 입력과 크기 변경을 보내지 않습니다</span>
      <button type="button" class="btn btn-xs" onClick={onOff}>
        보기 전용 끄기
      </button>
    </div>
  )
}

interface EndBarProps {
  t: TerminalView | undefined
  ended: Closed | null
  onRemove: () => void
}

function EndBar({ t, ended, onRemove }: EndBarProps) {
  const h = useHost()
  const facts: EndFacts = t?.state === 'finished' ? t : (ended ?? t ?? NO_END)
  const when = t?.finished_ms != null ? ` · ${relTime(t.finished_ms, now.value)}` : ''
  return (
    <div class="term-end" role="status">
      <p class="term-end-text">
        <b>프로그램이 끝났습니다</b> · {endText(facts)}
        {when}
      </p>
      <div class="term-end-actions">
        <a class="btn btn-sm" href={h.href({ name: 'new', folder: t?.folder_id || undefined, wt: t?.worktree || undefined })}>
          <Icon name="plus" size={15} />새 세션
        </a>
        <button type="button" class="btn btn-sm btn-danger" onClick={onRemove}>
          <Icon name="trash" size={15} />
          목록에서 지우기
        </button>
      </div>
    </div>
  )
}
