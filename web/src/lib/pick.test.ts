import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { SCREENS, cursorAt, toShot } from '../../test/screens'
import { DEPTH, NOTHING, look } from './pick'
import { shotOf } from './shot'

const seen = (text: string, cols?: number) => look(toShot(text, cols)).seen
const labels = (text: string, cols?: number) => seen(text, cols)?.options.map((o) => o.label)
const buttons = (text: string, cols?: number) => seen(text, cols)?.hints.map((h) => h.label)
const lines = (text: string) => text.replace(/\n$/, '').split('\n')
const join = (ls: string[]) => ls.join('\n') + '\n'

describe('look', () => {
  it('reads a question with a preview box', () => {
    const s = seen(SCREENS['ask-preview'])!
    expect(s.title).toBe('어떤 색으로 칠할까요?')
    expect(s.options.map((o) => o.n)).toEqual([1, 2])
    expect(s.cursor).toBe(1)
    expect(s.options[0].desc).toBe('(권장)')
    expect(buttons(SCREENS['ask-preview'])).toEqual(['고르기', '↑', '↓', '닫기'])
  })

  it('korean beside a preview box', () => {
    const got = labels(SCREENS['ask-preview'])!
    expect(got).toEqual(['파란 하늘색', '짙은 숲색'])
    for (const l of got) expect(l).not.toMatch(/[┌│└❯[]/)
  })

  it('reads a permission', () => {
    const s = seen(SCREENS.permission)!
    expect(s.title).toBe('Do you want to proceed?')
    expect(s.options.map((o) => o.label)).toEqual([
      'Yes',
      "Yes, and don't ask again for ls commands in /tmp/mori-sample",
      'No, and tell Claude what to do differently (esc)',
    ])
    expect(s.cursor).toBe(1)
    expect(buttons(SCREENS.permission)).toEqual(['닫기', 'Ctrl+E · explain'])
  })

  it('reads the model list', () => {
    const s = seen(SCREENS.model)!
    expect(s.title).toBe('Select model Switch between Claude models. Applies to this session and future sessions.')
    expect(s.options.map((o) => o.label)).toEqual(['Default (recommended)', 'Sonnet', 'Haiku'])
    expect(s.options.map((o) => o.mark)).toEqual(['current', '', ''])
    expect(s.options.map((o) => o.desc)).toEqual([
      'Opus 5.5 · Most capable for complex work',
      'Sonnet 5.5 · Best for everyday tasks',
      'Haiku 5.5 · Fastest for quick answers',
    ])
    expect(buttons(SCREENS.model)).toEqual(['고르기', '노력 낮추기', '노력 높이기', '이 세션만', '닫기'])
  })

  it('reads a long list', () => {
    const s = seen(SCREENS['long-list'])!
    expect(s.title).toBe('Pick a color theme')
    expect(s.options.map((o) => o.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(s.options[11].label).toBe('Rose')
  })

  it('reads a window with only a hint line', () => {
    const s = seen(SCREENS.btw)!
    expect(s.options).toEqual([])
    expect(s.title).toBe('')
    expect(s.cursor).toBe(0)
    expect(s.body).toBe(
      '/btw 빗금 목록은 어디서 읽어?\n\n빗금 목록은 서버가 주는 명령 목록을 읽습니다.\n' +
        '입력창에서 빗금을 치면 그 목록에서 고릅니다.\n고른 명령은 입력창에 들어갑니다.',
    )
    expect(buttons(SCREENS.btw)).toEqual(['위로', '아래로', '이전 답', '다음 답', '복사', 'f · fork', '닫기', 'x · clear'])
    expect(s.hints.find((h) => h.label === '복사')?.copy).toBe(true)
    expect(s.hints.at(-1)?.danger).toBe(true)
  })

  it('sees the input box while idle', () => {
    expect(look(toShot(SCREENS.idle))).toEqual({ seen: null, box: { top: 2, rows: 3 } })
  })

  it('no panel for an answer list', () => {
    const l = look(toShot(SCREENS['answer-list']))
    expect(l.seen).toBeNull()
    expect(l.box).not.toBeNull()
  })

  it('no panel for a typed list', () => {
    expect(seen(SCREENS['typed-list'])).toBeNull()
  })

  it('narrow-40', () => {
    const s = seen(SCREENS['narrow-40'], 40)!
    expect(s.options.map((o) => o.n)).toEqual([1, 2, 3])
    expect(s.options[1].label).toBe("Yes, and don't ask again for ls")
    expect(s.options[1].desc).toBe('commands in /tmp/mori-sample')
    expect(s.options[2].desc).toBe('differently (esc)')
    expect(buttons(SCREENS['narrow-40'], 40)).toEqual(['닫기', 'Ctrl+E · explain'])
  })

  it('sees the input box at its height', () => {
    for (const [name, rows] of [['box-empty', 3], ['box-text', 3], ['box-multiline', 5]] as const) {
      const l = look(toShot(SCREENS[name]))
      expect(l.seen, name).toBeNull()
      expect(l.box, name).toEqual({ top: 2, rows })
    }
  })

  it('gives the box at its buffer line', () => {
    const shot = { ...toShot(SCREENS.idle), top: 100 }
    expect(look(shot).box).toEqual({ top: 102, rows: 3 })
  })

  it('keeps the id and changes the sig when the cursor moves', () => {
    const a = seen(SCREENS.model)!
    const b = seen(cursorAt(SCREENS.model, 2))!
    expect(b.id).toBe(a.id)
    expect(b.sig).not.toBe(a.sig)
    expect(b.cursor).toBe(2)
  })

  it('tells one window from another', () => {
    expect(seen(SCREENS.model)!.id).not.toBe(seen(SCREENS.permission)!.id)
    expect(seen(SCREENS.btw)!.id).not.toBe(seen(SCREENS.model)!.id)
  })

  it('counts the rows from the title to the hint line', () => {
    expect(seen(SCREENS.model)!.rows).toBe(9)
    expect(seen(SCREENS.permission)!.rows).toBe(6)
    expect(seen(SCREENS.btw)!.rows).toBe(8)
  })

  it('needs a hint line', () => {
    expect(seen(join(lines(SCREENS.model).slice(0, -2)))).toBeNull()
  })

  // A list that fails a check is no list: the window still shows its hint
  // line, so it is read as a window with only a hint line (design §6.6).
  it('needs exactly one cursor', () => {
    expect(seen(SCREENS.model.replace('❯', ' '))?.options).toEqual([])
    expect(seen(SCREENS.model.replace('   2. Sonnet', ' ❯ 2. Sonnet'))?.options).toEqual([])
  })

  it('needs numbers without a gap', () => {
    expect(seen(join(lines(SCREENS.model).filter((l) => !l.includes('2. Sonnet'))))?.options).toEqual([])
  })

  it('needs two items at least', () => {
    const one = join(['─'.repeat(80), ' Pick one', '', ' ❯ 1. Only', '', ' Enter to select · Esc to cancel'])
    expect(seen(one)?.options).toEqual([])
    expect(buttons(one)).toEqual(['고르기', '닫기'])
  })

  it('needs the list near the bottom', () => {
    const fill = (n: number) => {
      const ls = lines(SCREENS.model)
      const blank = ls.indexOf('', 5)
      ls.splice(blank + 1, 0, ...Array.from({ length: n }, (_, i) => ` 덧붙인 줄 ${i + 1}`))
      return join(ls)
    }
    // ten lines below the last item, the hint lines among them
    expect(seen(fill(8))?.options).toHaveLength(3)
    expect(seen(fill(9))?.options).toEqual([])
  })

  it('reads checkbox marks', () => {
    const s = seen(
      join([
        '─'.repeat(80),
        ' Pick toppings',
        '',
        ' ❯ 1. [ ] Cheese',
        '   2. [x] Ham',
        '   3. ☐ Olive',
        '   4. [✔] Basil',
        '',
        ' Space to toggle · Enter to submit · Esc to cancel',
      ]),
    )!
    expect(s.options.map((o) => o.mark)).toEqual(['off', 'on', 'off', 'on'])
    expect(s.options.map((o) => o.label)).toEqual(['Cheese', 'Ham', 'Olive', 'Basil'])
  })

  it('reads hint lines stacked', () => {
    const s = join([
      '─'.repeat(80),
      ' Pick one',
      '',
      ' ❯ 1. One',
      '   2. Two',
      '',
      ' Enter to select · Esc to cancel',
      ' Tab to switch · ctrl+e to explain',
    ])
    expect(buttons(s)).toEqual(['고르기', '닫기', 'Tab · switch', 'Ctrl+E · explain'])
  })

  it('reads nothing on an empty screen', () => {
    expect(look(toShot('\n\n\n'))).toEqual(NOTHING)
    expect(DEPTH).toBe(40)
  })

  it('each sample reads the same through xterm', async () => {
    for (const [name, text] of Object.entries(SCREENS)) {
      const cols = name === 'narrow-40' ? 40 : 80
      const rows = lines(text).length
      const t = new Terminal({ cols, rows, allowProposedApi: true })
      t.loadAddon(new Unicode11Addon())
      t.unicode.activeVersion = '11'
      await new Promise<void>((r) => t.write(lines(text).join('\r\n'), r))
      expect(shotOf(t, rows).lines, name).toEqual(toShot(text, cols, 'normal').lines)
      t.dispose()
    }
    expect(Object.keys(SCREENS)).toHaveLength(12)
  })
})
