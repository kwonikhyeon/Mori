import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { displayFacts, effectiveTheme, initTheme, setTheme, terminalTheme, theme } from './theme'

type Listener = (e: { matches: boolean }) => void

function fakeOS(dark: boolean) {
  const listeners = new Set<Listener>()
  const mql = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  }
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia
  return {
    flip(v: boolean) {
      mql.matches = v
      for (const l of listeners) l({ matches: v })
    },
    listening: () => listeners.size,
  }
}

let stop: () => void = () => {}

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  document.head.innerHTML = '<meta name="theme-color" content="#000000">'
})

afterEach(() => stop())

describe('theme', () => {
  it('follows the OS when nothing is saved', () => {
    const os = fakeOS(false)
    stop = initTheme()
    expect(theme.value).toBe('system')
    expect(effectiveTheme.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBeUndefined()
    os.flip(true)
    expect(effectiveTheme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#151412')
  })

  it('pins a chosen theme and remembers it', () => {
    fakeOS(false)
    stop = initTheme()
    setTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(effectiveTheme.value).toBe('dark')
    expect(localStorage.getItem('mori.theme')).toBe('"dark"')
    setTheme('system')
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(effectiveTheme.value).toBe('light')
  })

  it('starts from the saved choice and ignores junk', () => {
    fakeOS(true)
    localStorage.setItem('mori.theme', '"light"')
    stop = initTheme()
    expect(theme.value).toBe('light')
    expect(effectiveTheme.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    stop()
    localStorage.setItem('mori.theme', '"sepia"')
    stop = initTheme()
    expect(theme.value).toBe('system')
    expect(effectiveTheme.value).toBe('dark')
  })

  it('stops listening to the OS when stopped', () => {
    const os = fakeOS(false)
    stop = initTheme()
    expect(os.listening()).toBe(1)
    stop()
    expect(os.listening()).toBe(0)
  })
})

describe('terminal colors', () => {
  it('stays dark in both modes', () => {
    const light = terminalTheme('light')
    const dark = terminalTheme('dark')
    expect(light.background).toBe('#1F1E1C')
    expect(dark.background).toBe('#121110')
    expect(light.foreground).toBe(dark.foreground)
  })

  it('reports the colors and cell size the core answers queries with', () => {
    expect(displayFacts('light', [7.6, 18.2])).toEqual({ fg: '#ECEAE5', bg: '#1F1E1C', cursor: '#ECEAE5', cell: [8, 18] })
    expect(displayFacts('dark', [0, 0])).toEqual({ fg: '#ECEAE5', bg: '#121110', cursor: '#ECEAE5' })
  })
})
