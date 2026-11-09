import { describe, expect, it } from 'vitest'
import { formatArgv, parseArgv } from './argv'

describe('parseArgv', () => {
  it('splits words on spaces', () => {
    expect(parseArgv('claude --model opus')).toEqual(['claude', '--model', 'opus'])
    expect(parseArgv('  codex\t exec  ')).toEqual(['codex', 'exec'])
    expect(parseArgv('')).toEqual([])
    expect(parseArgv('   ')).toEqual([])
  })

  it('keeps spaces inside quotes, either kind', () => {
    expect(parseArgv(`aider --message "fix the tests" --yes`)).toEqual(['aider', '--message', 'fix the tests', '--yes'])
    expect(parseArgv(`echo 'it is "fine"'`)).toEqual(['echo', 'it is "fine"'])
    expect(parseArgv(`a"b c"d`)).toEqual(['ab cd'])
    expect(parseArgv(`x ""`)).toEqual(['x', ''])
  })

  it('leaves backslashes alone, for Windows paths', () => {
    expect(parseArgv(String.raw`C:\tools\claude.exe --dir "C:\Program Files"`)).toEqual([String.raw`C:\tools\claude.exe`, '--dir', String.raw`C:\Program Files`])
  })

  it('gives null for a quote left open', () => {
    expect(parseArgv(`echo "hi`)).toBeNull()
    expect(parseArgv(`echo 'hi`)).toBeNull()
  })
})

describe('formatArgv', () => {
  it('writes plain words as they are', () => {
    expect(formatArgv(['claude', '--model', 'opus'])).toBe('claude --model opus')
    expect(formatArgv([String.raw`C:\tools\x.exe`])).toBe(String.raw`C:\tools\x.exe`)
  })

  it('quotes what would not read back the same', () => {
    expect(formatArgv(['aider', '--message', 'fix the tests'])).toBe('aider --message "fix the tests"')
    expect(formatArgv(['', 'a'])).toBe('"" a')
  })

  it('reads back to the same words, quotes and all', () => {
    for (const a of [['echo', `it's`], ['echo', 'say "hi"'], ['x', `a"b'c d`], ['"'], [`'`], ['a b', '', 'c\td']]) {
      expect(parseArgv(formatArgv(a))).toEqual(a)
    }
  })
})
