import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './copy'

let exec: ReturnType<typeof vi.fn>
let copied: string[]

beforeEach(() => {
  copied = []
  exec = vi.fn(() => {
    const ta = document.activeElement as HTMLTextAreaElement
    copied.push(ta.value.slice(ta.selectionStart, ta.selectionEnd))
    return true
  })
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (document as { execCommand?: unknown }).execCommand
  document.body.innerHTML = ''
})

describe('copyText', () => {
  it('uses the clipboard where the page may', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('isSecureContext', true)
    expect(await copyText('abc')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('abc')
    expect(exec).not.toHaveBeenCalled()
  })

  it('copies the old way over plain http, and gives the focus back', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('isSecureContext', false)
    const btn = document.body.appendChild(document.createElement('button'))
    btn.focus()
    expect(await copyText('3f9b0d6e')).toBe(true)
    expect(copied).toEqual(['3f9b0d6e'])
    expect(exec).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  it('tries the old way when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } })
    vi.stubGlobal('isSecureContext', true)
    expect(await copyText('x')).toBe(true)
    expect(copied).toEqual(['x'])
  })

  it('says when neither copies', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('isSecureContext', false)
    exec.mockImplementation(() => false)
    expect(await copyText('x')).toBe(false)
    exec.mockImplementation(() => {
      throw new Error('no')
    })
    expect(await copyText('x')).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})
