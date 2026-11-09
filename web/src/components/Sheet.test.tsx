import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sheet, SheetHead } from './Sheet'

afterEach(cleanup)

function sheet(open: boolean, onClose: () => void) {
  return (
    <Sheet open={open} labelledBy="s-title" onClose={onClose}>
      <SheetHead id="s-title" title="고르기" onClose={onClose} />
      <input aria-label="경로" />
    </Sheet>
  )
}

describe('Sheet', () => {
  it('closes on Escape, on 닫기 and on a press outside', () => {
    const close = vi.fn()
    render(sheet(true, close))
    const d = screen.getByRole('dialog', { name: '고르기' }) as HTMLDialogElement
    expect(d.open).toBe(true)

    const esc = new Event('cancel', { cancelable: true })
    d.dispatchEvent(esc)
    // The owner closes it, so its state and the dialog agree.
    expect(esc.defaultPrevented).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    expect(close).toHaveBeenCalledTimes(2)

    fireEvent.pointerDown(d)
    fireEvent.click(d)
    expect(close).toHaveBeenCalledTimes(3)
  })

  it('stays open after a press that starts inside and ends outside', () => {
    const close = vi.fn()
    render(sheet(true, close))
    const d = screen.getByRole('dialog')
    fireEvent.pointerDown(screen.getByLabelText('경로'))
    fireEvent.click(d)
    expect(close).not.toHaveBeenCalled()
  })

  it('makes what it holds afresh each time it opens', () => {
    const close = vi.fn()
    const { rerender } = render(sheet(true, close))
    const field = screen.getByLabelText('경로') as HTMLInputElement
    fireEvent.input(field, { target: { value: '/Users/me' } })
    rerender(sheet(false, close))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText('경로')).toBeNull()
    rerender(sheet(true, close))
    expect((screen.getByLabelText('경로') as HTMLInputElement).value).toBe('')
  })
})
