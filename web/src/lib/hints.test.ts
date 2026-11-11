import { describe, expect, it } from 'vitest'
import { hintLine, readHints } from './hints'

const read = (s: string) => readHints(hintLine(s)!)
const labels = (s: string) => read(s).map((h) => h.label)

describe('hints', () => {
  it("reads a list's hint line", () => {
    const h = read('Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel')
    expect(h.map((x) => x.label)).toEqual(['고르기', '↑', '↓', '닫기'])
    expect(h.map((x) => x.key)).toEqual(['enter', 'up', 'down', 'esc'])
    expect(h[1].aria).toBe('위 화살표')
    expect(h.map((x) => x.move)).toEqual([false, true, true, false])
  })

  // A list where many can be chosen ticks with one key and submits with
  // another: one 고르기, on Enter, and the other key by its name.
  it('gives 고르기 to Enter alone', () => {
    expect(labels('Space to select · Enter to confirm · Esc to cancel')).toEqual(['Space · select', '고르기', '닫기'])
    const h = read('Space/Enter to select · Esc to cancel')
    expect(h.map((x) => [x.label, x.key])).toEqual([
      ['고르기', 'enter'],
      ['닫기', 'esc'],
    ])
  })

  // Claude Code's /model: Enter picks the model for new sessions as well.
  it('names Enter that sets the default', () => {
    expect(labels('Enter to set as default · s to use this session only · Esc to cancel')).toEqual(['기본으로 정하기', '이 세션만', '닫기'])
  })

  it('leaves out amend and notes', () => {
    expect(labels('Esc to cancel · Tab to amend')).toEqual(['닫기'])
  })

  it('spreads a modifier over a slash', () => {
    expect(hintLine('shift+←/→ to switch answers')![0].keys).toEqual(['shift+left', 'shift+right'])
    const h = read('shift+←/→ to switch answers')
    expect(h.map((x) => x.label)).toEqual(['이전 답', '다음 답'])
    expect(h.every((x) => x.move)).toBe(true)
  })

  it('puts a danger last', () => {
    const h = read('x to clear · c to copy · Esc to close')
    expect(h.map((x) => x.label)).toEqual(['복사', '닫기', 'x · clear'])
    expect(h.map((x) => !!x.danger)).toEqual([false, false, true])
    expect(h[0].copy).toBe(true)
  })

  it('names an unknown action in English', () => {
    expect(labels('f to fork')).toEqual(['f · fork'])
    const h = read('ctrl+e to explain')
    expect(h.map((x) => x.label)).toEqual(['Ctrl+E · explain'])
    expect(h[0].key).toBe('ctrl+e')
  })

  it('prefers esc for closing', () => {
    const h = read('Space, Enter or Esc to close')
    expect(h).toHaveLength(1)
    expect(h[0].key).toBe('esc')
  })

  it('maps scroll, effort and this session', () => {
    expect(labels('↑/↓ to scroll')).toEqual(['위로', '아래로'])
    expect(labels('←/→ to adjust effort')).toEqual(['노력 낮추기', '노력 높이기'])
    expect(labels('s to use this session only')).toEqual(['이 세션만'])
  })

  it('is not a hint line', () => {
    for (const s of ['Showing detailed transcript · ctrl+o to toggle', '⏵⏵ accept edits on (shift+tab to cycle)', 'Notes: press n to add notes', ''])
      expect(hintLine(s)).toBeNull()
  })
})
