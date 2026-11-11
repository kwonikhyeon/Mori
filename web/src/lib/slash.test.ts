import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { term } from '../../test/fixtures'
import { COMMON, commandsOf, forgetCommands, insert, isClaude, note, rank, RECENT_MAX, recent, slashAt, used } from './slash'
import type { CommandList, SlashCommand } from './types'

const cmd = (name: string, over: Partial<SlashCommand> = {}): SlashCommand => ({ name, desc: '', source: 'builtin', ...over })
const names = (cs: SlashCommand[]) => cs.map((c) => c.name)

beforeEach(() => localStorage.clear())

describe('rank', () => {
  const list = [
    cmd('add-dir'),
    cmd('clear', { aliases: ['reset', 'new'] }),
    cmd('compact'),
    cmd('context'),
    cmd('model'),
    cmd('review-pr', { source: 'project' }),
    cmd('Kit:deploy', { source: 'plugin' }),
    cmd('code-review', { source: 'plugin' }),
  ]

  it('puts the names a query starts before the ones that have it inside', () => {
    expect(names(rank(list, 'rev'))).toEqual(['review-pr', 'code-review'])
    expect(names(rank(list, 'REV'))).toEqual(['review-pr', 'code-review'])
  })

  it('takes a part after a ":" and an alias as the start of a name', () => {
    expect(names(rank(list, 'dep'))).toEqual(['Kit:deploy'])
    expect(names(rank(list, 'kit:d'))).toEqual(['Kit:deploy'])
    expect(names(rank(list, 'res'))).toEqual(['clear'])
  })

  it('puts the recent ones, then the common ones, first on an empty or one-letter query', () => {
    expect(names(rank(list, ''))).toEqual(['compact', 'clear', 'model', 'context', 'add-dir', 'review-pr', 'Kit:deploy', 'code-review'])
    expect(names(rank(list, '', ['review-pr', 'gone', 'model']))).toEqual([
      'review-pr', 'model', 'compact', 'clear', 'context', 'add-dir', 'Kit:deploy', 'code-review',
    ])
    // a recent alias brings its command
    expect(names(rank(list, 'c', ['new']))).toEqual(['clear', 'compact', 'context', 'code-review'])
    expect(names(rank(list, 'd'))).toEqual(['Kit:deploy', 'add-dir', 'model', 'code-review'])
    // from two letters on, only the query orders them
    expect(names(rank(list, 'co', ['context']))).toEqual(['compact', 'context', 'code-review'])
  })

  it('counts /btw among the common ones', () => {
    expect(COMMON).toContain('btw')
    expect(names(rank([...list, cmd('btw')], ''))).toEqual([
      'compact', 'clear', 'model', 'context', 'btw', 'add-dir', 'review-pr', 'Kit:deploy', 'code-review',
    ])
  })
})

describe('used', () => {
  it('reads the command a sent text names', () => {
    expect(used('/model sonnet')).toBe('model')
    expect(used('  /clear  ')).toBe('clear')
    expect(used('/Kit:deploy\nnow')).toBe('Kit:deploy')
  })

  it('takes a path or a plain text as no command', () => {
    expect(used('/Users/me/notes.md 읽어 줘')).toBeNull()
    expect(used('/')).toBeNull()
    expect(used('fix /compact')).toBeNull()
  })
})

describe('the recent commands', () => {
  it('keeps the newest first, once each, and only so many', () => {
    note('/model opus')
    note('just a message')
    note('/compact')
    note('/model')
    expect(recent()).toEqual(['model', 'compact'])
    for (let i = 0; i < RECENT_MAX + 2; i++) note(`/c${i}`)
    expect(recent()).toHaveLength(RECENT_MAX)
    expect(recent()[0]).toBe(`c${RECENT_MAX + 1}`)
  })

  it('reads what is not a list of names as none', () => {
    localStorage.setItem('mori.slashRecent', '{"model":1}')
    expect(recent()).toEqual([])
    localStorage.setItem('mori.slashRecent', '["model", 3, null, "clear"]')
    expect(recent()).toEqual(['model', 'clear'])
  })
})

describe('slashAt and insert', () => {
  it('sees a command being typed only at the start, up to the caret', () => {
    expect(slashAt('/', 1)).toEqual({ q: '', end: 1 })
    expect(slashAt('/mo', 3)).toEqual({ q: 'mo', end: 3 })
    expect(slashAt('/model rest', 3)).toEqual({ q: 'mo', end: 6 })
    expect(slashAt('/model rest', 8)).toBeNull()
    expect(slashAt('hi /mo', 6)).toBeNull()
    expect(slashAt('\n/mo', 4)).toBeNull()
  })

  it('puts the name in place of the word and the caret after its space', () => {
    expect(insert('/mo', 3, 'model')).toEqual({ text: '/model ', caret: 7 })
    expect(insert('/mod  sonnet', 4, 'model')).toEqual({ text: '/model sonnet', caret: 7 })
  })
})

describe('isClaude', () => {
  it('goes by what the program reports, else by its name', () => {
    expect(isClaude(term({ argv: ['/bin/zsh'], status: { state: 'idle', app: 'claude-code', kind: null, msg: '', progress: null, title: '' } }))).toBe(true)
    expect(isClaude(term({ argv: ['/Users/me/.local/bin/claude', '--resume'] }))).toBe(true)
    expect(isClaude(term({ argv: ['/bin/zsh'], foreground: { pid: 2, name: 'claude', argv: ['claude'], cwd: '/r' } }))).toBe(true)
    expect(isClaude(term({ argv: ['/bin/zsh'], foreground: { pid: 2, name: 'node', argv: ['node', '/usr/local/bin/claude'], cwd: '/r' } }))).toBe(true)
    expect(isClaude(term({ argv: ['/bin/zsh'], foreground: { pid: 2, name: 'zsh', argv: ['-zsh'], cwd: '/r' } }))).toBe(false)
    expect(isClaude(term({ argv: ['codex'] }))).toBe(false)
  })
})

describe('commandsOf', () => {
  const list = (partial = false): CommandList => ({ commands: [cmd('compact')], partial })

  afterEach(() => forgetCommands())

  it('asks a terminal once a minute', async () => {
    const get = vi.fn(async () => list())
    await commandsOf('', 't1', get, 0)
    await commandsOf('', 't1', get, 59_000)
    expect(get).toHaveBeenCalledTimes(1)
    await commandsOf('h_desk', 't1', get, 59_000) // another host's t1
    await commandsOf('', 't1', get, 60_000)
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('asks again soon after a partial list, and next time after a failure', async () => {
    const get = vi.fn(async () => list(true))
    await commandsOf('', 't1', get, 0)
    await commandsOf('', 't1', get, 4_000)
    await commandsOf('', 't1', get, 5_000)
    expect(get).toHaveBeenCalledTimes(2)
    const bad = vi.fn(async (): Promise<CommandList> => {
      throw new Error('down')
    })
    await expect(commandsOf('', 't2', bad, 0)).rejects.toThrow('down')
    await expect(commandsOf('', 't2', bad, 1)).rejects.toThrow('down')
    expect(bad).toHaveBeenCalledTimes(2)
  })
})
