import { describe, expect, it } from 'vitest'
import { COLORS, geom, graphWidth, isHead, laneWidth, laneX, MARGIN, PC, PHONE, rowPaths, rowSegs, segPath, tone, type Geom, type Seg } from './graph'
import type { Edge, LogCommit } from './types'

const e = (lane: number, color = lane): Edge => ({ lane, color })

function row(lane: number, up: Edge[], pass: Edge[], down: Edge[], color = lane): LogCommit {
  return { hash: 'h' + lane, parents: [], author: 'me', time_ms: 0, subject: '', refs: [], lane, color, up, pass, down }
}

// What the server lays out for a branch merged back (spec §3 #106):
//   A        merges C and B
//   | B      the branch
//   C |
//   D        where it began
const MERGE: LogCommit[] = [
  row(0, [], [], [e(0), e(1)]),
  row(1, [e(1)], [e(0)], [e(1)]),
  row(0, [e(0)], [e(1)], [e(0)]),
  row(0, [e(0), e(1)], [], []),
]

/** An octopus merge of n roots, read in the order the lanes free up. */
function octopus(n: number): LogCommit[] {
  const all = Array.from({ length: n }, (_, k) => e(k))
  const rows = [row(0, [], [], all)]
  for (let k = 1; k < n; k++) rows.push(row(k, [e(k)], all.filter((x) => x.lane === 0 || x.lane > k), []))
  rows.push(row(0, [e(0)], [], []))
  return rows
}

const ends = (segs: Seg[], g: Geom) =>
  segs
    .filter((s) => s.y2 === g.h)
    .map((s) => `${s.x2}/${s.color}`)
    .sort()
const starts = (segs: Seg[]) =>
  segs
    .filter((s) => s.y1 === 0)
    .map((s) => `${s.x1}/${s.color}`)
    .sort()

/** Every line that leaves a row's bottom edge goes on at the next row's top edge, and nothing else starts there. */
function expectJoined(rows: LogCommit[], g: Geom) {
  for (let i = 0; i + 1 < rows.length; i++) {
    expect(starts(rowSegs(rows[i + 1], g)), `row ${i + 1}`).toEqual([...new Set(ends(rowSegs(rows[i], g), g))])
  }
}

describe('laneX', () => {
  it('puts a lane in the middle of its column after the margin', () => {
    expect(laneX(0, 16)).toBe(MARGIN + 8)
    expect(laneX(2, 16)).toBe(MARGIN + 32 + 8)
    expect(laneX(1, 14)).toBe(MARGIN + 14 + 7)
  })
})

describe('laneWidth', () => {
  it('keeps the full width while the graph takes at most 40% of the row', () => {
    // 4 + 3·16 + 4 = 56 ≤ 0.4 · 600
    expect(laneWidth(3, 600, 16)).toBe(16)
    expect(laneWidth(1, 0, 14)).toBe(14) // before the row is measured
  })

  it('narrows the lanes to fit, but not below 6px', () => {
    // 0.4 · 358 = 143.2; (143.2 − 8) / 10 = 13.5
    expect(laneWidth(10, 358, 14)).toBe(13)
    expect(laneWidth(30, 358, 14)).toBe(6)
    expect(laneWidth(500, 1200, 16)).toBe(6)
  })
})

describe('graphWidth', () => {
  it('is the margins and the lanes', () => {
    expect(graphWidth(3, 16)).toBe(56)
    expect(graphWidth(3, 16, 900)).toBe(56)
  })

  it('cuts off the lanes past 60% of the row, which even the least width does not fit', () => {
    expect(graphWidth(200, 6, 900)).toBe(540)
    expect(graphWidth(200, 6, 358)).toBe(214)
  })
})

describe('geom', () => {
  it('has the row height and the dot of each size', () => {
    expect(geom(PC, 3, 900)).toEqual({ w: 16, h: 44, r: 4, ring: 7 })
    expect(geom(PHONE, 3, 358)).toEqual({ w: 14, h: 56, r: 5, ring: 9 })
  })

  it('shrinks the dot with the lanes', () => {
    const g = geom(PC, 200, 900)
    expect(g.w).toBe(6)
    expect(g.r).toBeLessThan(4)
    expect(g.r).toBeGreaterThanOrEqual(2)
    expect(g.ring).toBeLessThan(7)
  })
})

describe('rowSegs and segPath', () => {
  const g: Geom = { w: 16, h: 44, r: 4, ring: 7 }

  it('draws a line from above in the same lane straight down to the dot', () => {
    const [s] = rowSegs(row(0, [e(0)], [], []), g)
    expect(s).toEqual({ x1: 12, y1: 0, x2: 12, y2: 22, color: 0 })
    expect(segPath(s)).toBe('M12 0V22')
  })

  it('curves a line from another lane into the dot', () => {
    const [s] = rowSegs(row(0, [e(1)], [], []), g)
    expect(s).toEqual({ x1: 28, y1: 0, x2: 12, y2: 22, color: 1 })
    expect(segPath(s)).toBe('M28 0C28 11 12 11 12 22')
  })

  it('curves a line from the dot down to another lane', () => {
    const segs = rowSegs(row(0, [], [], [e(0), e(1, 3)]), g)
    expect(segs).toEqual([
      { x1: 12, y1: 22, x2: 12, y2: 44, color: 0 },
      { x1: 12, y1: 22, x2: 28, y2: 44, color: 3 },
    ])
    expect(segPath(segs[1])).toBe('M12 22C12 33 28 33 28 44')
  })

  it('draws a line going by as one straight line through the row', () => {
    const [s] = rowSegs(row(0, [], [e(2)], []), g)
    expect(s).toEqual({ x1: 44, y1: 0, x2: 44, y2: 44, color: 2 })
    expect(segPath(s)).toBe('M44 0V44')
  })

  it('draws the lines going by first, so the ones meeting the dot lie on top', () => {
    const segs = rowSegs(row(1, [e(1)], [e(0)], [e(1)]), g)
    expect(segs.map((s) => s.y1 === 0 && s.y2 === g.h)).toEqual([true, false, false])
  })

  it('keeps the colour of the line, which the palette cycles through', () => {
    const [s] = rowSegs(row(0, [e(0, 7)], [], []), g)
    expect(s.color).toBe(7)
    expect(COLORS).toBe(5)
    expect([0, 4, 5, 7, 12].map(tone)).toEqual([0, 4, 0, 2, 2])
  })

  it('writes half pixels when an odd lane width puts a lane between them', () => {
    const odd: Geom = { w: 13, h: 56, r: 4, ring: 7 }
    const [s] = rowSegs(row(0, [e(1)], [], []), odd)
    expect(s.x1).toBe(MARGIN + 13 + 6.5)
    expect(segPath(s)).toBe('M23.5 0C23.5 14 10.5 14 10.5 28')
  })
})

describe('rowPaths', () => {
  it('joins the lines of a colour into one path, those going by under the rest', () => {
    const g: Geom = { w: 16, h: 44, r: 4, ring: 7 }
    const c = row(1, [e(1), e(2, 6)], [e(0), e(3, 5)], [e(1)])
    expect(rowPaths(c, g)).toEqual([
      { tone: 0, d: 'M12 0V44M60 0V44' },
      { tone: 1, d: 'M28 0V22M44 0C44 11 28 11 28 22M28 22V44' },
    ])
  })
})

describe('rows join', () => {
  it('at the full lane width', () => {
    expectJoined(MERGE, geom(PC, 2, 900))
    expectJoined(MERGE, geom(PHONE, 2, 358))
  })

  it('when many lanes narrow, oddly or to the least', () => {
    const ten = octopus(10)
    const g13 = geom(PHONE, 10, 358)
    expect(g13.w).toBe(13)
    expectJoined(ten, g13)
    const forty = octopus(40)
    const g6 = geom(PC, 40, 700)
    expect(g6.w).toBe(6)
    expectJoined(forty, g6)
  })
})

describe('isHead', () => {
  const at = (refs: LogCommit['refs']) => ({ ...row(0, [], [], []), refs })
  it('is the commit HEAD is on: a detached HEAD or the branch it points to', () => {
    expect(isHead(at([{ name: 'HEAD', kind: 'head', current: false }]))).toBe(true)
    expect(isHead(at([{ name: 'main', kind: 'branch', current: true }]))).toBe(true)
  })

  it('is not any other branch, remote or tag', () => {
    expect(isHead(at([]))).toBe(false)
    expect(
      isHead(
        at([
          { name: 'feature', kind: 'branch', current: false },
          { name: 'origin/main', kind: 'remote', current: false },
          { name: 'v1', kind: 'tag', current: false },
        ]),
      ),
    ).toBe(false)
  })
})
