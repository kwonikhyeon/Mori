import { cleanup, fireEvent, render } from '@testing-library/preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Splitter, type SplitterProps } from './Splitter'

function setup(over: Partial<SplitterProps> = {}) {
  const onChange = vi.fn<(w: number) => void>()
  const onCommit = vi.fn<(w: number) => void>()
  const onReset = vi.fn<() => void>()
  const r = render(
    <Splitter label="사이드바 너비" value={380} min={280} max={560} dir={1} onChange={onChange} onCommit={onCommit} onReset={onReset} {...over} />,
  )
  return { el: r.getByRole('separator', { name: '사이드바 너비' }), onChange, onCommit, onReset }
}

afterEach(cleanup)

describe('Splitter', () => {
  it('says what it sizes and where it stands', () => {
    const { el } = setup({ controls: 'side' })
    expect(el.getAttribute('aria-orientation')).toBe('vertical')
    expect(el.getAttribute('aria-valuenow')).toBe('380')
    expect(el.getAttribute('aria-valuemin')).toBe('280')
    expect(el.getAttribute('aria-valuemax')).toBe('560')
    expect(el.getAttribute('aria-controls')).toBe('side')
    expect(el.tabIndex).toBe(0)
  })

  it('moves 16 px a key, 64 with Shift, and to an end with Home and End', () => {
    const { el, onChange, onCommit } = setup()
    fireEvent.keyDown(el, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith(396)
    expect(onCommit).toHaveBeenLastCalledWith(396)
    fireEvent.keyDown(el, { key: 'ArrowLeft', shiftKey: true })
    expect(onCommit).toHaveBeenLastCalledWith(316)
    fireEvent.keyDown(el, { key: 'Home' })
    expect(onCommit).toHaveBeenLastCalledWith(280)
    fireEvent.keyDown(el, { key: 'End' })
    expect(onCommit).toHaveBeenLastCalledWith(560)
  })

  it('leaves other keys alone and says nothing at an end', () => {
    const { el, onChange } = setup({ value: 560 })
    fireEvent.keyDown(el, { key: 'Tab' })
    fireEvent.keyDown(el, { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('turns the arrows round for a pane right of it', () => {
    const { el, onCommit } = setup({ dir: -1, value: 360, min: 300, max: 640 })
    fireEvent.keyDown(el, { key: 'ArrowLeft' })
    expect(onCommit).toHaveBeenLastCalledWith(376)
  })

  it('follows a drag within its limits and remembers where it ends', () => {
    const { el, onChange, onCommit } = setup()
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 100 })
    expect(document.documentElement.classList.contains('is-resizing')).toBe(true)
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 150 })
    expect(onChange).toHaveBeenLastCalledWith(430)
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 900 })
    expect(onChange).toHaveBeenLastCalledWith(560)
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 900 })
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(560)
    expect(document.documentElement.classList.contains('is-resizing')).toBe(false)
  })

  it('drags the other way for a pane right of it', () => {
    const { el, onCommit } = setup({ dir: -1, value: 360, min: 300, max: 640 })
    fireEvent.pointerDown(el, { pointerId: 2, button: 0, clientX: 800 })
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 760 })
    fireEvent.pointerUp(el, { pointerId: 2, clientX: 760 })
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(400)
  })

  it('saves nothing for a click and resets on a double click', () => {
    const { el, onCommit, onReset } = setup()
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 100 })
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 100 })
    fireEvent.dblClick(el)
    expect(onCommit).not.toHaveBeenCalled()
    expect(onReset).toHaveBeenCalledOnce()
  })
})
