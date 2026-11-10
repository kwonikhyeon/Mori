import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pressBack } from '../../test/closewatcher'
import { initBackstack, layersOpen, marked, openLayer, resetBackstack, unmarked, writeHistory } from './backstack'

/** Lets jsdom go through history, which it does a task later, as a browser does. */
const traversed = () => new Promise((r) => setTimeout(r, 5))

let stop: () => void = () => {}

beforeEach(() => {
  history.replaceState(null, '', '/#/')
})

afterEach(() => {
  stop()
  stop = () => {}
  resetBackstack()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('marks', () => {
  it("tells the layers' entry and takes its mark off", () => {
    expect(marked({ moriLayer: 1 })).toBe(true)
    expect(marked({ moriLayer: 2 })).toBe(false)
    expect(marked(null)).toBe(false)
    expect(marked('moriLayer')).toBe(false)
    expect(unmarked({ moriLayer: 1 })).toBeNull()
    expect(unmarked({ moriLayer: 1, scroll: 3 })).toEqual({ scroll: 3 })
    const s = { scroll: 3 }
    expect(unmarked(s)).toBe(s)
  })

  it('drops a mark a reload left', () => {
    history.replaceState({ moriLayer: 1, scroll: 3 }, '', '/#/folders')
    stop = initBackstack()
    expect(history.state).toEqual({ scroll: 3 })
    expect(location.hash).toBe('#/folders')
  })
})

describe('with CloseWatcher', () => {
  it("gives a menu a watcher that the back key closes, and leaves a dialog's to the browser", () => {
    const len = history.length
    const menu = vi.fn()
    const dialog = vi.fn()
    const closeDialog = openLayer(dialog, true)
    openLayer(menu, false)
    expect(layersOpen()).toBe(true)
    expect(pressBack()).toBe(true)
    expect(menu).toHaveBeenCalledTimes(1)
    expect(pressBack()).toBe(false) // the dialog's is the browser's own
    expect(dialog).not.toHaveBeenCalled()
    expect(layersOpen()).toBe(true)
    closeDialog()
    closeDialog()
    expect(layersOpen()).toBe(false)
    expect(history.length).toBe(len)
  })

  it('lets the watcher go when the menu closes another way', () => {
    const menu = vi.fn()
    const done = openLayer(menu, false)
    done()
    expect(pressBack()).toBe(false)
    expect(menu).not.toHaveBeenCalled()
    expect(layersOpen()).toBe(false)
  })

  it('writes history at once', () => {
    const f = vi.fn()
    writeHistory(f)
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('without CloseWatcher', () => {
  beforeEach(() => {
    vi.stubGlobal('CloseWatcher', undefined)
    stop = initBackstack()
  })

  it('takes one entry for what is open, which the back key closes from the top', async () => {
    const len = history.length
    const under = vi.fn()
    const top = vi.fn()
    openLayer(under, true)
    expect(marked(history.state)).toBe(true)
    openLayer(top, false)
    expect(history.length).toBe(len + 1)
    history.back()
    await traversed()
    expect(top).toHaveBeenCalledTimes(1)
    expect(under).not.toHaveBeenCalled()
    // The one under it keeps an entry.
    expect(marked(history.state)).toBe(true)
    expect(layersOpen()).toBe(true)
    history.back()
    await traversed()
    expect(under).toHaveBeenCalledTimes(1)
    expect(marked(history.state)).toBe(false)
    expect(layersOpen()).toBe(false)
    expect(location.hash).toBe('#/')
  })

  it('takes the entry back when the last one closes another way', async () => {
    const close = vi.fn()
    const done = openLayer(close, true)
    const other = openLayer(vi.fn(), false)
    other()
    await traversed()
    expect(marked(history.state)).toBe(true) // one is still open
    done()
    done()
    await traversed()
    expect(marked(history.state)).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(layersOpen()).toBe(false)
    expect(location.hash).toBe('#/')
  })

  it("writes a new screen's entry after the step back over the layers'", async () => {
    const done = openLayer(vi.fn(), true)
    const write = vi.fn(() => {
      location.hash = '#/folders'
    })
    writeHistory(write)
    expect(write).not.toHaveBeenCalled()
    await traversed()
    expect(write).toHaveBeenCalledTimes(1)
    expect(location.hash).toBe('#/folders')
    // Still open, it has an entry again, on top of the new screen's.
    expect(marked(history.state)).toBe(true)
    done()
    await traversed()
    expect(marked(history.state)).toBe(false)
    expect(location.hash).toBe('#/folders')
    history.back()
    await traversed()
    expect(location.hash).toBe('#/')
  })

  it('replaces the screen it was opened over, not the entry of the layers', async () => {
    history.pushState(null, '', '/#/t/t1')
    const done = openLayer(vi.fn(), true)
    done()
    writeHistory(() => history.replaceState(unmarked(history.state), '', '/#/settings'))
    await traversed()
    expect(location.hash).toBe('#/settings')
    expect(marked(history.state)).toBe(false)
    history.back()
    await traversed()
    expect(location.hash).toBe('#/')
  })

  it('steps back over the entry of layers already closed when it comes forward onto it', async () => {
    const done = openLayer(vi.fn(), true)
    done()
    await traversed()
    history.forward()
    await traversed()
    await traversed()
    expect(marked(history.state)).toBe(false)
  })

  it('waits no longer than it should for a step back that never comes', () => {
    vi.useFakeTimers()
    const back = vi.spyOn(history, 'back').mockImplementation(() => {})
    openLayer(vi.fn(), true)
    const write = vi.fn()
    writeHistory(write)
    expect(back).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(599)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledTimes(1)
  })
})
