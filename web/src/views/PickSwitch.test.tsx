import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pickOn, resetPickPref } from '../lib/pickpref'
import { PickSwitch } from './PickSwitch'

const toggle = () => screen.getByRole('switch', { name: 'Claude Code 창 알아보기' }) as HTMLInputElement

beforeEach(() => {
  localStorage.clear()
  resetPickPref()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetPickPref()
})

describe('PickSwitch', () => {
  it('turns the windows off for this device', () => {
    render(<PickSwitch />)
    expect(toggle().checked).toBe(true)
    expect(pickOn.value).toBe(true)
    expect(document.getElementById(toggle().getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      '번호 목록과 안내 줄을 알아봐 입력창 위에 단추로 보여 줍니다. 끄면 터미널에서 고릅니다. 이 기기에만 적용됩니다.',
    )
    fireEvent.click(toggle())
    expect(toggle().checked).toBe(false)
    expect(pickOn.value).toBe(false)
    expect(localStorage.getItem('mori.pick')).toBe('false')
  })

  it('keeps the choice of this device, and reads anything but off as on', () => {
    localStorage.setItem('mori.pick', 'false')
    resetPickPref()
    render(<PickSwitch />)
    expect(toggle().checked).toBe(false)
    fireEvent.click(toggle())
    expect(pickOn.value).toBe(true)
    expect(localStorage.getItem('mori.pick')).toBe('true')
    localStorage.setItem('mori.pick', '"off"')
    resetPickPref()
    expect(pickOn.value).toBe(true)
  })
})
