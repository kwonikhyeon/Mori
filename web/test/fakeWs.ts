// A WebSocket the tests drive by hand. The code under test makes one with
// new; the test plays the server: it opens the socket, feeds it messages
// and closes it with a code.

export class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static all: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  binaryType: BinaryType = 'blob'
  /** What the client sent: strings as they were, binary as bytes. */
  sent: (string | Uint8Array)[] = []
  /** The code the client closed with, if it did. */
  closedWith: { code?: number; reason?: string } | null = null
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.all.push(this)
  }

  static reset(): void {
    FakeWebSocket.all = []
  }

  static last(): FakeWebSocket {
    const ws = FakeWebSocket.all.at(-1)
    if (!ws) throw new Error('no socket was made')
    return ws
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('send on a socket that is not open')
    if (typeof data === 'string') this.sent.push(data)
    else if (ArrayBuffer.isView(data)) this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice())
    else if (data instanceof ArrayBuffer) this.sent.push(new Uint8Array(data).slice())
    else throw new Error('the fake sends strings and bytes only')
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= FakeWebSocket.CLOSING) return
    this.closedWith = { code, reason }
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(closeEvent(code ?? 1005, reason ?? ''))
  }

  // The server's side.

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  receive(data: string | Uint8Array): void {
    const payload = typeof data === 'string' ? data : data.slice().buffer
    this.onmessage?.({ data: payload } as MessageEvent)
  }

  json(v: unknown): void {
    this.receive(JSON.stringify(v))
  }

  /** The server or the network ends the socket. */
  drop(code = 1006, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(closeEvent(code, reason))
  }

  /** The JSON messages the client sent, parsed. */
  messages(): Record<string, unknown>[] {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s))
  }

  /** The binary messages the client sent, as text. */
  input(): string[] {
    const dec = new TextDecoder()
    return this.sent.filter((s): s is Uint8Array => typeof s !== 'string').map((b) => dec.decode(b))
  }

  query(): URLSearchParams {
    return new URL(this.url).searchParams
  }
}

function closeEvent(code: number, reason: string): CloseEvent {
  return { type: 'close', code, reason, wasClean: code !== 1006 } as CloseEvent
}
