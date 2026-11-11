// The terminal screen (B-PC, B-Terminal; spec §3 #123–#127, #133). The
// program's screen fills the middle; above it the title and the tools,
// under it the keys a blocked program waits for, the quick keys on a
// phone and a box that sends several lines at once. A screen scrolled back
// offers its end (#183); on a PC a key pressed outside it still types (#188).
// Open while a person looks, its finish is seen here and its notifications
// close (#190, #191). An answer names the question it is for (#194), and a
// question can be turned down with what to do instead (#195).
import type { ComponentChildren } from 'preact'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { Chip } from '../components/Chip'
import { Confirm } from '../components/Confirm'
import { ConnBanner } from '../components/ConnBanner'
import { Icon } from '../components/Icon'
import { Menu, type MenuItem } from '../components/Menu'
import { ApiError } from '../lib/api'
import type { Closed, Size } from '../lib/attach'
import { now } from '../lib/clock'
import { draftKey, loadDraft, saveDraft } from '../lib/drafts'
import { fitSize } from '../lib/fit'
import { watchFocus } from '../lib/focus'
import { appName, askText, chip, endText, place, type EndFacts } from '../lib/format'
import { useChordSubmit } from '../lib/ime'
import { isMod, NO_MODS, QUICK_KEYS, strayBytes } from '../lib/keys'
import { pickOn } from '../lib/pickpref'
import { isApple } from '../lib/platform'
import { closeNotes, noteTag } from '../lib/push'
import { navigate, parseHash } from '../lib/router'
import { nameOf, others, useHost } from '../lib/scope'
import { markSeen } from '../lib/seen'
import { DEFAULT_FONT, fontFor, termFont, type Layout } from '../lib/termfont'
import { TermLink } from '../lib/termlink'
import { attachNote, BLOCKED_KEYS, quotePath, type AnswerKey, type AttachNote } from '../lib/termview'
import { effectiveTheme, terminalTheme } from '../lib/theme'
import { isClaude, note as noteSlash } from '../lib/slash'
import { relTime } from '../lib/time'
import { toast, toastError } from '../lib/toast'
import type { TerminalView } from '../lib/types'
import { openScreen, type Screen } from '../lib/xterm'
import { gitFrom } from './Git'
import { PickHints, PickList, PickPanel, usePick } from './Pick'
import { titleOf, type Variant } from './rows'
import { useSlash } from './Slash'
import { TermFontSheet } from './TermFont'
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

/** Where a key typed with the focus there belongs to that place, not the terminal (spec §3 #188). */
const OWN_KEYS = '.xterm, [role="menu"], dialog, input, textarea, select, [contenteditable]:not([contenteditable="false"])'

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
  const root = useRef<HTMLDivElement>(null)
  const [link, setLink] = useState<TermLink | null>(null)
  const [broken, setBroken] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [killing, setKilling] = useState(false)
  const [killBusy, setKillBusy] = useState(false)
  const [drop, setDrop] = useState(false)
  const [fonting, setFonting] = useState(false)
  // The screen is scrolled back from its end, and output came since.
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState(false)
  // The page is seen and has the focus.
  const [looking, setLooking] = useState(false)
  // An answer is on its way, and the question the box below rejects.
  const [answering, setAnswering] = useState(false)
  const [rejecting, setRejecting] = useState<string | null>(null)
  const layout: Layout = phone ? 'phone' : 'pc'
  const fontPx = fontFor(layout)

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
      // a size picked later changes the open screen (below), not a new one
      fontSize: termFont.peek()[layout] ?? DEFAULT_FONT[layout],
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

  // A size picked in 설정 or the sheet redraws the open screen, and the
  // terminal follows the cells that fit now (spec §3 #185).
  useEffect(() => {
    const s = screen.current
    if (!link || !s) return
    let dead = false
    void s.setFontSize(fontPx).then((changed) => {
      if (!changed || dead) return
      // the cells are measured again once the screen has drawn with them
      requestAnimationFrame(() => {
        if (!dead) link.setFit(measure())
      })
    })
    return () => {
      dead = true
    }
  }, [link, fontPx])

  // Whether the end of the output is on screen, and whether output came
  // while it was not (spec §3 #183).
  useEffect(() => {
    const s = screen.current
    if (!link || !s) return
    const look = (wrote: boolean) => {
      const end = s.atEnd()
      setAway(!end)
      if (end) setFresh(false)
      else if (wrote) setFresh(true)
    }
    look(false)
    return s.onView(look)
  }, [link])

  useEffect(() => watchFocus(setLooking), [])
  // Each turn that ends while it is looked at is seen as it ends.
  const here = t != null
  useEffect(() => {
    const cur = h.terminals.peek().get(addr)
    if (!looking || !cur) return
    markSeen(h.id, cur)
    void closeNotes(noteTag(h.id, addr))
  }, [h, addr, looking, here, t?.turn, t?.created_ms])

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
  // What the program asks, as the server names it; "" from a Mori without it.
  const ask = blocked ? (t?.ask ?? '') : ''
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

  // Claude Code's window at the bottom of the screen, read into a panel in
  // the approval bar's place (pickers design §6.5). Its room is the stage and
  // what stands in that place now, as the panel takes its place.
  const pickSizes = () => {
    let total = stage.current?.clientHeight ?? 0
    root.current?.querySelectorAll<HTMLElement>('.term-ask, .term-pick').forEach((el) => {
      total += el.offsetHeight
    })
    return { total, cellH: screen.current?.cell()[1] ?? 0, viewH: window.innerHeight }
  }
  const pick = usePick({
    screen,
    ready: link,
    on: !!t && isClaude(t) && pickOn.value && active,
    size: size ? `${size.cols}x${size.rows}` : null,
    measure: pickSizes,
  })
  const seen = pick.seen

  // A question that went or changed takes its rejection with it.
  useEffect(() => {
    if (rejecting !== null && rejecting !== ask) setRejecting(null)
  }, [ask, rejecting])

  // On a PC a key pressed while the focus is on the page, or on one of the
  // terminal's own buttons, types into the terminal and gives it the focus
  // (spec §3 #188). A field, a menu or a dialog keeps its keys; a button
  // keeps the keys that press it or move from it.
  useEffect(() => {
    if (phone || !link || !canType) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('dialog[open]')) return
      const a = document.activeElement
      if (a && a !== document.body && a !== document.documentElement) {
        if (a.closest(OWN_KEYS) || !a.closest('.term-pc')) return
        if ([...e.key].length !== 1 || e.key === ' ') return
      }
      const bytes = strayBytes(e, screen.current?.appCursor() ?? false)
      if (bytes === null || !link.send(bytes)) return
      e.preventDefault()
      screen.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [phone, link, canType])

  const fail = (what: string) => (e: unknown) => toastError(e, what)
  // What is sent another way than the stream shows the screen's end too.
  const toEnd = () => screen.current?.scrollToBottom()
  const answer = (k: AnswerKey) => {
    // The server presses it only while the program still asks what this
    // device saw, so it does not land on the next question (spec §3 #194).
    if (ask) {
      if (answering) return
      setAnswering(true)
      h.api.terminals
        .keys(addr, [k.name], ask)
        .then(toEnd, fail('키를 보내지 못했습니다'))
        .finally(() => setAnswering(false))
      return
    }
    if (link?.send(k.bytes)) return
    h.api.terminals.keys(addr, [k.name]).catch(fail('키를 보내지 못했습니다'))
  }
  const reject = () => {
    if (rejecting !== null) {
      setRejecting(null)
      return
    }
    // in the press itself, or a phone does not open its keyboard
    document.getElementById(id + '-send')?.focus()
    setRejecting(ask)
  }
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
      {away && (
        <button
          type="button"
          class={'btn btn-sm term-jump' + (fresh ? ' btn-primary' : '')}
          onPointerDown={keep}
          onMouseDown={keep}
          onClick={(e) => {
            // a phone would open its keyboard
            e.stopPropagation()
            toEnd()
            if (!phone && canType) screen.current?.focus()
          }}
        >
          <Icon name="arrow-down" size={15} />
          {fresh ? '새 출력' : '맨 아래로'}
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

  // A choice and a hint's key are sent from the panel's next step (plan Task 6).
  const choose = () => {}
  const hint = () => {}
  const askBar = blocked && t && (
    <AskBar
      t={t}
      phone={phone}
      id={id}
      busy={answering}
      onKey={answer}
      rejecting={rejecting !== null}
      onReject={ask ? reject : undefined}
      pick={
        seen && seen.options.length > 0
          ? {
              list: (
                <div class="term-pick-body" style={{ maxHeight: `${pick.cap}px` }}>
                  <PickList seen={seen} disabled={answering || pick.stale} onChoose={choose} />
                </div>
              ),
              hints: <PickHints hints={seen.hints} disabled={answering || pick.stale} skip="esc" onHint={hint} />,
            }
          : undefined
      }
    />
  )
  // A window the program is not blocked on stands where the approval bar would.
  const pickPanel = seen && <PickPanel id={id} seen={seen} cap={pick.cap} disabled={observing || pick.stale} onChoose={choose} onHint={hint} />
  const observeBar = observing && active && <ObserveBar onOff={() => observe(false)} />
  const endBar = finished && <EndBar t={t} ended={ended} onRemove={() => void remove()} />
  const composer = canType && (
    <Composer
      key={draftKey(h.id, addr)}
      addr={addr}
      phone={phone}
      id={id}
      onSent={toEnd}
      ask={ask}
      rejecting={rejecting}
      onReject={setRejecting}
      claude={!!t && isClaude(t)}
    />
  )

  if (!phone) {
    return (
      <div ref={root} class="term term-pc">
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
        {askBar || pickPanel}
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
    items.push({ label: '글자 크기', icon: 'text-size', onSelect: () => setFonting(true) })
    items.push({ label: '종료', icon: 'power', danger: true, onSelect: () => setKilling(true) })
  } else {
    if (t) items.push({ label: '이름 바꾸기', icon: 'pencil', onSelect: () => setRenaming(true) })
    items.push({ label: '글자 크기', icon: 'text-size', onSelect: () => setFonting(true) })
    if (finished) items.push({ label: '목록에서 지우기', icon: 'trash', danger: true, onSelect: () => void remove() })
  }

  return (
    <div ref={root} class="term term-phone">
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
          {askBar || pickPanel}
          {observeBar}
          {endBar}
          {canType && <QuickKeys link={link} open={open} />}
          {composer}
        </div>
      </div>
      {fileInput}
      {confirm}
      <TermFontSheet open={fonting} layout="phone" onClose={() => setFonting(false)} />
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
  /** An answer is on its way: the keys wait for it. */
  busy: boolean
  onKey: (k: AnswerKey) => void
  /** The box below writes what to do instead of this question. */
  rejecting: boolean
  /** Starts or stops that; without it the question cannot be named (spec §3 #195). */
  onReject?: () => void
  /**
   * The window's own list and keys, read from the screen, in place of the
   * number keys and Enter (pickers design §6.5). Esc stays, as does turning
   * the question down: neither needs the list read right.
   */
  pick?: { list: ComponentChildren; hints: ComponentChildren }
}

/** What a blocked program asks, and the keys that answer it. */
function AskBar({ t, phone, id, busy, onKey, rejecting, onReject, pick }: AskBarProps) {
  const head = id + '-ask'
  const label = pick ? '승인 대기 — 골라서 응답' : '승인 대기 — 키로 응답'
  const msg = askText(t, 'blocked')
  const more = useMore(msg)
  const named = BLOCKED_KEYS[phone ? 'phone' : 'pc'].filter((k) => !pick || k.name === 'esc')
  const keys = named.map((k) => (
    <button
      key={k.name}
      type="button"
      class={'term-ask-key' + (k.label.length > 1 ? ' is-word' : '')}
      disabled={busy}
      onPointerDown={keep}
      onMouseDown={keep}
      onClick={() => onKey(k)}
    >
      {k.label}
    </button>
  ))
  if (onReject) {
    keys.push(
      <button key="reject" type="button" class="term-ask-reject" aria-pressed={rejecting} disabled={busy} onClick={onReject}>
        <Icon name="pencil" size={phone ? 17 : 15} />
        거절하고 지시
      </button>,
    )
  }
  if (phone) {
    const text = id + '-ask-msg'
    return (
      <section class="term-ask" aria-labelledby={head}>
        <div class="term-ask-head">
          <div class="term-ask-top">
            <h2 id={head}>
              <Icon name="warning" size={18} />
              {label}
            </h2>
            {(more.long || more.open) && (
              <button
                type="button"
                class="term-ask-more"
                aria-expanded={more.open}
                aria-controls={text}
                onPointerDown={keep}
                onMouseDown={keep}
                onClick={() => more.setOpen(!more.open)}
              >
                {more.open ? '접기' : '전체 보기'}
              </button>
            )}
          </div>
          <p ref={more.ref} id={text} class={'term-ask-msg' + (more.open ? ' is-open' : '')}>
            {msg}
          </p>
        </div>
        {pick?.list}
        <div class="term-ask-grid">{keys}</div>
        {pick?.hints}
      </section>
    )
  }
  return (
    <section class="term-ask" aria-labelledby={head}>
      <p class="term-ask-text">
        <Icon name="warning" size={18} />
        <span>
          <b id={head} class="term-ask-title">
            {label}
          </b>
          <span class="term-ask-msg"> · {msg}</span>
        </span>
      </p>
      {pick?.list}
      <div class="term-ask-keys">
        {keys}
        {pick?.hints}
      </div>
    </section>
  )
}

/**
 * A phone's message from a blocked program shows two lines until it is
 * opened (spec §3 #184): long, when it has more than that.
 */
function useMore(msg: string) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  // a new question starts closed
  useEffect(() => setOpen(false), [msg])
  useEffect(() => {
    const el = ref.current
    if (!el || open) return
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [msg, open])
  return { ref, open, long, setOpen }
}

/**
 * The keys a phone keyboard does not have, typed down the stream. Ctrl and
 * Alt hold for the next key, or stay on when tapped twice (spec §3 #186).
 */
function QuickKeys({ link, open }: { link: TermLink | null; open: boolean }) {
  const mods = link?.mods.value ?? NO_MODS
  return (
    <section class="term-keys" aria-label="빠른 키">
      {QUICK_KEYS.map((q) => {
        const k = q.key
        if (isMod(k)) {
          const m = mods[k]
          return (
            <button
              key={k}
              type="button"
              class="term-key is-mod"
              aria-label={m === 'lock' ? `${q.label} 고정` : undefined}
              aria-pressed={m !== 'off'}
              data-lock={m === 'lock' ? '' : undefined}
              disabled={!open}
              onPointerDown={keep}
              onMouseDown={keep}
              onClick={() => link?.tapMod(k)}
            >
              {q.text}
            </button>
          )
        }
        return (
          <button
            key={k}
            type="button"
            class={'term-key' + (ARROWS.has(k) ? ' is-arrow' : '')}
            aria-label={q.label !== q.text ? q.label : undefined}
            disabled={!open}
            onPointerDown={keep}
            onMouseDown={keep}
            onClick={() => link?.key(k)}
          >
            {q.text}
          </button>
        )
      })}
    </section>
  )
}

interface ComposerProps {
  addr: string
  phone: boolean
  id: string
  onSent: () => void
  /** What the program asks, "" for nothing or a Mori that does not name it. */
  ask: string
  /** The question this box rejects: what it sends goes instead (spec §3 #195). */
  rejecting: string | null
  onReject: (ask: string | null) => void
  /** It runs Claude Code: a "/" at the start lists its commands (spec §3 #197). */
  claude: boolean
}

/**
 * Several lines sent at once with POST send (spec §3 #124). What is typed
 * stays as this device's draft until it is sent (spec §3 #181). Rejecting a
 * question, it presses Esc first and sends once the question is gone.
 */
function Composer({ addr, phone, id, onSent, ask, rejecting, onReject, claude }: ComposerProps) {
  const h = useHost()
  const draft = draftKey(h.id, addr)
  const [text, setText] = useState(() => loadDraft(draft))
  const [busy, setBusy] = useState(false)
  const [held, setHeld] = useState(false)
  const [caret, setCaret] = useState<number | null>(null) // null: the box does not have the focus
  const box = useRef<HTMLTextAreaElement>(null)
  const moveTo = useRef<number | null>(null)
  const field = id + '-send'
  const apple = isApple()
  const edit = (v: string) => {
    setText(v)
    saveDraft(draft, v)
  }
  const track = (e: Event) => setCaret((e.currentTarget as HTMLTextAreaElement).selectionStart)
  const slash = useSlash({
    on: claude,
    text,
    caret,
    host: h.id,
    addr,
    api: h.api,
    id: id + '-slash',
    apply: (v, at) => {
      edit(v)
      setHeld(false)
      setCaret(at)
      moveTo.current = at
    },
  })
  // the caret a choice in the list puts after "/name ", once the box has the text
  useLayoutEffect(() => {
    if (moveTo.current === null || !box.current) return
    box.current.setSelectionRange(moveTo.current, moveTo.current)
    moveTo.current = null
  })
  const submit = async (value: string, against: string | null) => {
    if (busy || value.trim() === '') return
    setBusy(true)
    setHeld(false)
    try {
      if (against) await h.api.terminals.reject(addr, value, against)
      else await h.api.terminals.send(addr, value)
      if (claude) noteSlash(value)
      edit('')
      onReject(null)
      onSent()
    } catch (e) {
      if (!against && e instanceof ApiError && e.kind === 'blocked') setHeld(true)
      else toastError(e, against ? '거절하고 보내지 못했습니다' : '보내지 못했습니다')
    } finally {
      setBusy(false)
    }
  }
  const chord = useChordSubmit((f) => void submit(f.value, rejecting))
  const sendLabel = rejecting ? '거절하고 보내기' : '보내기'
  return (
    <div class="term-compose">
      {slash.view}
      {rejecting && (
        <div class="term-reject" role="status" aria-labelledby={field + '-reject'}>
          <Icon name="pencil" size={15} />
          <span id={field + '-reject'}>거절하고 지시 — Esc를 누른 뒤 이 글을 보냅니다</span>
          <button type="button" class="btn btn-xs" onClick={() => onReject(null)}>
            취소
          </button>
        </div>
      )}
      {held && (
        <div class="term-held" role="alert">
          <span>승인 대기 중 — 키로 응답</span>
          {ask && (
            <button type="button" class="btn btn-xs" disabled={busy} onClick={() => void submit(text, ask)}>
              거절하고 이 글 보내기
            </button>
          )}
        </div>
      )}
      <form
        class="term-send"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(text, rejecting)
        }}
      >
        <label class="sr-only" for={field}>
          {rejecting ? '거절하고 대신 보낼 글' : '터미널에 여러 줄 보내기'}
        </label>
        <textarea
          ref={box}
          id={field}
          class="input term-send-input"
          data-draft=""
          rows={phone ? 1 : 2}
          value={text}
          readOnly={busy}
          {...slash.aria}
          placeholder={
            rejecting ? '대신 할 일을 적으세요' : phone ? '여러 줄로 보내기' : `여러 줄로 보내기 · ${apple ? '⌘Enter' : 'Ctrl+Enter'}`
          }
          aria-keyshortcuts={apple ? 'Meta+Enter' : 'Control+Enter'}
          onInput={(e) => {
            edit(e.currentTarget.value)
            setHeld(false)
            track(e)
          }}
          onFocus={track}
          onBlur={() => setCaret(null)}
          onClick={track}
          onKeyUp={track}
          onSelect={track}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return
            if (rejecting && e.key === 'Escape' && !e.isComposing) {
              e.preventDefault()
              onReject(null)
              return
            }
            chord.onKeyDown(e)
          }}
          onCompositionEnd={chord.onCompositionEnd}
        />
        <button
          type="submit"
          class="btn btn-primary term-send-btn"
          aria-label={phone ? sendLabel : undefined}
          disabled={busy || text.trim() === ''}
        >
          <Icon name="send" size={phone ? 20 : 16} stroke={2} />
          {!phone && sendLabel}
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
