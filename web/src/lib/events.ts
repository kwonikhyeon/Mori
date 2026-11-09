// /ws/events (spec §7.2, §3 #131): a snapshot first, then changes. Every
// drop starts over with a new snapshot, so nothing falls between sockets.
import { wsURL } from './api'
import { Backoff } from './backoff'
import type { Conn } from './store'
import type { EventMessage } from './types'

export type SocketCtor = new (url: string) => WebSocket

export interface EventStreamOptions {
  apply: (msg: EventMessage) => void
  setConn: (c: Conn) => void
  onUnauthorized: () => void
  url?: string
  socket?: SocketCtor
  backoff?: Backoff
  /** How long a drop goes unsaid. */
  bannerDelay?: number
  /** How long "서버 재시작 중" may last before it is just down. */
  restartGrace?: number
  /** Silence that counts as a dead socket; the server pings every 30 s. */
  silence?: number
}

const GOING_AWAY = 1001 // the server stops
const OVERFLOW = 1013 // the server dropped us for falling behind
const UNPAIRED = 4401

type Timer = ReturnType<typeof setTimeout>

export class EventStream {
  private ws: WebSocket | null = null
  private retry: Timer | undefined
  private banner: Timer | undefined
  private watchdog: Timer | undefined
  private state: Conn = 'connecting'
  private running = false
  private readonly backoff: Backoff
  private readonly socket: SocketCtor

  constructor(private readonly o: EventStreamOptions) {
    this.backoff = o.backoff ?? new Backoff()
    this.socket = o.socket ?? WebSocket
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.set('connecting')
    this.connect()
  }

  stop(): void {
    this.running = false
    clearTimeout(this.retry)
    clearTimeout(this.banner)
    this.retry = this.banner = undefined
    this.detach()?.close()
  }

  /** Tries now instead of waiting out the backoff: the page or the network came back. */
  nudge(): void {
    if (!this.running || this.ws) return
    clearTimeout(this.retry)
    this.connect()
  }

  private connect(): void {
    this.retry = undefined
    const ws = new this.socket(this.o.url ?? wsURL('/ws/events'))
    ws.onmessage = (e) => this.onMessage(e)
    ws.onclose = (e) => {
      this.ws = null
      clearTimeout(this.watchdog)
      this.dropped(e.code)
    }
    this.ws = ws
    this.arm()
  }

  /** Takes the socket out of the stream; what it does next is not heard. */
  private detach(): WebSocket | null {
    const ws = this.ws
    clearTimeout(this.watchdog)
    this.ws = null
    if (ws) {
      ws.onmessage = null
      ws.onclose = null
    }
    return ws
  }

  private arm(): void {
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => {
      this.detach()?.close()
      this.dropped(1006)
    }, this.o.silence ?? 75_000)
  }

  private onMessage(e: MessageEvent): void {
    this.arm()
    if (typeof e.data !== 'string') return
    let msg: EventMessage
    try {
      msg = JSON.parse(e.data) as EventMessage
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || msg.type === 'ping') return
    this.o.apply(msg)
    if (msg.type === 'snapshot') {
      this.backoff.reset()
      clearTimeout(this.banner)
      this.banner = undefined
      this.set('open')
    }
  }

  private dropped(code: number): void {
    if (!this.running) return
    if (code === UNPAIRED) {
      this.stop()
      this.set('connecting')
      this.o.onUnauthorized()
      return
    }
    if (code === GOING_AWAY) {
      this.set('restarting')
      this.later(this.o.restartGrace ?? 30_000)
    } else if (this.state === 'open' || this.state === 'connecting') {
      this.set('connecting')
      if (this.banner === undefined) this.later(this.o.bannerDelay ?? 2_000)
    }
    this.retry = setTimeout(() => this.connect(), code === OVERFLOW ? 0 : this.backoff.next())
  }

  /** Says "down" after ms unless a snapshot comes first. */
  private later(ms: number): void {
    clearTimeout(this.banner)
    this.banner = setTimeout(() => {
      this.banner = undefined
      this.set('down')
    }, ms)
  }

  private set(c: Conn): void {
    if (this.state === c) return
    this.state = c
    this.o.setConn(c)
  }
}
