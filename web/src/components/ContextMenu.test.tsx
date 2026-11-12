import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { pressBack } from '../../test/closewatcher'
import { closeContext, ContextMenuHost, onContext } from './ContextMenu'
import type { MenuItem } from './Menu'

afterEach(() => {
  act(() => closeContext())
  cleanup()
})

function region(items: MenuItem[] | (() => MenuItem[])) {
  const get = typeof items === 'function' ? items : () => items
  render(
    <>
      <button type="button">앞</button>
      <div data-testid="r" tabIndex={0} onContextMenu={onContext('줄', get)}>
        <span data-testid="in">안</span>
      </div>
      <ContextMenuHost />
    </>,
  )
  return screen.getByTestId('r')
}

const picked: string[] = []
const two = (): MenuItem[] => [
  { label: '열기', onSelect: () => picked.push('open') },
  { label: '지우기', danger: true, sep: true, onSelect: () => picked.push('rm') },
]

describe('ContextMenu', () => {
  it('opens at the cursor on a right-click, on its first item', () => {
    const r = region(two())
    const e = fireEvent.contextMenu(screen.getByTestId('in'), { button: 2, clientX: 40, clientY: 60 })
    expect(e).toBe(false) // the browser's menu does not open
    const m = screen.getByRole('menu', { name: '줄' })
    expect(m.classList.contains('ctx-menu')).toBe(true)
    expect(document.activeElement?.textContent).toBe('열기')
    // a line parts the runs, with no heading
    expect(m.querySelectorAll('[role="separator"]').length).toBe(1)
    expect(m.querySelector('.menu-heading')).toBeNull()
    expect(r).toBeTruthy()
  })

  it('runs an item, closes and gives the focus back', () => {
    picked.length = 0
    const r = region(two())
    r.focus()
    fireEvent.contextMenu(r, { button: 2 })
    fireEvent.click(screen.getByRole('menuitem', { name: '지우기' }))
    expect(picked).toEqual(['rm'])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(r)
  })

  it('closes with Escape, the back key, a press elsewhere and the wheel', () => {
    const r = region(two())
    const open = () => fireEvent.contextMenu(r, { button: 2 })
    open()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    open()
    act(() => {
      pressBack()
    })
    expect(screen.queryByRole('menu')).toBeNull()
    open()
    fireEvent.pointerDown(screen.getByRole('button', { name: '앞' }))
    expect(screen.queryByRole('menu')).toBeNull()
    open()
    fireEvent.wheel(screen.getByRole('button', { name: '앞' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('moves with the arrows, round the ends', () => {
    const r = region(two())
    fireEvent.contextMenu(r, { button: 2 })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement?.textContent).toBe('지우기')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('열기')
  })

  it('leaves the browser its menu with Shift, under a finger, or with nothing to offer', () => {
    const r = region(two())
    expect(fireEvent.contextMenu(r, { button: 2, shiftKey: true })).toBe(true)
    const touch = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 })
    Object.defineProperty(touch, 'pointerType', { value: 'touch' })
    expect(r.dispatchEvent(touch)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    cleanup()
    const none = region([])
    expect(fireEvent.contextMenu(none, { button: 2 })).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('lets the innermost region answer', () => {
    render(
      <>
        <div onContextMenu={onContext('바깥', () => [{ label: '바깥 것', onSelect: () => {} }])}>
          <div data-testid="inner" onContextMenu={onContext('안쪽', () => [{ label: '안쪽 것', onSelect: () => {} }])} />
        </div>
        <ContextMenuHost />
      </>,
    )
    fireEvent.contextMenu(screen.getByTestId('inner'), { button: 2 })
    expect(screen.getByRole('menu', { name: '안쪽' })).toBeTruthy()
    expect(screen.queryByRole('menu', { name: '바깥' })).toBeNull()
  })
})
