import { describe, expect, it } from 'vitest'
import { attachNote, BLOCKED_KEYS, quotePath, screenText } from './termview'

describe('attachNote', () => {
  it('says why the screen is not live', () => {
    expect(attachNote('open', '')).toBeNull()
    expect(attachNote('closed', '')).toBeNull()
    expect(attachNote('connecting', '')).toMatchObject({ kind: 'info', title: '연결 중', late: true })
    expect(attachNote('waiting-core', '')).toMatchObject({ kind: 'warn', title: '코어 연결 중', spin: true })
    expect(attachNote('recovering', '')).toMatchObject({ kind: 'warn', title: '복구 대기', spin: true })
    expect(attachNote('reconnecting', '')).toMatchObject({ kind: 'info', title: '다시 연결하는 중', spin: true })
    expect(attachNote('gone', '')).toMatchObject({ kind: 'error', title: '터미널을 찾을 수 없습니다' })
    expect(attachNote('error', '크기가 맞지 않습니다')).toEqual({
      kind: 'error', title: '터미널을 열 수 없습니다', detail: '크기가 맞지 않습니다', spin: false, late: false,
    })
  })
})

describe('BLOCKED_KEYS', () => {
  it('answers with the keys the boards show', () => {
    expect(BLOCKED_KEYS.pc.map((k) => k.label)).toEqual(['1', '2', '3', 'Enter', 'Esc'])
    expect(BLOCKED_KEYS.phone.map((k) => k.label)).toEqual(['1', '2', '3', 'Esc'])
    expect(BLOCKED_KEYS.pc.map((k) => [k.bytes, k.name])).toEqual([
      ['1', '1'], ['2', '2'], ['3', '3'], ['\r', 'enter'], ['\x1b', 'esc'],
    ])
  })
})

describe('quotePath', () => {
  it('quotes a path with spaces for the shell', () => {
    expect(quotePath('/tmp/mori/a.png')).toBe('/tmp/mori/a.png')
    expect(quotePath('/tmp/mori/스크린샷 1.png')).toBe('"/tmp/mori/스크린샷 1.png"')
    expect(quotePath('C:\\Users\\me\\My Files\\a.txt')).toBe('"C:\\Users\\me\\My Files\\a.txt"')
  })
})

describe('screenText', () => {
  it('writes every line ending as the terminal expects', () => {
    expect(screenText('a\nb\r\nc')).toBe('a\r\nb\r\nc')
  })
})
