import { act, render, screen } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast, toasts } from '../lib/toast'
import { Toasts } from './Toasts'

// Fake clocks for every test, so no frame of one is left for the next.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  toasts.value = []
})

describe('Toasts', () => {
  it('is a landmark only while it holds notes, and no live region itself', () => {
    render(<Toasts />)
    expect(screen.queryByRole('region')).toBeNull()
    act(() => toast('복사했습니다'))
    const stack = screen.getByRole('region', { name: '알림' })
    expect(stack.getAttribute('aria-live')).toBeNull()
    expect(screen.getByRole('button', { name: '알림 닫기' })).toBeTruthy()
  })

  it('speaks a failure at once and any other note when the reader is idle', () => {
    toast('복사했습니다')
    toast('보내지 못했습니다', 'error')
    vi.advanceTimersToNextFrame()
    expect(document.querySelector('body > [role="status"][data-mori-live]')!.textContent).toBe('복사했습니다')
    expect(document.querySelector('body > [role="alert"][data-mori-live]')!.textContent).toBe('보내지 못했습니다')
  })
})
