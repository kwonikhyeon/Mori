import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTermFont, termFont } from '../lib/termfont'
import { TermFontField } from './TermFont'

const pressed = () =>
  within(screen.getByRole('group', { name: '터미널 글자 크기' }))
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent)

beforeEach(() => {
  localStorage.clear()
  resetTermFont()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetTermFont()
})

describe('TermFontField', () => {
  it('offers the sizes with the layout’s default pressed', () => {
    render(<TermFontField layout="pc" />)
    const sizes = within(screen.getByRole('group', { name: '터미널 글자 크기' })).getAllByRole('button')
    expect(sizes.map((b) => b.textContent)).toEqual(['10', '11', '12', '13', '14', '15', '16'])
    expect(pressed()).toEqual(['13'])
  })

  it('keeps a picked size for this device and forgets the default', () => {
    render(<TermFontField layout="pc" />)
    fireEvent.click(screen.getByRole('button', { name: '15' }))
    expect(pressed()).toEqual(['15'])
    expect(termFont.value).toEqual({ pc: 15 })
    expect(JSON.parse(localStorage.getItem('mori.font') ?? 'null')).toEqual({ pc: 15 })
    fireEvent.click(screen.getByRole('button', { name: '13' }))
    expect(pressed()).toEqual(['13'])
    expect(JSON.parse(localStorage.getItem('mori.font') ?? 'null')).toEqual({})
  })

  it('reads what was kept and leaves out a size it does not offer', () => {
    localStorage.setItem('mori.font', JSON.stringify({ pc: 40, phone: 14 }))
    resetTermFont()
    render(<TermFontField layout="pc" />)
    expect(pressed()).toEqual(['13'])
    cleanup()
    render(<TermFontField layout="phone" />)
    expect(pressed()).toEqual(['14'])
  })
})
