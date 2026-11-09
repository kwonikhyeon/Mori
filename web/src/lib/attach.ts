// One terminal's /ws/attach (spec §7.3, §3 #125–#127): the screen comes as
// binary and keys go back as binary; JSON says the size and the end. The
// session attaches again by itself where the close code says it may.
import { wsURL } from './api'
import { Backoff } from './backoff'
import type { SocketCtor } from './events'
import type { DisplayFacts } from './theme'
import type { AttachMessage, TerminalView } from './types'

// connecting    the first socket is on its way
// open          attached
// waiting-core  4503: the core is down; back as soon as it is up
// recovering    4409: the core brings the terminal back; back when it has a pid
// reconnecting  the line dropped; trying again
// closed        the program ended (closed, then 1000)
// gone          4404: no such terminal
// error         4400 or 4401: trying again would not help
export type AttachState = 'connecting' | 'open' | 'waiting-core' | 'recovering' | 'reconnecting' | 'closed' | 'gone' | 'error'

export interface Size {
  cols: number
  rows: number
}

export interface Attached extends Size {
  terminal: TerminalView
  /** Back after a drop: the screen starts over from the history. */
  resumed: boolean
}

export interface Closed {
  reason: string
  exit_code: number | null
  signal: number | null
}

export interface AttachEvents {
  data: Uint8Array
  state: AttachState
  attached: Attached
  size: Size
  closed: Closed
}

export interface AttachOptions {
  addr: string
  /** The size this screen fits. An observer never sends one. */
  cols?: number
  rows?: number
  observe?: boolean
  /** Scrollback lines to paint first; the server's default is 1000. */
  history?: number
  url?: string
  socket?: SocketCtor
  backoff?: Backoff
  onUnauthorized?: () => void
}

type Handlers = { [K in keyof AttachEvents]: Set<(v: AttachEvents[K]) => void> }

const OPEN = 1
const enc = new TextEncoder()

export class AttachSession {
  state: AttachState = 'connecting'
  /** The terminal's size as the server last said it. */
  cols = 0
  rows = 0
  /** How the program ended, once it has. */
  ended: Closed | null = null
  /** The reason of the last close, for a screen that cannot come back. */
  reason = ''

  private ws: WebSocket | null = null
  private retry: ReturnType<typeof setTimeout> | undefined
  private attachedOnce = false
  private stopped = false
  private want: Size | null
  private focused = false
  private sentFocus = false
  private facts: DisplayFacts | null = null
  private sentFacts = ''
  private readonly backoff: Backoff
  private readonly socket: SocketCtor
  private readonly handlers: Handlers = { data: new Set(), state: new Set(), attached: new Set(), size: new Set(), closed: new Set() }

  constructor(private readonly o: AttachOptions) {
    this.want = o.cols && o.rows ? { cols: o.cols, rows: o.rows } : null
    this.backoff = o.backoff ?? new Backoff()
    this.socket = o.socket ?? WebSocket
  }

  get observing(): boolean {
    return !!this.o.observe
  }

  on<K extends keyof AttachEvents>(k: K, fn: (v: AttachEvents[K]) => void): () => void {
    const set: Set<(v: AttachEvents[K]) => void> = this.handlers[k]
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  }

  start(): void {
    if (!this.ws && this.retry === undefined && !this.stopped) this.connect()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retry)
    this.retry = undefined
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onmessage = null
      ws.onclose = null
      ws.close()
    }
  }

  /** Tries now instead of waiting out the backoff. */
  nudge(): void {
    if (this.stopped || this.ws || this.retry === undefined) return
    clearTimeout(this.retry)
    this.connect()
  }

  /** The event stream heard the core; a session waiting for it goes back now. */
  notifyCore(connected: boolean): void {
    if (connected && this.state === 'waiting-core') this.nudge()
  }

  /** The terminal changed; one the core brought back can be attached again. */
  notifyTerminal(t: TerminalView): void {
    if (this.state === 'recovering' && t.state === 'live' && t.pid != null) this.nudge()
  }

  /** Types data, unless only watching or not attached. */
  send(data: string | Uint8Array<ArrayBuffer>): boolean {
    if (!this.writable() || this.o.observe) return false
    this.ws!.send(typeof data === 'string' ? enc.encode(data) : data)
    return true
  }

  /**
   * This screen now fits cols×rows. The terminal follows when the fit
   * changed; force asks for it even then ("이 화면에 맞추기").
   */
  resize(cols: number, rows: number, force = false): void {
    const changed = !this.want || this.want.cols !== cols || this.want.rows !== rows
    this.want = { cols, rows }
    if (this.o.observe || !this.writable()) return
    if (force || (changed && (cols !== this.cols || rows !== this.rows))) this.json({ type: 'resize', cols, rows })
  }

  /** Whether a person looks at this terminal now (spec §3 #127). */
  focus(focused: boolean): void {
    this.focused = focused
    if (!this.writable() || focused === this.sentFocus) return
    this.sentFocus = focused
    this.json({ type: 'focus', focused })
  }

  /** The colours and cell size the terminal is drawn with. */
  display(d: DisplayFacts): void {
    this.facts = d
    if (this.o.observe || !this.writable()) return
    const s = JSON.stringify(d)
    if (s === this.sentFacts) return
    this.sentFacts = s
    this.json({ type: 'display', ...d })
  }

  private writable(): boolean {
    return this.state === 'open' && this.ws?.readyState === OPEN
  }

  private json(v: object): void {
    this.ws!.send(JSON.stringify(v))
  }

  private connect(): void {
    this.retry = undefined
    const p = new URLSearchParams({ t: this.o.addr })
    if (this.o.observe) p.set('observe', '1')
    else if (this.want) {
      p.set('cols', String(this.want.cols))
      p.set('rows', String(this.want.rows))
    }
    if (this.o.history != null) p.set('history', String(this.o.history))
    if (this.attachedOnce) p.set('resumed', '1')
    const ws = new this.socket(`${this.o.url ?? wsURL('/ws/attach')}?${p}`)
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (e) => this.onMessage(e)
    ws.onclose = (e) => {
      this.ws = null
      this.onClose(e)
    }
    this.ws = ws
  }

  private onMessage(e: MessageEvent): void {
    if (typeof e.data !== 'string') {
      this.emit('data', new Uint8Array(e.data as ArrayBuffer))
      return
    }
    let m: AttachMessage
    try {
      m = JSON.parse(e.data) as AttachMessage
    } catch {
      return
    }
    if (!m || typeof m !== 'object') return
    switch (m.type) {
      case 'attached': {
        const resumed = this.attachedOnce
        this.attachedOnce = true
        this.backoff.reset()
        this.cols = m.cols
        this.rows = m.rows
        this.sentFocus = false
        this.sentFacts = ''
        this.reason = ''
        this.setState('open')
        this.emit('attached', { terminal: m.terminal, cols: m.cols, rows: m.rows, resumed })
        if (this.facts) this.display(this.facts)
        if (this.focused) this.focus(true)
        return
      }
      case 'size':
        this.cols = m.cols
        this.rows = m.rows
        this.emit('size', { cols: m.cols, rows: m.rows })
        return
      case 'closed':
        this.ended = { reason: m.reason, exit_code: m.exit_code, signal: m.signal }
        this.emit('closed', this.ended)
        return
    }
  }

  private onClose(e: CloseEvent): void {
    if (this.stopped) return
    this.reason = e.reason
    switch (e.code) {
      case 1000: // after closed: the program ended
        this.setState('closed')
        return
      case 4401:
        this.setState('error')
        this.o.onUnauthorized?.()
        return
      case 4404:
        this.setState('gone')
        return
      case 4400:
        this.setState('error')
        return
      case 4409:
        this.setState('recovering')
        break
      case 4503:
        this.setState('waiting-core')
        break
      default:
        this.setState('reconnecting')
    }
    // Waiting for the core or the terminal is told by the event stream;
    // trying now and then as well covers an event that never comes.
    this.retry = setTimeout(() => this.connect(), this.backoff.next())
  }

  private setState(s: AttachState): void {
    if (this.state === s) return
    this.state = s
    this.emit('state', s)
  }

  private emit<K extends keyof AttachEvents>(k: K, v: AttachEvents[K]): void {
    const set: Set<(v: AttachEvents[K]) => void> = this.handlers[k]
    for (const fn of [...set]) fn(v)
  }
}
