// The panel of a Claude Code window (pickers design §6.4, §6.5): the
// numbered list and the hint line's keys as buttons, laid over the bottom of
// the terminal, which keeps its size (§14 #44), or in the approval bar. It reads the screen, never the bytes, and sends
// nothing itself: a choice and a key go to the hooks of the terminal view.
// The list is astryx's List and Item in Mori's joined rows (.qrows); the
// keys are secondary buttons.

import type { JSX } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../components/Icon'
import { announce } from '../lib/announce'
import type { Hint } from '../lib/hints'
import { DEPTH, look, NOTHING, type Look, type Option, type Seen } from '../lib/pick'
import { capOf, MIN_CAP, next, NO_PANEL, overCap, restart, SETTLE_MS, type Panel } from '../lib/pickpanel'
import { reach } from '../lib/pickpress'
import type { Screen } from '../lib/xterm'
import './lists.css'

/** Keeps the focus where it is, in the box below or the keyboard on a phone. */
const keep = (e: Event) => e.preventDefault()

export interface PickOptions {
  /** The terminal's screen, once it is open. */
  screen: { current: Screen | null }
  /** Changes when there is a screen to read: the link that draws it. */
  ready: unknown
  /** The windows are read: a Claude Code terminal, the setting on, not ended. */
  on: boolean
  /** Changes with the terminal's size. */
  size: unknown
  /** Changes when the window moves between its panel and the approval bar, whose own parts differ. */
  place: unknown
  /** The window's panel lies over the terminal, which keeps its size; the approval bar takes its rows. */
  over: boolean
  /**
   * The heights the list's cap comes from, in px: total is the terminal's and
   * the bar's, stage the stage the panel lies over, and chrome the panel's or
   * the bar's own, its list left out.
   */
  measure: () => { total: number; stage: number; cellH: number; viewH: number; chrome: number }
}

export interface PickState {
  seen: Seen | null
  /** The window went a moment ago: its panel stays, with its buttons off. */
  stale: boolean
  /** A window held out of the panel until the input box shows; the terminal may still show it. */
  held: Seen | null
  /**
   * The height the list may take, in px; 0 leaves the list out, as the
   * terminal cannot spare its room; under 0 (NO_ROOM), no panel shows, as its
   * title and keys alone would cut the window.
   */
  cap: number
  /** What the bottom of the screen shows now. */
  now(): Look
  /** The first look that passes test, from now on; null after ms. */
  wait(test: (l: Look) => boolean, ms: number): Promise<Look | null>
}

/** Reads the window at the bottom of the terminal as the screen changes. */
export function usePick({ screen, ready, on, size, place, over, measure }: PickOptions): PickState {
  const [panel, setPanel] = useState<Panel>(NO_PANEL)
  // the cap, and the window and place it was taken for
  const [fit, setFit] = useState({ cap: MIN_CAP, of: '' })
  const cur = useRef(panel)
  const sizes = useRef(measure)
  sizes.current = measure
  const lying = useRef(over)
  lying.current = over
  // the title and keys last measured, for a window drawn with none
  const chrome = useRef(0)

  const now = (): Look => {
    const s = screen.current
    return s ? look(s.shot(DEPTH)) : NOTHING
  }
  const apply = (p: Panel) => {
    if (p === cur.current) return
    cur.current = p
    setPanel(p)
  }

  useEffect(() => {
    if (!on) {
      apply(NO_PANEL)
      return
    }
    const s = screen.current
    if (!s) return
    let frame: number | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const step = () => {
      frame = null
      clearTimeout(timer)
      const p = next(cur.current, now(), Date.now())
      apply(p)
      // gone a moment: look again when it would go for good, as nothing may draw before then
      if (p.stale && p.lost !== null) timer = setTimeout(step, Math.max(0, p.lost + SETTLE_MS - Date.now()))
    }
    // one look a frame, however often the program writes
    const later = () => {
      if (frame === null) frame = requestAnimationFrame(step)
    }
    step()
    const off = s.onView(later)
    return () => {
      off()
      if (frame !== null) cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [ready, on])

  // the bar's height resized the terminal: a window that goes now may be its doing; a panel over it resizes nothing
  useEffect(() => {
    if (!lying.current) apply(restart(cur.current, Date.now()))
  }, [size])

  const wait = (test: (l: Look) => boolean, ms: number) =>
    new Promise<Look | null>((done) => {
      const first = now()
      if (test(first)) return done(first)
      const s = screen.current
      if (!s) return done(null)
      let off = () => {}
      const timer = setTimeout(() => {
        off()
        done(null)
      }, ms)
      off = s.onView(() => {
        const l = now()
        if (!test(l)) return
        clearTimeout(timer)
        off()
        done(l)
      })
    })

  const shown = on ? panel : NO_PANEL
  const of = shown.seen ? `${shown.seen.form} ${String(place)}` : ''
  // A window new to its place is drawn with its title and keys at least, so
  // that they are measured, though the last window showed no panel.
  const cap = fit.cap < 0 && fit.of !== of ? 0 : fit.cap
  const take = () => {
    const seen = shown.seen
    if (!seen) return
    const m = sizes.current()
    // with no panel drawn, its title and keys as they were last
    if (m.chrome > 0) chrome.current = m.chrome
    const c = lying.current ? overCap(m.stage, m.viewH, chrome.current, seen.options.length > 0) : capOf(m.total, m.cellH, seen.rows, m.viewH, chrome.current)
    setFit((f) => (f.cap === c && f.of === of ? f : { cap: c, of }))
  }
  // The cap is taken once the window's panel is drawn, as its title and keys
  // take their part of the room, and drawn again before the screen shows it;
  // then it is kept, so the panel does not move under a finger, though a
  // redraw cuts the window's title.
  useLayoutEffect(take, [shown.seen?.form, place])
  // A list left out for want of room, or a panel, is measured again as the
  // terminal's size changes: it grew, as when a phone's keyboard goes down,
  // and they may fit now. A list shown keeps its cap.
  useLayoutEffect(() => {
    if (cap <= 0) take()
  }, [size])

  return { seen: shown.seen, stale: shown.stale, held: shown.held, cap, now, wait }
}

/** A checkbox's state or the item in use, in words beside its icon (design §6.4). */
function Mark({ mark }: { mark: Option['mark'] }): JSX.Element | null {
  if (mark === 'current')
    return (
      <span class="term-pick-mark is-current">
        <Icon name="check" size={14} />
        지금 쓰는 것
      </span>
    )
  if (mark === 'on')
    return (
      <span class="term-pick-mark is-on">
        <Icon name="check" size={14} />
        고름
      </span>
    )
  if (mark === 'off') return <span class="term-pick-mark is-off">안 고름</span>
  return null
}

/**
 * The window's items, the one under its cursor marked. An item the cursor
 * cannot reach from where it stands is off (lib/pickpress.ts reach).
 */
export function PickList({
  seen,
  blocked,
  disabled,
  onChoose,
}: {
  seen: Seen
  blocked: boolean
  disabled: boolean
  onChoose: (n: number) => void
}): JSX.Element {
  return (
    <ul class="qrows term-pick-list">
      {seen.options.map((o) => {
        const at = o.n === seen.cursor
        return (
          <li key={o.n}>
            <button
              type="button"
              class={'qrow term-pick-row' + (at ? ' is-selected' : '')}
              aria-current={at ? 'true' : undefined}
              disabled={disabled || !reach(seen, o.n, blocked)}
              onPointerDown={keep}
              onMouseDown={keep}
              onClick={() => onChoose(o.n)}
            >
              <span class="term-pick-n">{o.n}</span>
              <span class="qrow-main">
                <span class="qrow-title">{o.label}</span>
                {o.desc && <span class="qrow-sub">{o.desc}</span>}
              </span>
              <Mark mark={o.mark} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** The hint line's keys, but the one skip names. */
export function PickHints({
  hints,
  disabled,
  skip,
  onHint,
}: {
  hints: Hint[]
  disabled: boolean
  skip?: string
  onHint: (h: Hint) => void
}): JSX.Element | null {
  const shown = skip ? hints.filter((h) => h.key !== skip) : hints
  if (!shown.length) return null
  return (
    <div class="term-pick-hints">
      {shown.map((h) => (
        <button
          key={`${h.key} ${h.label}`}
          type="button"
          class={'btn btn-sm' + (h.danger ? ' btn-danger' : '')}
          aria-label={h.aria}
          disabled={disabled}
          onPointerDown={keep}
          onMouseDown={keep}
          onClick={() => onHint(h)}
        >
          {h.label}
        </button>
      ))}
    </div>
  )
}

/** What the panel's title says of a window. */
const headOf = (seen: Seen) => seen.title || (seen.options.length ? '터미널이 고르기를 기다립니다' : '터미널에 창이 떠 있습니다')

/** What a screen reader hears of a window. */
const spoken = (seen: Seen) => (seen.title ? `고르는 목록: ${seen.title}` : headOf(seen))

/**
 * A window the terminal keeps whole, as the panel's title and keys alone
 * would cut it (design §6.4): nothing shows, but a screen reader hears of it
 * once, and that it is answered on the terminal. Its own component, not the
 * panel drawn empty: a panel drawn for a moment, then this, is read out once.
 */
export function PickKept({ seen }: { seen: Seen }): null {
  useEffect(() => {
    const words = spoken(seen)
    // a title that ends its own sentence takes no second period
    announce(`${words}${/[.!?…]$/.test(words) ? '' : '.'} 자리가 모자라 터미널에서 고릅니다`)
  }, [seen.form, seen.title])
  return null
}

/** A window that is not a question the program is blocked on. */
export function PickPanel({
  id,
  seen,
  cap,
  disabled,
  onChoose,
  onHint,
}: {
  id: string
  seen: Seen
  cap: number
  disabled: boolean
  onChoose: (n: number) => void
  onHint: (h: Hint) => void
}): JSX.Element {
  const head = id + '-pick'
  const title = headOf(seen)
  // read out once a window, though its cursor moves or a redraw cuts its title
  useEffect(() => {
    announce(spoken(seen))
  }, [seen.form, seen.title])
  return (
    // a press stays in the panel: the stage under it would give the terminal the focus, and a phone its keyboard
    <section class="term-pick" aria-labelledby={head} onClick={(e) => e.stopPropagation()}>
      <h2 id={head} class="term-pick-title">
        {title}
      </h2>
      {seen.options.length > 0 && cap > 0 && (
        <div class="term-pick-body" style={{ maxHeight: `${cap}px` }}>
          <PickList seen={seen} blocked={false} disabled={disabled} onChoose={onChoose} />
        </div>
      )}
      <PickHints hints={seen.hints} disabled={disabled} onHint={onHint} />
    </section>
  )
}
