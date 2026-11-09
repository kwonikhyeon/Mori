import { describe, expect, it } from 'vitest'
import { browserName, codeFromHash, deviceName, formatCode, normalizeCode, osName } from './pairing'

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
}

describe('normalizeCode', () => {
  it('reads a code as the server does', () => {
    expect(normalizeCode('k7qm-4tzp')).toBe('K7QM4TZP')
    expect(normalizeCode(' K7QM 4TZP ')).toBe('K7QM4TZP')
    expect(normalizeCode('oil1-0000')).toBe('0111' + '0000')
  })

  it('drops what cannot be in a code and stops at eight', () => {
    expect(normalizeCode('K7QM—4TZP!')).toBe('K7QM4TZP')
    expect(normalizeCode('K7QM4TZPXX')).toBe('K7QM4TZP')
  })
})

describe('formatCode', () => {
  it('writes the dash once four characters are in', () => {
    expect(formatCode('k7q')).toBe('K7Q')
    expect(formatCode('k7qm')).toBe('K7QM')
    expect(formatCode('k7qm4')).toBe('K7QM-4')
    expect(formatCode('K7QM4TZP')).toBe('K7QM-4TZP')
  })
})

describe('codeFromHash', () => {
  it('takes the code of a pairing link', () => {
    expect(codeFromHash('#code=K7QM-4TZP')).toBe('K7QM-4TZP')
    expect(codeFromHash('#/?code=k7qm4tzp')).toBe('K7QM-4TZP')
    expect(codeFromHash('#/t/t1')).toBe('')
    expect(codeFromHash('')).toBe('')
  })
})

describe('deviceName', () => {
  it('names the system and the browser', () => {
    expect(deviceName(UA.iphone, 5)).toBe('iPhone · Safari')
    expect(deviceName(UA.iphoneChrome, 5)).toBe('iPhone · Chrome')
    expect(deviceName(UA.ipadDesktop, 5)).toBe('iPad · Safari')
    expect(deviceName(UA.ipadDesktop, 0)).toBe('Mac · Safari')
    expect(deviceName(UA.macChrome, 0)).toBe('Mac · Chrome')
    expect(deviceName(UA.winEdge, 0)).toBe('Windows · Edge')
    expect(deviceName(UA.winFirefox, 0)).toBe('Windows · Firefox')
    expect(deviceName(UA.android, 5)).toBe('Android · Chrome')
  })

  it('falls back to what it knows', () => {
    expect(osName('curl/8.0')).toBe('')
    expect(browserName('curl/8.0')).toBe('')
    expect(deviceName('curl/8.0', 0)).toBe('새 기기')
  })
})
