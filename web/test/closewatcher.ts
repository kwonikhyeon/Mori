// CloseWatcher as Chrome has it, for jsdom: the back key (pressBack) closes
// the newest watcher still active. A modal <dialog> has none here; its
// cancel event stands in for one (setup.ts's showModal).

export class FakeCloseWatcher extends EventTarget {
  static active: FakeCloseWatcher[] = []
  onclose: ((e: Event) => void) | null = null
  oncancel: ((e: Event) => void) | null = null

  constructor() {
    super()
    FakeCloseWatcher.active.push(this)
  }

  requestClose(): void {
    this.close()
  }

  close(): void {
    if (!this.#drop()) return
    const e = new Event('close')
    this.onclose?.(e)
    this.dispatchEvent(e)
  }

  destroy(): void {
    this.#drop()
  }

  #drop(): boolean {
    const i = FakeCloseWatcher.active.indexOf(this)
    if (i < 0) return false
    FakeCloseWatcher.active.splice(i, 1)
    return true
  }
}

/** The back key where a watcher listens; false when none does, and the browser would go back. */
export function pressBack(): boolean {
  const w = FakeCloseWatcher.active.at(-1)
  w?.requestClose()
  return !!w
}
