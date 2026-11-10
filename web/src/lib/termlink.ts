// One terminal screen wired to its attach stream (spec §3 #123–#127): the
// output paints the screen, keys go back, the size, the focus and the
// colours are told, and the session follows the core and the terminal
// through the event stream. The view owns the screen; the link owns the
// session.

import { effect, signal } from '@preact/signals'
import { api, type HostApi } from './api'
import { AttachSession, type AttachState, type Closed, type Size } from './attach'
import type { SocketCtor } from './events'
import { watchFocus } from './focus'
import { keyBytes, NO_MODS, tapMod, withMods, type Mod, type Mods, type QuickKey } from './keys'
import { paintFilter } from './paint'
import { hubStore, type HostStore } from './store'
import { screenText } from './termview'
import { displayFacts, effectiveTheme, terminalTheme } from './theme'
import { onWake } from './wake'
import type { Screen } from './xterm'

export interface TermLinkOptions {
  addr: string
  screen: Screen
  /** Only watch: nothing typed and no size sent. */
  observe?: boolean
  /** The size that fits this screen, when it is known before attaching. */
  fit?: Size | null
  /**
   * The terminal's own size, asked for while the fit is unknown: an attach
   * without a size would set the server's default.
   */
  start?: Size | null
  url?: string
  socket?: SocketCtor
  onUnauthorized?: () => void
  /** The calls of the terminal's host; the hub's unless given. */
  api?: HostApi
  /** What the terminal's host says of its core and terminals; the hub's unless given. */
  store?: Pick<HostStore, 'core' | 'terminals'>
}

/** The lines of an ended program painted when there is no stream to replay. */
const LAST_LINES = 1000
const HIDE_CURSOR = '\x1b[?25l'

const bytes = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)

export class TermLink {
  readonly state = signal<AttachState>('connecting')
  /** How the program ended, when the stream said it. */
  readonly ended = signal<Closed | null>(null)
  /** The reason of the last close. */
  readonly reason = signal('')
  /** The terminal's size as the server says it. */
  readonly size = signal<Size | null>(null)
  /** The size that fits this screen. */
  readonly fit = signal<Size | null>(null)
  readonly observing = signal(false)
  /** Ctrl and Alt held by the quick keys (spec §3 #186). */
  readonly mods = signal<Mods>(NO_MODS)

  private session!: AttachSession
  private tapped: Record<Mod, number> = { ctrl: -Infinity, alt: -Infinity }
  private offSession: (() => void)[] = []
  private readonly stops: (() => void)[] = []
  /** The newest socket attached, so the screen shows the stream's end. */
  private live = false
  private focused = false
  private disposed = false

  constructor(private readonly o: TermLinkOptions) {
    this.fit.value = o.fit ?? null
    this.observing.value = !!o.observe
    const sc = o.screen
    this.stops.push(sc.onData((s) => void this.typed(s)))
    this.stops.push(sc.onBinary((s) => void this.session.send(bytes(s))))
    this.open()
    this.stops.push(
      effect(() => {
        const mode = effectiveTheme.value
        sc.setTheme(terminalTheme(mode))
        this.session.display(displayFacts(mode, sc.cell()))
      }),
    )
    this.stops.push(
      watchFocus((f) => {
        this.focused = f
        this.session.focus(f)
      }),
    )
    const st = o.store ?? hubStore
    this.stops.push(effect(() => this.session.notifyCore(st.core.value.connected)))
    this.stops.push(
      effect(() => {
        const t = st.terminals.value.get(o.addr)
        if (t) this.session.notifyTerminal(t)
      }),
    )
    this.stops.push(onWake(() => this.session.nudge()))
  }

  /** Types s into the terminal; false when only watching or not attached. */
  send(s: string): boolean {
    return this.sent(this.session.send(s))
  }

  /** A quick key, written the way the program reads it now, with Ctrl and Alt as held. */
  key(k: QuickKey): boolean {
    const m = this.mods.peek()
    const ok = this.sent(this.session.send(keyBytes(k, this.o.screen.appCursor(), m.ctrl !== 'off', m.alt !== 'off')))
    if (ok) this.spend()
    return ok
  }

  /** Ctrl or Alt tapped: held for the next key, held on, or let go. */
  tapMod(m: Mod, at = Date.now()): void {
    const cur = this.mods.peek()
    this.mods.value = { ...cur, [m]: tapMod(cur[m], at - this.tapped[m]) }
    this.tapped[m] = at
  }

  /** The screen's box changed: the terminal follows when the fit did. */
  setFit(z: Size | null): void {
    this.fit.value = z
    // the cell may have changed with the fonts or the zoom
    this.session.display(displayFacts(effectiveTheme.peek(), this.o.screen.cell()))
    if (z) this.session.resize(z.cols, z.rows)
  }

  /** Gives the terminal this screen's size ("이 화면에 맞추기"). */
  fitNow(): void {
    const z = this.fit.peek()
    if (z) this.session.resize(z.cols, z.rows, true)
  }

  /** Attaches again to only watch, or to work. */
  setObserve(on: boolean): void {
    if (this.disposed || on === this.observing.peek()) return
    this.observing.value = on
    this.close()
    this.open()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.close()
    for (const stop of this.stops.splice(0)) stop()
  }

  /** A key typed into the screen, with Ctrl and Alt as the quick keys hold them. */
  private typed(s: string): boolean {
    const m = this.mods.peek()
    const one = s.length === 1 && (m.ctrl !== 'off' || m.alt !== 'off')
    const ok = this.session.send(one ? withMods(s, m.ctrl !== 'off', m.alt !== 'off') : s)
    if (ok && one) this.spend()
    return ok
  }

  /** A key went: what was held for it lets go. */
  private spend(): void {
    const m = this.mods.peek()
    if (m.ctrl !== 'once' && m.alt !== 'once') return
    this.mods.value = { ctrl: m.ctrl === 'once' ? 'off' : m.ctrl, alt: m.alt === 'once' ? 'off' : m.alt }
  }

  /** What went shows the screen's end, as xterm does for what is typed into it. */
  private sent(ok: boolean): boolean {
    if (ok) this.o.screen.scrollToBottom()
    return ok
  }

  private open(): void {
    const z = this.fit.peek() ?? this.o.start
    const sc = this.o.screen
    const s = new AttachSession({
      addr: this.o.addr,
      observe: this.observing.peek(),
      cols: z?.cols,
      rows: z?.rows,
      url: this.o.url,
      socket: this.o.socket,
      onUnauthorized: this.o.onUnauthorized,
    })
    this.session = s
    this.live = false
    this.mods.value = NO_MODS
    let paint = (d: Uint8Array) => d
    this.offSession = [
      s.on('data', (d) => sc.write(paint(d))),
      s.on('attached', (a) => {
        // the history follows: the screen starts over
        paint = paintFilter(a.rows)
        this.live = true
        this.ended.value = null
        sc.reset()
        sc.setInput(!s.observing)
        sc.resize(a.cols, a.rows)
        this.size.value = { cols: a.cols, rows: a.rows }
      }),
      s.on('size', (z) => {
        sc.resize(z.cols, z.rows)
        this.size.value = z
      }),
      s.on('closed', (c) => {
        this.ended.value = c
      }),
      s.on('state', (st) => {
        if (st !== 'open' && st !== 'closed') this.live = false
        this.reason.value = s.reason
        this.state.value = st
        if (st === 'closed') void this.finish()
      }),
    ]
    this.state.value = s.state
    this.reason.value = ''
    s.focus(this.focused)
    s.display(displayFacts(effectiveTheme.peek(), sc.cell()))
    s.start()
  }

  private close(): void {
    for (const off of this.offSession.splice(0)) off()
    this.session.stop()
  }

  /** The program ended: paint its last text if the stream did not, and stop typing. */
  private async finish(): Promise<void> {
    const sc = this.o.screen
    sc.setInput(false)
    if (!this.live) {
      try {
        const r = await (this.o.api ?? api).terminals.text(this.o.addr, LAST_LINES)
        if (this.disposed) return
        const t = (this.o.store ?? hubStore).terminals.peek().get(this.o.addr)
        if (t) {
          sc.resize(t.cols, t.rows)
          this.size.value = { cols: t.cols, rows: t.rows }
        }
        sc.reset()
        sc.write(screenText(r.text))
      } catch {
        // the end bar says that it ended
      }
    }
    if (!this.disposed) sc.write(HIDE_CURSOR)
  }
}
