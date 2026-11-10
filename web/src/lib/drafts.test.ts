import { beforeEach, describe, expect, it } from 'vitest'
import { draftKey, loadDraft, saveDraft } from './drafts'

const DAY = 24 * 3_600_000

beforeEach(() => {
  localStorage.clear()
})

describe('drafts', () => {
  it('keeps each terminal of each host apart', () => {
    saveDraft(draftKey('', 't1'), 'on the hub', 1000)
    saveDraft(draftKey('h2', 't1'), 'on another host', 1000)
    expect(loadDraft(draftKey('', 't1'), 2000)).toBe('on the hub')
    expect(loadDraft(draftKey('h2', 't1'), 2000)).toBe('on another host')
    expect(loadDraft(draftKey('', 't2'), 2000)).toBe('')
  })

  it('forgets a draft when it is emptied, and after a week', () => {
    const k = draftKey('', 't1')
    saveDraft(k, 'x', 0)
    saveDraft(k, '', 1)
    expect(loadDraft(k, 2)).toBe('')
    saveDraft(k, 'old', 0)
    saveDraft(draftKey('', 't2'), 'new', 6 * DAY)
    expect(loadDraft(k, 7 * DAY - 1)).toBe('old')
    expect(loadDraft(k, 7 * DAY)).toBe('')
    // a save drops what has run out
    saveDraft(draftKey('', 't3'), 'z', 7 * DAY)
    expect(Object.keys(JSON.parse(localStorage.getItem('mori.drafts')!))).toEqual([draftKey('', 't2'), draftKey('', 't3')])
  })

  it('reads past what it did not write', () => {
    localStorage.setItem('mori.drafts', '{"a":{"text":3,"at":1},"b":null,"c":{"text":"ok","at":1}}')
    expect(loadDraft('a', 2)).toBe('')
    expect(loadDraft('c', 2)).toBe('ok')
    localStorage.setItem('mori.drafts', '[1,2')
    expect(loadDraft('c', 2)).toBe('')
  })
})
