import { describe, expect, it } from 'vitest'
import { clock, commitTime, dayClock, duration, relTime } from './time'

// Local times, so the tests hold in any time zone.
const now = new Date(2026, 10, 9, 14, 12, 30).getTime()
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

describe('relTime', () => {
  it('counts minutes and hours within a day', () => {
    expect(relTime(now, now)).toBe('방금')
    expect(relTime(now - 59_000, now)).toBe('방금')
    expect(relTime(now + 5_000, now)).toBe('방금') // a clock a little ahead
    expect(relTime(now - 60_000, now)).toBe('1분 전')
    expect(relTime(now - 59 * 60_000, now)).toBe('59분 전')
    expect(relTime(now - 3_600_000, now)).toBe('1시간 전')
    expect(relTime(now - 23.9 * 3_600_000, now)).toBe('23시간 전')
  })

  it('names yesterday and the days of the week by the calendar', () => {
    expect(relTime(at(2026, 11, 8, 9, 0), now)).toBe('어제')
    expect(relTime(at(2026, 11, 7, 23, 59), now)).toBe('2일 전')
    expect(relTime(at(2026, 11, 3), now)).toBe('6일 전')
  })

  it('writes the date after a week, with the year when it differs', () => {
    expect(relTime(at(2026, 11, 2), now)).toBe('11월 2일')
    expect(relTime(at(2025, 12, 31), now)).toBe('2025년 12월 31일')
  })
})

describe('commitTime', () => {
  it('gives the clock and how long ago', () => {
    expect(commitTime(at(2026, 11, 9, 13, 2), now)).toBe('오늘 13:02 (1시간 전)')
    expect(commitTime(at(2026, 11, 9, 14, 12), now)).toBe('오늘 14:12 (방금)')
    expect(commitTime(at(2026, 11, 8, 23, 5), now)).toBe('어제 23:05 (15시간 전)')
    expect(commitTime(at(2026, 11, 8, 9, 5), now)).toBe('어제 09:05')
    expect(commitTime(at(2026, 11, 6, 8, 0), now)).toBe('11월 6일 08:00 (3일 전)')
    expect(commitTime(at(2026, 10, 1, 8, 0), now)).toBe('10월 1일 08:00')
    expect(commitTime(at(2024, 1, 5, 18, 30), now)).toBe('2024년 1월 5일 18:30')
  })

  it('writes hours and minutes with two digits', () => {
    expect(clock(at(2026, 1, 1, 7, 4))).toBe('07:04')
  })
})

describe('dayClock', () => {
  it('names the day and the clock', () => {
    expect(dayClock(at(2026, 11, 9, 9, 3), now)).toBe('오늘 09:03')
    expect(dayClock(at(2026, 11, 8, 23, 5), now)).toBe('어제 23:05')
    expect(dayClock(at(2026, 11, 2, 8, 0), now)).toBe('11월 2일 08:00')
  })
})

describe('duration', () => {
  it('counts whole minutes, then hours and minutes, then days', () => {
    expect(duration(0)).toBe('1분')
    expect(duration(59_000)).toBe('1분')
    expect(duration(12 * 60_000 + 59_000)).toBe('12분')
    expect(duration(60 * 60_000)).toBe('1시간')
    expect(duration(65 * 60_000)).toBe('1시간 5분')
    expect(duration(23 * 3_600_000 + 59 * 60_000)).toBe('23시간 59분')
    expect(duration(50 * 3_600_000)).toBe('2일')
  })
})
