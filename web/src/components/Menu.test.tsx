import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Confirm } from './Confirm'
import { Menu, type MenuItem } from './Menu'

afterEach(cleanup)

function menu(over: Partial<MenuItem>[] = []) {
  const picked: string[] = []
  const items: MenuItem[] = [
    { label: '파일 올리기', onSelect: () => picked.push('upload') },
    { label: '보기 전용', checked: false, onSelect: () => picked.push('observe') },
    { label: '종료', danger: true, onSelect: () => picked.push('kill') },
  ].map((it, i) => ({ ...it, ...over[i] }))
  render(
    <>
      <Menu label="더 보기" items={items} />
      <button type="button">밖</button>
    </>,
  )
  return { picked, btn: screen.getByRole('button', { name: '더 보기' }) }
}

const focused = () => document.activeElement?.textContent

describe('Menu', () => {
  it('opens on the first item and moves with the arrows', () => {
    const { btn } = menu()
    expect(btn.getAttribute('aria-haspopup')).toBe('menu')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    const list = screen.getByRole('menu', { name: '더 보기' })
    expect(btn.getAttribute('aria-controls')).toBe(list.id)
    expect(focused()).toBe('파일 올리기')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(focused()).toBe('보기 전용')
    fireEvent.keyDown(list, { key: 'End' })
    expect(focused()).toBe('종료')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(focused()).toBe('파일 올리기')
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(focused()).toBe('종료')
  })

  it('closes with Escape and gives the focus back', () => {
    const { btn } = menu()
    fireEvent.keyDown(btn, { key: 'ArrowUp' })
    expect(focused()).toBe('종료')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  it('runs an item and closes', () => {
    const { btn, picked } = menu([{}, { checked: true }])
    fireEvent.click(btn)
    const box = screen.getByRole('menuitemcheckbox', { name: '보기 전용' })
    expect(box.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: '종료' }))
    expect(picked).toEqual(['kill'])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  it('closes on a press elsewhere', () => {
    const { btn } = menu()
    fireEvent.click(btn)
    fireEvent.pointerDown(screen.getByRole('button', { name: '밖' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('shows what it is given in place of the icon', () => {
    render(<Menu label="호스트" trigger={<span>macmini</span>} items={[{ label: 'desk', onSelect: () => {} }]} />)
    const btn = screen.getByRole('button', { name: '호스트' })
    expect(btn.textContent).toBe('macmini')
    expect(btn.querySelector('svg')).toBeNull()
  })

  it('makes the checked items one choice of many', () => {
    const none = () => {}
    render(
      <Menu
        label="호스트"
        radio
        items={[
          { label: 'macmini', checked: true, onSelect: none },
          { label: 'desk', checked: false, onSelect: none },
          { label: '호스트 관리', onSelect: none },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '호스트' }))
    expect(screen.getAllByRole('menuitemradio').map((e) => [e.textContent, e.getAttribute('aria-checked')])).toEqual([
      ['macmini', 'true'],
      ['desk', 'false'],
    ])
    expect(screen.getByRole('menuitem', { name: '호스트 관리' })).toBeTruthy()
  })
})

describe('Confirm', () => {
  it('asks in a modal dialog and answers both ways', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(
      <Confirm open={false} title="이 세션을 종료할까요?" text="먼저 종료를 요청합니다." confirm="종료" danger onConfirm={onConfirm} onCancel={onCancel} />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<Confirm open title="이 세션을 종료할까요?" text="먼저 종료를 요청합니다." confirm="종료" danger onConfirm={onConfirm} onCancel={onCancel} />)
    const d = screen.getByRole('dialog', { name: '이 세션을 종료할까요?' })
    expect(d.getAttribute('aria-describedby')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '종료' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    fireEvent(d, new Event('cancel', { cancelable: true }))
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
    rerender(<Confirm open={false} title="이 세션을 종료할까요?" text="먼저 종료를 요청합니다." confirm="종료" danger onConfirm={onConfirm} onCancel={onCancel} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
