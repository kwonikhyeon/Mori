import { describe, expect, it } from 'vitest'
import { SCREENS, toShot } from '../../test/screens'
import { isGrey, readBox, readMode } from './box'

const GREY = 'rgb:153,153,153'
const IDLE = SCREENS['box-idle']
const PROMPT = 3 // the ❯ line of the sample
// the sample with its ❯ line in place of the empty one, coloured cell by cell after "❯ "
const boxWith = (text: string, ink: (col: number) => string) =>
  toShot(IDLE.replace('\n❯ \n', `\n❯ ${text}\n`), 80, 'alternate', (y, x) => (y === PROMPT && x >= 2 ? ink(x - 2) : ''))

describe('readBox', () => {
  it('reads the box, the status lines and the mode line', () => {
    const b = readBox(toShot(IDLE))!
    expect(b.text).toBe('')
    expect(b.hint).toBe('')
    expect(b.status).toEqual(['Opus 5.5 │ ctx 17% │ Mori (main) │ ◑ xhigh', 'current ○○○○○○○○○○   6% ⟳ 4:00오전', 'weekly  ○○○○○○○○○○   1% ⟳ 11월 15, 1:00오후'])
    expect(b.mode).toEqual({ name: 'bypass permissions', label: '묻지 않음', extras: ['셸 1'] })
    // from the rule over the box to the last line written
    expect(b.top).toBe(2)
    expect(b.rows).toBe(7)
  })

  // Claude Code draws its hint grey, not dim (claude-input design §2.1).
  it('takes grey text for a hint', () => {
    const b = readBox(boxWith('describe a task for a new session', () => GREY))!
    expect(b.text).toBe('')
    expect(b.hint).toBe('describe a task for a new session')
  })

  // While the terminal has the focus, Claude Code draws its cursor on the hint's
  // first letter, inverted; that cell is no colour of the box's (spec §3 #249).
  it("takes a hint whose first letter is Claude Code's cursor", () => {
    const b = readBox(boxWith('run the tests', (x) => (x === 0 ? 'inverse' : GREY)))!
    expect(b.text).toBe('')
    expect(b.hint).toBe('run the tests')
    // typed text with the cursor on a letter is still text
    expect(readBox(boxWith('abc', (x) => (x === 1 ? 'inverse' : '')))!.text).toBe('abc')
  })

  // as 2.1.323 draws a suggestion: chalk's dim, its first letter the cursor while the terminal has the focus
  it('takes faint text for a hint', () => {
    expect(readBox(boxWith('run the tests', () => 'dim'))!.hint).toBe('run the tests')
    const b = readBox(boxWith('run the tests', (x) => (x === 0 ? 'inverse' : 'dim')))!
    expect(b.text).toBe('')
    expect(b.hint).toBe('run the tests')
    // faint and plain mixed is text
    expect(readBox(boxWith('ab', (x) => (x ? 'dim' : '')))!.text).toBe('ab')
  })

  it('takes default text for text', () => {
    const b = readBox(boxWith('abc', () => ''))!
    expect(b.text).toBe('abc')
    expect(b.hint).toBe('')
  })

  // Wrong, it errs toward text: the cover would hide what the next send carries.
  it('takes coloured or mixed text for text', () => {
    expect(readBox(boxWith('ultrathink', (x) => `rgb:${200 + x * 5},${100 - x * 7},${50 + x * 9}`))!.text).toBe('ultrathink')
    expect(readBox(boxWith('ab', (x) => (x ? 'rgb:102,102,102' : GREY)))!.text).toBe('ab')
    expect(readBox(boxWith('a한', (x) => (x ? '' : GREY)))!.text).toBe('a한')
  })

  it('reads a box of two lines', () => {
    const s = toShot(IDLE.replace('\n❯ \n', '\n❯ first\n  second\n'))
    const b = readBox(s)!
    expect(b.text).toBe('first\nsecond')
    expect(b.rows).toBe(8)
  })

  it('reads a box with no status line and no mode line', () => {
    const s = toShot(IDLE.split('\n').slice(0, 5).join('\n') + '\n')
    const b = readBox(s)!
    expect(b.status).toEqual([])
    expect(b.mode).toBeNull()
    expect(b.rows).toBe(3)
  })

  // A session with a name has it in the rule over the box: on a narrow
  // screen the rule's dashes are fewer than half its width.
  it('reads a box whose rule holds the session name', () => {
    const b = readBox(toShot(SCREENS['box-titled']))!
    expect(b).not.toBeNull()
    expect(b.text).toBe('')
    expect(b.mode?.label).toBe('묻지 않음')
    expect(b.status).toHaveLength(2)
    expect(b.rows).toBe(6)
  })

  it('is null for a window, or with no box', () => {
    expect(readBox(toShot(SCREENS.model))).toBeNull()
    expect(readBox(toShot('그냥 글\n둘째 줄\n'))).toBeNull()
  })
})

describe('readMode', () => {
  it('names the modes in words', () => {
    expect(readMode('⏸ plan mode on (shift+tab to cycle)')).toEqual({ name: 'plan mode', label: '계획', extras: [] })
    expect(readMode('⏵⏵ accept edits on (shift+tab to cycle)')?.label).toBe('편집 자동 허락')
    expect(readMode('⏵⏵ auto mode on')?.label).toBe('자동')
    expect(readMode('? for shortcuts')).toEqual({ name: '', label: '기본', extras: [] })
    expect(readMode('⏵⏵ zoom on')).toEqual({ name: 'zoom', label: 'zoom', extras: [] })
    expect(readMode('⏵⏵ bypass permissions on · 2 shells')?.extras).toEqual(['셸 2'])
    expect(readMode('current ○○○ 6%')).toBeNull()
    // a notice at the right of the line, with no "·" before it, stays
    expect(readMode('⏵⏵ accept edits on  Context left until auto-compact: 9%')?.extras).toEqual(['Context left until auto-compact: 9%'])
    expect(readMode('⏵⏵ bypass permissions on (shift+tab to cycle) · 1 shell')?.extras).toEqual(['셸 1'])
  })
})

describe('isGrey', () => {
  it('knows a grey', () => {
    expect(isGrey('rgb:153,153,153')).toBe(true)
    expect(isGrey('rgb:153,153,160')).toBe(true)
    expect(isGrey('rgb:153,153,170')).toBe(false)
    expect(isGrey('rgb:30,30,30')).toBe(false)
    expect(isGrey('p:8')).toBe(true)
    expect(isGrey('p:244')).toBe(true)
    expect(isGrey('p:2')).toBe(false)
    expect(isGrey('')).toBe(false)
  })
})
