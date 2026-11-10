import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from './api'
import { hello } from './hello'
import { route } from './router'
import { host } from './store'
import { toasts } from './toast'
import { AWAY, newBuild, reloadPage, resetUpdates, RETRY, safeToReload, startUpdates } from './update'

const HELLO = { app: 'mori', version: 'aaa1111', host: 'macmini', paired: true }

let vis: DocumentVisibilityState
let clock: number
let reload: ReturnType<typeof vi.fn<() => void>>
let stop: (() => void) | null

function start() {
  stop = startUpdates({ reload, now: () => clock })
}

/** The page goes off screen, or comes back. */
function show(state: DocumentVisibilityState) {
  vis = state
  document.dispatchEvent(new Event('visibilitychange'))
}

/** The hub's overview after a reconnect. */
function hubRuns(version: string) {
  host.value = { name: 'macmini', version }
}

beforeEach(() => {
  vis = 'visible'
  clock = 1_000_000
  reload = vi.fn<() => void>()
  stop = null
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis })
  sessionStorage.clear()
  hello.value = HELLO
  host.value = null
  route.value = { name: 'queue' }
  toasts.value = []
})

afterEach(() => {
  stop?.()
  resetUpdates()
  delete (document as { visibilityState?: unknown }).visibilityState
  hello.value = null
  host.value = null
  route.value = { name: 'queue' }
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a new build of the hub', () => {
  it("takes the hub's first version as this page's build and marks another one", () => {
    start()
    expect(newBuild.value).toBeNull()
    hubRuns('aaa1111')
    expect(newBuild.value).toBeNull()
    hubRuns('bbb2222')
    expect(newBuild.value).toBe('bbb2222')
    hubRuns('aaa1111') // back to this page's build
    expect(newBuild.value).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it('keeps the build of the first start when the page pairs again', () => {
    start()
    stop?.()
    hubRuns('bbb2222')
    start()
    expect(newBuild.value).toBe('bbb2222')
  })

  it('reloads as the page goes off screen or comes back, once a while for the same build', () => {
    start()
    hubRuns('bbb2222')
    expect(reload).not.toHaveBeenCalled() // on screen: nothing changes under the user
    show('hidden')
    expect(reload).toHaveBeenCalledTimes(1)
    // The reload came back on this page: not again soon.
    show('visible')
    expect(reload).toHaveBeenCalledTimes(1)
    clock += RETRY
    show('hidden')
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('reloads at once when the new build comes while the page is off screen', () => {
    start()
    vis = 'hidden'
    hubRuns('bbb2222')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload for the build it runs', () => {
    start()
    hubRuns('aaa1111')
    show('hidden')
    show('visible')
    expect(reload).not.toHaveBeenCalled()
  })

  it('waits while a sheet is open, a form is on screen or a field is being typed in', () => {
    start()
    hubRuns('bbb2222')
    const sheet = document.createElement('dialog')
    sheet.setAttribute('open', '')
    document.body.append(sheet)
    expect(safeToReload()).toBe(false)
    show('hidden')
    sheet.remove()
    for (const name of ['new', 'settings'] as const) {
      route.value = { name }
      expect(safeToReload()).toBe(false)
    }
    route.value = { name: 'terminal', addr: 'macmini/t1', git: false }
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    expect(safeToReload()).toBe(false)
    show('visible')
    expect(reload).not.toHaveBeenCalled()
    // The composer keeps its words as a draft, and the terminal keeps nothing.
    const draft = document.createElement('textarea')
    draft.dataset.draft = ''
    document.body.append(draft)
    draft.focus()
    expect(safeToReload()).toBe(true)
    show('hidden')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('waits for a change on its way to the server', async () => {
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => (answer = res))))
    start()
    hubRuns('bbb2222')
    const sent = request('POST', '/api/terminals/macmini%2Ft1/send', { text: 'hi' })
    show('hidden')
    expect(reload).not.toHaveBeenCalled()
    answer(new Response(null, { status: 204 }))
    await sent
    expect(safeToReload()).toBe(true)
    show('visible')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads a PC screen left alone in another window for a minute', () => {
    vi.useFakeTimers()
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    start()
    hubRuns('bbb2222')
    clock += AWAY / 2
    window.dispatchEvent(new Event('pointerdown')) // touched: the minute starts again
    clock += AWAY / 2 + 1_000
    vi.advanceTimersByTime(15_000)
    expect(reload).not.toHaveBeenCalled()
    focused.mockReturnValue(true) // looked at
    clock += AWAY
    vi.advanceTimersByTime(15_000)
    expect(reload).not.toHaveBeenCalled()
    focused.mockReturnValue(false)
    vi.advanceTimersByTime(15_000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('says once that the page now runs the build it reloaded for', () => {
    start()
    hubRuns('bbb2222')
    show('hidden')
    expect(reload).toHaveBeenCalledTimes(1)
    // The new page, on the new build.
    stop?.()
    resetUpdates()
    hello.value = { ...HELLO, version: 'bbb2222' }
    host.value = null
    clock += 2_000
    start()
    expect(toasts.value.map((t) => t.text)).toEqual(['새 버전으로 바꿨습니다 · bbb2222'])
    expect(newBuild.value).toBeNull()
    stop?.()
    resetUpdates()
    start()
    expect(toasts.value).toHaveLength(1)
  })

  it('reloads from the button whatever is open', () => {
    start()
    reloadPage()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
