// The terminal screen (B-PC, B-Terminal; spec §3 #123–#127, #133). The
// program's screen fills the middle; above it the title and the tools,
// under it the keys a blocked program waits for, the quick keys on a
// phone and a box that sends several lines at once. A screen scrolled back
// offers its end (#183); on a PC a key pressed outside it still types (#188).
// Open while a person looks, its finish is seen here and its notifications
// close (#190, #191). An answer names the question it is for (#194), and a
// question can be turned down with what to do instead (#195).
import type { ComponentChildren } from 'preact'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Chip } from '../components/Chip'
import { Confirm } from '../components/Confirm'
import { ConnBanner } from '../components/ConnBanner'
import { Icon } from '../components/Icon'
import { Menu, type MenuItem } from '../components/Menu'
import { announce } from '../lib/announce'
import { ApiError } from '../lib/api'
import type { Closed, Size } from '../lib/attach'
import { now } from '../lib/clock'
import { copyText } from '../lib/copy'
import { draftKey, loadDraft, saveDraft } from '../lib/drafts'
import { fitSize } from '../lib/fit'
import { watchFocus } from '../lib/focus'
import { appName, askText, chip, endText, place, type EndFacts } from '../lib/format'
import type { Hint } from '../lib/hints'
import { alike } from '../lib/pick'
import { useChordSubmit } from '../lib/ime'
import { isMod, namedBytes, NO_MODS, QUICK_KEYS, strayBytes } from '../lib/keys'
import { choose as chooseItem, closeFor, tap, type Press } from '../lib/pickpress'
import { boxShown, setBoxShown } from '../lib/coverpref'
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
import { Recall, rememberSent, sentHere } from '../lib/recall'
import { isClaude, note as noteSlash } from '../lib/slash'
import { relTime } from '../lib/time'
import { toast, toastError } from '../lib/toast'
import type { TerminalView } from '../lib/types'
import { openScreen, type Screen } from '../lib/xterm'
import { gitFrom } from './Git'
import { ModeButton, StatusBand, useBox } from './Cover'
import { PickHints, PickKept, PickList, PickPanel, usePick } from './Pick'
import type { Mode } from '../lib/box'
import { titleOf, type Variant } from './rows'
import { useSlash } from './Slash'
import { TermFontSheet } from './TermFont'
import './terminal.css'

/** The box settles before the terminal follows it, as when a keyboard slides in. */
const FIT_DELAY = 120
/** How long the sizes differ before 이 화면에 맞추기 is offered. */
const FIT_LATE = 600
const MAX_UPLOAD = 8 << 20

/** A key that goes from the box or the panel to a window (pickers design §14 #45). */
type PickKey = 'up' | 'down' | 'enter'
const ENTER: Hint = { label: '', key: 'enter', move: false }
const PICK_KEYS: Record<string, PickKey> = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter' }

const two = (n: number) => String(n).padStart(2, '0')
/**
 * The name a pasted image goes up under: a clipboard calls every image
 * image.png, and the core would number them (image-2.png); the time says
 * which paste it was.
 */
export function pasteName(f: File, at: Date, i: number): string {
  if (!f.type.startsWith('image/')) return f.name
  const ext = f.type === 'image/jpeg' ? 'jpg' : (f.type.slice(6).replace(/\W.*$/, '') || 'png')
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
  return `paste-${stamp}${i ? `-${i + 1}` : ''}.${ext}`
}
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

  // Claude Code's window at the bottom of the screen, read into a panel
  // laid over the terminal (pickers design §6.5, §14 #44), or into the
  // approval bar under it. The panel's room is the stage. The bar's is the
  // stage, less the scroll box's padding, where no cells go (measure), and
  // the bar, as it takes its rows from the terminal. Of either, the title
  // and keys take what the list leaves.
  const pickSizes = () => {
    const sc = scroll.current
    const cs = sc && getComputedStyle(sc)
    const px = (v: string | undefined) => parseFloat(v ?? '') || 0
    const whole = stage.current?.clientHeight ?? 0
    let total = whole - px(cs?.paddingTop) - px(cs?.paddingBottom)
    let chrome = 0
    root.current?.querySelectorAll<HTMLElement>('.term-ask, .term-pick').forEach((el) => {
      if (el.classList.contains('term-ask')) total += el.offsetHeight
      chrome += el.offsetHeight - (el.querySelector<HTMLElement>('.term-pick-body')?.offsetHeight ?? 0)
    })
    return { total, stage: whole, cellH: screen.current?.cell()[1] ?? 0, viewH: window.innerHeight, chrome }
  }
  const pick = usePick({
    screen,
    ready: link,
    on: !!t && isClaude(t) && pickOn.value && active,
    size: size ? `${size.cols}x${size.rows}` : null,
    place: blocked,
    over: !blocked,
    measure: pickSizes,
  })
  const seen = pick.seen
  // A blocked list Claude Code drew cut short stays out of the bar for the
  // rest of its question: the bar's rows would make it draw whole, then cut
  // again (design §14 #44).
  const [cutAsk, setCutAsk] = useState<string | null>(null)
  useEffect(() => {
    if (blocked && seen?.partial && cutAsk !== ask) setCutAsk(ask)
  }, [blocked, seen, ask, cutAsk])

  // Claude Code's input box and what is below it lie under Mori's status
  // band (claude-input design §3, spec §3 #217, #223): while it is empty,
  // this device sees the end at the terminal's own size, and is not only
  // watching. While the box sends, its text shows in the terminal's box for
  // a moment: the cover stays as it was.
  const claudeOn = !!t && isClaude(t) && pickOn.value && active
  const reading = useBox({ screen, ready: link, on: claudeOn })
  const sameSize = !fit || !size || (fit.cols === size.cols && fit.rows === size.rows)
  const [sending, setSending] = useState(false)
  const rb = reading.box
  const boxable = !!rb && !boxShown.value && canType && sameSize && reading.alternate
  const coverNow = boxable && reading.end && reading.row >= 0 && rb.text === ''
  const coverWas = useRef(false)
  if (!sending) coverWas.current = coverNow
  const covered = coverWas.current && !!rb && !seen
  const coverRef = useRef(covered)
  coverRef.current = covered
  const focusRef = useRef(() => {})
  // the box's own insertion, for a path uploaded while the cover is up
  const pathTo = useRef<((text: string) => void) | null>(null)
  // text in the terminal's box: what the next send would follow
  const boxNote = boxable && rb.text !== '' && !sending
  useEffect(() => {
    if (boxNote) announce(BOX_NOTE)
  }, [boxNote])
  // a new mode is read out once
  const modeSaid = useRef<string | null>(null)
  useEffect(() => {
    const label = reading.mode?.label ?? null
    if (label !== null && modeSaid.current !== null && label !== modeSaid.current) announce(`모드: ${label}`)
    if (label !== null) modeSaid.current = label
  }, [reading.mode?.label])
  const coverTop = () => {
    const sc = scroll.current
    const pad = sc ? parseFloat(getComputedStyle(sc).paddingTop) || 0 : 0
    return pad + reading.row * (screen.current?.cell()[1] ?? 0)
  }

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
      // With the cover a letter goes to the box, and nothing else to the terminal (claude-input design §4.1)
      if (coverRef.current) {
        if ([...e.key].length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) focusRef.current()
        return
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
        // The path goes where the cursor is; a person sees it typed. With the cover, into the box.
        if (covered && pathTo.current) pathTo.current(quotePath(r.path))
        else if (!link?.send(quotePath(r.path) + ' ')) toast(`올렸습니다: ${r.path}`)
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

  // A window's panel lies over the bottom of the terminal, which keeps its
  // size (pickers design §14 #44).
  const stageWith = (over: ComponentChildren) => (
    <div
      ref={stage}
      class={'term-stage' + (drop ? ' is-drop' : '')}
      onClick={() => {
        // with the cover a PC gives the box the focus, and a phone nothing: its keyboard would shrink the terminal
        if (covered) {
          if (!phone) focusBox()
          return
        }
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
      {over}
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

  // A press on the window's list or its hint keys (pickers design §6.5).
  // While the server names the question, every key goes through it, in
  // order: the keys that answer carry expect, the keys that move do not
  // (spec §3 #194). Otherwise they go down the stream, as typing does.
  const sendKeys = async (names: string[], final: boolean) => {
    if (ask) {
      await h.api.terminals.keys(addr, names, final ? ask : undefined)
      return
    }
    const app = screen.current?.appCursor() ?? false
    const bytes = names.map((n) => namedBytes(n, app))
    if (bytes.every((b) => b !== null) && link?.send(bytes.join(''))) return
    await h.api.terminals.keys(addr, names)
  }
  const press: Press = {
    now: pick.now,
    wait: pick.wait,
    move: (names) => sendKeys(names, false),
    answer: (name) => sendKeys([name], true),
  }
  // One press at a time, as with the approval bar's keys.
  const run = (go: () => Promise<boolean>) => {
    if (answering) return
    setAnswering(true)
    go()
      .then((ok) => {
        if (!ok) toast('목록이 바뀌어 고르지 않았습니다', 'error')
      }, fail('키를 보내지 못했습니다'))
      .finally(() => {
        setAnswering(false)
        toEnd()
      })
  }
  const choose = (n: number) => {
    if (seen) run(() => chooseItem(press, seen, n, blocked))
  }
  // k, not h: h is the host
  const hint = (k: Hint) => {
    if (!seen) return
    if (!k.copy) {
      run(() => tap(press, seen, k))
      return
    }
    // Mori copies what the window shows at the press, read off the screen (design §6.7).
    const l = pick.now()
    const body = l.seen?.id === seen.id ? l.seen.body : null
    if (body === null) {
      toast('복사하지 못했습니다', 'error')
      return
    }
    void copyText(body).then((ok) => {
      if (ok) toast('화면에 보이는 부분만 복사했습니다')
      else toast('복사하지 못했습니다', 'error')
    })
  }
  // ↑, ↓ and Enter from an empty box, or ↑ and ↓ from the panel, go to a
  // window the program is not blocked on, as on the terminal; the panel
  // follows its cursor (pickers design §14 #45). A blocked window is answered
  // by the approval bar: an Enter in an empty box would approve it.
  const moved = useRef(false)
  const pickKey = (k: PickKey): boolean => {
    if (!seen || blocked || observing || pick.stale) return false
    // a press is on its way: the key waits for nothing, and goes nowhere else
    if (answering) return true
    const l = pick.now().seen
    if (!l || !alike(l, seen)) return false
    if (k === 'enter') {
      run(() => tap(press, l, ENTER))
      return true
    }
    moved.current = true
    press.move([k]).catch(fail('키를 보내지 못했습니다'))
    return true
  }
  // the item a key moved the cursor to is read out
  useEffect(() => {
    if (!moved.current || !seen?.cursor) return
    moved.current = false
    const o = seen.options.find((x) => x.n === seen.cursor)
    if (o) announce(`${o.n}. ${o.label}`)
  }, [seen?.cursor])
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
        // a list the terminal cannot spare the room for, or drew cut short, is left there: the bar answers by its own keys
        seen && seen.options.length > 0 && pick.cap > 0 && !seen.partial && cutAsk !== ask
          ? {
              list: (
                <div class="term-pick-body" style={{ maxHeight: `${pick.cap}px` }}>
                  <PickList seen={seen} blocked={blocked} disabled={answering || pick.stale} onChoose={choose} />
                </div>
              ),
              hints: <PickHints hints={seen.hints} disabled={answering || pick.stale} skip="esc" onHint={hint} />,
            }
          : undefined
      }
    />
  )
  // A window the program is not blocked on lies over the terminal; where its
  // list cannot show, or the terminal drew it cut short, the terminal keeps it.
  const pickPanel =
    seen &&
    (pick.cap < 0 || seen.partial ? (
      <PickKept seen={seen} />
    ) : (
      <PickPanel
        id={id}
        seen={seen}
        cap={pick.cap}
        disabled={observing || pick.stale || answering}
        onChoose={choose}
        onHint={hint}
        onKey={pickKey}
      />
    ))
  // the window a send closes first: the panel's, or one its own cut keeps out of it
  // Shift+Tab moves Claude Code to its next mode (claude-input design §3.3)
  const nextMode = () => {
    sendKeys(['shift+tab'], false).catch(fail('키를 보내지 못했습니다'))
  }
  const focusBox = () => document.getElementById(id + '-send')?.focus()
  focusRef.current = focusBox
  // On a phone a touch on the covered terminal brings up no keyboard (claude-input design §4.1)
  useEffect(() => {
    screen.current?.setKeyboard(!(covered && phone))
  }, [covered, phone, link])
  // On a PC the box takes the focus as the cover comes, from the page or the terminal
  useEffect(() => {
    if (!covered || phone) return
    const a = document.activeElement
    if (!a || a === document.body || a === document.documentElement || a.closest('.xterm')) focusBox()
  }, [covered, phone])
  // An empty box's Esc and Ctrl+letter, but Ctrl+V, go to the terminal as from its own box (spec §3 #217)
  const termKey = (e: KeyboardEvent): boolean => {
    let name: string | null = null
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) name = 'esc'
    else if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && /^[a-z]$/i.test(e.key) && e.key.toLowerCase() !== 'v') name = `ctrl+${e.key.toLowerCase()}`
    if (!name) return false
    // On Windows and Linux Ctrl+C copies the terminal's selection, as from xterm itself (lib/xterm.ts)
    if (name === 'ctrl+c' && !isApple()) {
      const sel = screen.current?.takeSelection() ?? ''
      if (sel) {
        void copyText(sel)
        return true
      }
    }
    const b = namedBytes(name, screen.current?.appCursor() ?? false)
    return b !== null && !!link?.send(b)
  }
  const band = covered && rb && (
    <StatusBand box={rb} top={coverTop()} phone={phone} mode={reading.mode} onMode={nextMode} onFocus={() => !phone && focusBox()} />
  )
  const toClose = seen ?? pick.held
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
      closeFirst={toClose && !blocked ? () => closeFor(press, toClose) : undefined}
      onPickKey={seen && !blocked ? pickKey : undefined}
      mode={!phone && claudeOn ? reading.mode : null}
      modeOff={!!seen || blocked}
      onMode={nextMode}
      boxNote={boxNote}
      onSending={setSending}
      onTermKey={covered && !phone ? termKey : undefined}
      bind={pathTo}
      hint={claudeOn && rb && rb.text === '' ? rb.hint : ''}
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
            {claudeOn && (
              <button type="button" class="btn btn-sm" aria-pressed={boxShown.value} onClick={() => setBoxShown(!boxShown.value)}>
                <Icon name="monitor" size={15} />
                터미널 입력칸 보기
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
        {stageWith(
          <>
            {!askBar && pickPanel}
            {band}
          </>,
        )}
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
    if (claudeOn) items.push({ label: '터미널 입력칸 보기', icon: 'monitor', checked: boxShown.value, onSelect: () => setBoxShown(!boxShown.value) })
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
        {stageWith(
          <>
            {!askBar && pickPanel}
            {band}
          </>,
        )}
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
        <div class={'term-ask-grid' + (pick ? ' is-pick' : '')}>{keys}</div>
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
  /**
   * A window Mori knows shows, and the program is not blocked on it: Esc
   * closes it first, and the text goes once the input box shows. False when
   * the window stays (pickers design §6.8, spec §3 #214).
   */
  closeFirst?: () => Promise<boolean>
  /** A window shows: ↑, ↓ and Enter in an empty box go to it; true when one went (pickers design §14 #45). */
  onPickKey?: (k: PickKey) => boolean
  /** Claude Code's mode, on a PC: a button of the box's row sends Shift+Tab (claude-input design §3.3). */
  mode?: Mode | null
  onMode?: () => void
  /** A window or a question shows: Shift+Tab would land in it (in an edit permission, it allows every edit). */
  modeOff?: boolean
  /** The terminal's own box holds text: the next send follows it (claude-input design §3.2). */
  boxNote?: boolean
  /** Hears when the box sends and stops. */
  onSending?: (busy: boolean) => void
  /** With the cover on a PC: an empty box's Esc and Ctrl+letter go to the terminal; true when one went. */
  onTermKey?: (e: KeyboardEvent) => boolean
  /** Takes the box's insertion of text where the caret is, for paths uploaded with the cover up. */
  bind?: { current: ((text: string) => void) | null }
  /** The grey hint of the terminal's empty box: the box's placeholder, and Tab takes it (claude-input design §6). */
  hint?: string
}

/** What the box says when the terminal's own box holds text (claude-input design §3.2). */
const BOX_NOTE = '터미널 입력칸에 글이 있습니다 — 보내면 그 뒤에 이어 붙습니다'

/** What the box says when the window would not close, and nothing went. */
const STUCK = '창이 닫히지 않아 보내지 않았습니다'

/**
 * Several lines sent at once with POST send (spec §3 #124). What is typed
 * stays as this device's draft until it is sent (spec §3 #181). Rejecting a
 * question, it presses Esc first and sends once the question is gone; over a
 * window Mori knows, it closes the window first in the same way (design §6.8).
 */
function Composer({
  addr,
  phone,
  id,
  onSent,
  ask,
  rejecting,
  onReject,
  claude,
  closeFirst,
  onPickKey,
  mode,
  onMode,
  modeOff,
  boxNote,
  onSending,
  onTermKey,
  bind,
  hint,
}: ComposerProps) {
  const h = useHost()
  const draft = draftKey(h.id, addr)
  const [text, setText] = useState(() => loadDraft(draft))
  const [busy, setBusy] = useState(false)
  useEffect(() => onSending?.(busy), [busy])
  const [held, setHeld] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [caret, setCaret] = useState<number | null>(null) // null: the box does not have the focus
  const [pasting, setPasting] = useState(0)
  const box = useRef<HTMLTextAreaElement>(null)
  const latest = useRef(text)
  latest.current = text
  const moveTo = useRef<number | null>(null)
  const field = id + '-send'
  const apple = isApple()
  const edit = (v: string) => {
    setText(v)
    saveDraft(draft, v)
  }
  const track = (e: Event) => setCaret((e.currentTarget as HTMLTextAreaElement).selectionStart)
  const slash = useSlash({
    // shut while the box sends: its text went already, and its keys go to a window it may have opened
    on: claude && !busy,
    text,
    caret,
    host: h.id,
    addr,
    api: h.api,
    id: id + '-slash',
    apply: (v, at) => {
      edit(v)
      setHeld(false)
      setStuck(false)
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
  // the window went: what the note says is over
  const closing = !!closeFirst
  useEffect(() => {
    if (!closing) setStuck(false)
  }, [closing])
  const submit = async (value: string, against: string | null) => {
    if (busy || value.trim() === '') return
    setBusy(true)
    setHeld(false)
    setStuck(false)
    try {
      // the text would land in the window: Esc, and nothing goes while it stays
      if (!against && closeFirst && !(await closeFirst())) {
        setStuck(true)
        announce(STUCK, 'assertive')
        return
      }
      if (against) await h.api.terminals.reject(addr, value, against)
      else await h.api.terminals.send(addr, value)
      if (claude) noteSlash(value)
      rememberSent(h.id, addr, value)
      recall.refresh()
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
  // Text put in at, over to end, as a word: a space before it if the text
  // before has none, and one after it.
  const insert = (text: string, at: number, end: number) => {
    const cur = latest.current
    const a = Math.min(at, cur.length)
    const before = cur.slice(0, a)
    const after = cur.slice(Math.min(end, cur.length))
    const lead = before && !/\s$/.test(before) ? ' ' : ''
    const put = lead + text + ' '
    edit(before + put + after.replace(/^ /, ''))
    setHeld(false)
    setStuck(false)
    moveTo.current = a + put.length
    setCaret(a + put.length)
  }
  if (bind) {
    bind.current = (text) => {
      const el = box.current
      const n = latest.current.length
      insert(text, el?.selectionStart ?? n, el?.selectionEnd ?? n)
    }
  }
  // An image pasted into the box goes up beside the terminal, and its path
  // goes where the caret was, for Claude Code to read (spec §3 #220). A paste
  // with text is the text's: a spreadsheet's cells come with a picture too.
  // ↑ and ↓ call back what was sent in the folder: Claude Code's record, or
  // else what this device sent (claude-input design §5.2, spec §3 #224)
  const recall = useMemo(
    () =>
      new Recall(async () => {
        if (claude) {
          try {
            const r = await h.api.terminals.prompts(addr)
            if (r.source === 'claude' && r.prompts.length) return r.prompts.map((p) => p.text)
          } catch {
            // what this device sent stands in
          }
        }
        return sentHere(h.id, addr)
      }),
    [h, addr, claude],
  )
  const recalled = (v: string) => {
    edit(v)
    setHeld(false)
    setStuck(false)
    moveTo.current = v.length
    setCaret(v.length)
    // the empty box come back to says nothing
    if (v) announce(v)
  }
  const paste = (e: ClipboardEvent) => {
    const cd = e.clipboardData
    const files = Array.from(cd?.files ?? [])
    if (!files.length || cd?.getData('text/plain')) return
    e.preventDefault()
    const el = e.currentTarget as HTMLTextAreaElement
    const at = el.selectionStart
    const end = el.selectionEnd
    const when = new Date()
    setPasting((n) => n + 1)
    void (async () => {
      const paths: string[] = []
      for (const [i, f] of files.entries()) {
        if (f.size > MAX_UPLOAD) {
          toast(`${f.name}: 8 MB를 넘는 파일은 올릴 수 없습니다`, 'error')
          continue
        }
        try {
          const r = await h.api.terminals.upload(addr, new File([f], pasteName(f, when, i), { type: f.type }))
          paths.push(quotePath(r.path))
        } catch (err) {
          toastError(err, '이미지를 올리지 못했습니다')
        }
      }
      setPasting((n) => n - 1)
      if (paths.length) insert(paths.join(' '), at, end)
    })()
  }
  const sendLabel = rejecting ? '거절하고 보내기' : closeFirst ? '닫고 보내기' : '보내기'
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
      {stuck && <p class="term-held">{STUCK}</p>}
      {boxNote && <p class="term-held term-boxnote">{BOX_NOTE}</p>}
      <form
        class="term-send"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(text, rejecting)
        }}
      >
        {mode && onMode && <ModeButton mode={mode} onPress={onMode} class="btn term-mode" disabled={modeOff} />}
        <label class="sr-only" for={field}>
          {rejecting ? '거절하고 대신 보낼 글' : '터미널에 여러 줄 보내기'}
        </label>
        <textarea
          ref={box}
          id={field}
          class="input term-send-input"
          data-draft=""
          rows={1}
          value={text}
          readOnly={busy}
          {...slash.aria}
          placeholder={
            rejecting
              ? '대신 할 일을 적으세요'
              : hint
                ? `${hint} · Tab`
                : phone
                  ? '여러 줄로 보내기'
                  : `여러 줄로 보내기 · ${apple ? '⌘Enter' : 'Ctrl+Enter'}`
          }
          aria-keyshortcuts={apple ? 'Meta+Enter' : 'Control+Enter'}
          onInput={(e) => {
            edit(e.currentTarget.value)
            recall.reset()
            setHeld(false)
            setStuck(false)
            track(e)
          }}
          onFocus={track}
          onBlur={() => setCaret(null)}
          onClick={track}
          onKeyUp={track}
          onSelect={track}
          onPaste={paste}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return
            if (rejecting && e.key === 'Escape' && !e.isComposing) {
              e.preventDefault()
              onReject(null)
              return
            }
            // An empty box, or one still sending: its text went to the terminal
            // already, and the core answers once it has watched for a turn, some
            // 5s for a command that starts none (/model)
            const k = PICK_KEYS[e.key]
            const free = text === '' || busy
            if (k && onPickKey && free && !e.isComposing && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && onPickKey(k)) {
              e.preventDefault()
              return
            }
            if (onTermKey && text === '' && !e.isComposing && onTermKey(e)) {
              e.preventDefault()
              return
            }
            // Tab in an empty box takes the terminal's hint (claude-input design §6)
            if (e.key === 'Tab' && hint && text === '' && !busy && !e.isComposing && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault()
              recalled(hint)
              return
            }
            // ↑ on the first line calls back an older send; ↓ on the last, while walking, a newer one
            if (!busy && !e.isComposing && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
              const el = e.currentTarget as HTMLTextAreaElement
              const c = el.selectionStart
              const flat = c === el.selectionEnd
              if (e.key === 'ArrowUp' && flat && !el.value.slice(0, c).includes('\n')) {
                e.preventDefault()
                void recall.older(el.value).then((v) => {
                  if (v !== null) recalled(v)
                })
                return
              }
              if (e.key === 'ArrowDown' && recall.browsing && flat && !el.value.slice(c).includes('\n')) {
                e.preventDefault()
                const v = recall.newer()
                if (v !== null) recalled(v)
                return
              }
            }
            chord.onKeyDown(e)
          }}
          onCompositionEnd={chord.onCompositionEnd}
        />
        <button
          type="submit"
          class="btn btn-primary term-send-btn"
          aria-label={phone ? sendLabel : undefined}
          disabled={busy || pasting > 0 || text.trim() === ''}
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
