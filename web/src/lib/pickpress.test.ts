import { describe, expect, it } from 'vitest'
import { CHAT, cursorAt, SCREENS, toShot } from '../../test/screens'
import { look, NOTHING, type Look, type Seen } from './pick'
import { choose, CLOSE_MS, closeFor, reach, SEE_MS, tap, type Press } from './pickpress'

const at = (text: string): Look => look(toShot(text))
const model = at(SCREENS.model)
const model2 = at(cursorAt(SCREENS.model, 2))
const model3 = at(cursorAt(SCREENS.model, 3))
// redrawn in a terminal the panel cut, without its title
const cut = at(SCREENS.model.split('\n').slice(3).join('\n'))
const chat = at(CHAT) // the cursor on "Chat about this", below the items
const perm = at(SCREENS.permission)
const long = at(SCREENS['long-list'])
const long10 = at(cursorAt(SCREENS['long-list'], 10))
const idle = at(SCREENS.idle) // the input box, and no window

/**
 * A Press on a screen moved by hand: each key it sends shows the next look
 * of then, and a wait passes or fails on what shows at once.
 */
function fake(first: Look, ...then: Look[]) {
  let shown = first
  const sent: string[] = []
  const waited: number[] = []
  const step = () => {
    shown = then.shift() ?? shown
  }
  const p: Press = {
    now: () => shown,
    wait: async (test, ms) => {
      waited.push(ms)
      return test(shown) ? shown : null
    },
    move: async (names) => {
      sent.push(`move ${names.join(' ')}`)
      step()
    },
    answer: async (name) => {
      sent.push(`answer ${name}`)
      step()
    },
  }
  return { p, sent, waited }
}

describe('choose', () => {
  it('answers a blocked window by its number', async () => {
    const f = fake(perm)
    expect(await choose(f.p, perm.seen!, 2, true)).toBe(true)
    expect(f.sent).toEqual(['answer 2'])
    expect(f.waited).toEqual([])
  })

  it('moves, sees the cursor land, then sends Enter', async () => {
    const f = fake(model, model3)
    expect(await choose(f.p, model.seen!, 3, false)).toBe(true)
    expect(f.sent).toEqual(['move down down', 'answer enter'])
    expect(f.waited).toEqual([SEE_MS])
  })

  it('moves up to an item above the cursor', async () => {
    const f = fake(model3, model)
    expect(await choose(f.p, model3.seen!, 1, false)).toBe(true)
    expect(f.sent).toEqual(['move up up', 'answer enter'])
  })

  it('sends only Enter for the item under the cursor', async () => {
    const f = fake(model)
    expect(await choose(f.p, model.seen!, 1, false)).toBe(true)
    expect(f.sent).toEqual(['answer enter'])
  })

  it('moves to an item past 9 of a blocked window, then answers with Enter', async () => {
    const f = fake(long, long10)
    expect(await choose(f.p, long.seen!, 10, true)).toBe(true)
    expect(f.sent).toEqual([`move ${Array(9).fill('down').join(' ')}`, 'answer enter'])
  })

  it('sends no Enter when the cursor does not land', async () => {
    const f = fake(model) // the screen stays as it was
    expect(await choose(f.p, model.seen!, 3, false)).toBe(false)
    expect(f.sent).toEqual(['move down down'])
    expect(f.waited).toEqual([SEE_MS])
  })

  it('sends no Enter when another window shows with its cursor there', async () => {
    const f = fake(model, at(cursorAt(SCREENS.permission, 3)))
    expect(await choose(f.p, model.seen!, 3, false)).toBe(false)
    expect(f.sent).toEqual(['move down down'])
  })

  it('sends nothing when the window changed', async () => {
    const f = fake(model2)
    expect(await choose(f.p, model.seen!, 3, false)).toBe(false)
    expect(await choose(f.p, model.seen!, 2, true)).toBe(false)
    expect(f.sent).toEqual([])
  })

  it('sees the cursor land when the title comes back', async () => {
    const f = fake(cut, model3)
    expect(await choose(f.p, cut.seen!, 3, false)).toBe(true)
    expect(f.sent).toEqual(['move down down', 'answer enter'])
  })

  // Moving counts from the item under the cursor; on a row without a number
  // there is none to count from, and only a number reaches an item.
  it('chooses from a row without a number only by the number', async () => {
    expect(reach(chat.seen!, 2, false)).toBe(false)
    expect(reach(chat.seen!, 2, true)).toBe(true)
    expect(reach(model.seen!, 3, false)).toBe(true)
    const f = fake(chat)
    expect(await choose(f.p, chat.seen!, 2, false)).toBe(false)
    expect(f.sent).toEqual([])
    expect(await choose(f.p, chat.seen!, 2, true)).toBe(true)
    expect(f.sent).toEqual(['answer 2'])
  })

  it('only moves in a list where many can be chosen', async () => {
    const many: Seen = { ...model.seen!, sig: 'many', options: model.seen!.options.map((o, i) => ({ ...o, mark: i ? 'off' : 'on' })) }
    const f = fake({ seen: many, box: null })
    expect(await choose(f.p, many, 3, true)).toBe(true)
    expect(f.sent).toEqual(['move down down'])
    expect(f.waited).toEqual([])
  })
})

describe('tap', () => {
  const hint = (label: string) => model.seen!.hints.find((h) => h.label === label)!

  it('moves with a key that moves', async () => {
    const f = fake(model)
    expect(await tap(f.p, model.seen!, hint('노력 낮추기'))).toBe(true)
    expect(f.sent).toEqual(['move left'])
  })

  it('answers with any other key', async () => {
    const f = fake(model)
    expect(await tap(f.p, model.seen!, hint('고르기'))).toBe(true)
    expect(f.sent).toEqual(['answer enter'])
  })

  it('sends nothing when the window changed', async () => {
    const f = fake(model2)
    expect(await tap(f.p, model.seen!, hint('고르기'))).toBe(false)
    expect(f.sent).toEqual([])
  })
})

describe('closeFor', () => {
  it('sends Esc and waits for the input box', async () => {
    const f = fake(model, idle)
    expect(await closeFor(f.p, model.seen!)).toBe(true)
    expect(f.sent).toEqual(['answer esc'])
    expect(f.waited).toEqual([CLOSE_MS])
  })

  it('says so when the window stays', async () => {
    const f = fake(model)
    expect(await closeFor(f.p, model.seen!)).toBe(false)
    expect(f.sent).toEqual(['answer esc'])
  })

  it('only waits for the box when the window already went', async () => {
    const f = fake(idle)
    expect(await closeFor(f.p, model.seen!)).toBe(true)
    expect(f.sent).toEqual([])
    expect(f.waited).toEqual([CLOSE_MS])
    // half drawn, with no box yet: not closed
    const g = fake(NOTHING)
    expect(await closeFor(g.p, model.seen!)).toBe(false)
    expect(g.sent).toEqual([])
  })

  it('sends nothing when the window changed', async () => {
    const f = fake(model2)
    expect(await closeFor(f.p, model.seen!)).toBe(false)
    expect(f.sent).toEqual([])
  })
})

it('waits 1.5s for a cursor and 2s for a window to close', () => {
  expect([SEE_MS, CLOSE_MS]).toEqual([1500, 2000])
})
