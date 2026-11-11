import { describe, expect, it } from 'vitest'
import { readStatus } from './status'

describe('readStatus', () => {
  it('cuts a line at its bars into chips', () => {
    expect(readStatus(['Opus 5.5 │ ✍️ 17% │ ⚡  Mori (main) │ ◑ xhigh'])).toEqual([
      { kind: 'chips', chips: ['Opus 5.5', '✍️ 17%', '⚡ Mori (main)', '◑ xhigh'] },
    ])
    expect(readStatus(['a | b'])).toEqual([{ kind: 'chips', chips: ['a', 'b'] }])
  })

  it('reads a line with a bar and a percent as a bar', () => {
    expect(readStatus(['current ○○○○○○○○○○   6% ⟳ 4:00오전', 'weekly  ●●●○○○○○○○  30% ⟳ 11월 15, 1:00오후'])).toEqual([
      { kind: 'bar', name: 'current', percent: 6, rest: '4:00오전' },
      { kind: 'bar', name: 'weekly', percent: 30, rest: '11월 15, 1:00오후' },
    ])
  })

  it('keeps any other line as it is', () => {
    expect(readStatus(['그냥 글', 'ctx 17%'])).toEqual([
      { kind: 'text', text: '그냥 글' },
      { kind: 'text', text: 'ctx 17%' },
    ])
  })
})
