import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LINE_HEIGHT, POWERLINE, POWERLINE_RANGE, powerlineFont, rowFit, type Fit } from './powerline'

const W = 600 // one cell of JetBrains Mono, in font units

// ---- reading the font back -------------------------------------------------

interface Table {
  offset: number
  length: number
  checksum: number
}

function tables(v: DataView): Map<string, Table> {
  const n = v.getUint16(4)
  const out = new Map<string, Table>()
  for (let i = 0; i < n; i++) {
    const r = 12 + 16 * i
    const tag = String.fromCharCode(v.getUint8(r), v.getUint8(r + 1), v.getUint8(r + 2), v.getUint8(r + 3))
    out.set(tag, { checksum: v.getUint32(r + 4), offset: v.getUint32(r + 8), length: v.getUint32(r + 12) })
  }
  return out
}

function sum(v: DataView, offset: number, length: number): number {
  let s = 0
  for (let i = 0; i < length; i += 4) {
    let word = 0
    for (let k = 0; k < 4; k++) word = word * 256 + (i + k < length ? v.getUint8(offset + i + k) : 0)
    s = (s + word) % 2 ** 32
  }
  return s
}

/** The glyph a code point maps to, read from the (3, 1) format 4 subtable. */
function glyphOf(v: DataView, cmap: number, cp: number): number {
  const n = v.getUint16(cmap + 2)
  let sub = -1
  for (let i = 0; i < n; i++) {
    const r = cmap + 4 + 8 * i
    if (v.getUint16(r) === 3 && v.getUint16(r + 2) === 1) sub = cmap + v.getUint32(r + 4)
  }
  if (sub < 0 || v.getUint16(sub) !== 4) throw new Error('no (3, 1) format 4 subtable')
  const segs = v.getUint16(sub + 6) / 2
  const ends = sub + 14
  const starts = ends + 2 * segs + 2
  const deltas = starts + 2 * segs
  const ranges = deltas + 2 * segs
  for (let i = 0; i < segs; i++) {
    if (cp > v.getUint16(ends + 2 * i)) continue
    if (cp < v.getUint16(starts + 2 * i)) return 0
    const ro = v.getUint16(ranges + 2 * i)
    if (ro === 0) return (cp + v.getInt16(deltas + 2 * i)) & 0xffff
    const g = v.getUint16(ranges + 2 * i + ro + 2 * (cp - v.getUint16(starts + 2 * i)))
    return g === 0 ? 0 : (g + v.getInt16(deltas + 2 * i)) & 0xffff
  }
  return 0
}

interface Glyph {
  box: [number, number, number, number]
  contours: { x: number; y: number; on: boolean }[][]
}

/** A simple glyph read as the TrueType spec describes it. */
function readGlyph(v: DataView, at: number, length: number): Glyph | null {
  if (length === 0) return null
  const nc = v.getInt16(at)
  if (nc < 0) throw new Error('composite glyph')
  const box: Glyph['box'] = [v.getInt16(at + 2), v.getInt16(at + 4), v.getInt16(at + 6), v.getInt16(at + 8)]
  const ends: number[] = []
  for (let i = 0; i < nc; i++) ends.push(v.getUint16(at + 10 + 2 * i))
  const count = ends[nc - 1] + 1
  let p = at + 10 + 2 * nc
  p += 2 + v.getUint16(p) // instructions
  const flags: number[] = []
  while (flags.length < count) {
    const f = v.getUint8(p++)
    flags.push(f)
    if (f & 8) for (let r = v.getUint8(p++); r > 0; r--) flags.push(f)
  }
  const coords = (short: number, same: number): number[] => {
    const out: number[] = []
    let c = 0
    for (const f of flags) {
      if (f & short) c += f & same ? v.getUint8(p++) : -v.getUint8(p++)
      else if (!(f & same)) {
        c += v.getInt16(p)
        p += 2
      }
      out.push(c)
    }
    return out
  }
  const xs = coords(2, 16)
  const ys = coords(4, 32)
  const contours: Glyph['contours'] = []
  let s = 0
  for (const e of ends) {
    const c = []
    for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 })
    contours.push(c)
    s = e + 1
  }
  return { box, contours }
}

interface Font {
  v: DataView
  t: Map<string, Table>
  glyph(cp: number): Glyph | null
  glyphs(): (Glyph | null)[]
}

function open(buf: ArrayBuffer): Font {
  const v = new DataView(buf)
  const t = tables(v)
  const at = (tag: string) => {
    const r = t.get(tag)
    if (!r) throw new Error(`no ${tag}`)
    return r.offset
  }
  const loca = (g: number) => v.getUint32(at('loca') + 4 * g)
  const byId = (g: number) => readGlyph(v, at('glyf') + loca(g), loca(g + 1) - loca(g))
  return {
    v,
    t,
    glyph: (cp) => byId(glyphOf(v, at('cmap'), cp)),
    glyphs: () => Array.from({ length: v.getUint16(at('maxp') + 4) }, (_, g) => byId(g)),
  }
}

// ---- drawing it ------------------------------------------------------------

type Pt = [number, number]

/** The outline as polygons, its quadratic curves cut into short lines. */
function polygons(g: Glyph | null): Pt[][] {
  if (!g) return []
  return g.contours.map((c) => {
    // put the implied on-curve point between two off-curve points
    const pts: { x: number; y: number; on: boolean }[] = []
    c.forEach((q, i) => {
      const r = c[(i + 1) % c.length]
      pts.push(q)
      if (!q.on && !r.on) pts.push({ x: (q.x + r.x) / 2, y: (q.y + r.y) / 2, on: true })
    })
    const k = pts.findIndex((q) => q.on)
    const ring = [...pts.slice(k), ...pts.slice(0, k)]
    const out: Pt[] = []
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      if (!a.on) continue
      out.push([a.x, a.y])
      const b = ring[(i + 1) % ring.length]
      if (b.on) continue
      const e = ring[(i + 2) % ring.length]
      for (let s = 1; s < 16; s++) {
        const u = s / 16
        out.push([
          (1 - u) ** 2 * a.x + 2 * u * (1 - u) * b.x + u ** 2 * e.x,
          (1 - u) ** 2 * a.y + 2 * u * (1 - u) * b.y + u ** 2 * e.y,
        ])
      }
    }
    return out
  })
}

/** The winding number of the outline around (x, y); TrueType fills where it is not 0. */
function winding(polys: Pt[][], x: number, y: number): number {
  let w = 0
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i]
      const [x1, y1] = p[(i + 1) % p.length]
      const left = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0)
      if (y0 <= y) {
        if (y1 > y && left > 0) w++
      } else if (y1 <= y && left < 0) w--
    }
  }
  return w
}

// ---- the rows the glyphs are drawn in --------------------------------------

// JetBrains Mono's ascent and descent as the canvas reports them, rounded.
const metrics = (size: number): [number, number] => [Math.round(1.02 * size), Math.round(0.3 * size)]
const fitFor = (size: number, dpr: number): Fit => rowFit(size, dpr, ...metrics(size))

// (x, y) is under the line through a and b (a left of b).
const under = (x: number, y: number, [x0, y0]: Pt, [x1, y1]: Pt) => y <= y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)

// The shape each solid separator stands for in the cell [0, W] x [b, t]: a
// cell edge it lies along continues past the cell, as the glyph does to
// meet its neighbour.
function solid(cp: number, { top: t, bottom: b }: Fit): (x: number, y: number) => boolean {
  const m = (t + b) / 2
  const r = (t - b) / 2
  const right = (x: number, y: number) => under(x, y, [0, t], [W, m]) && !under(x, y, [0, b], [W, m])
  const round = (x: number, y: number) => (x <= 0 ? Math.abs(y - m) <= r : (x / W) ** 2 + ((y - m) / r) ** 2 <= 1)
  switch (cp) {
    case 0xe0b0:
      return right
    case 0xe0b2:
      return (x, y) => right(W - x, y)
    case 0xe0b4:
      return round
    case 0xe0b6:
      return (x, y) => round(W - x, y)
    case 0xe0b8:
      return (x, y) => under(x, y, [0, t], [W, b])
    case 0xe0ba:
      return (x, y) => under(x, y, [0, b], [W, t])
    case 0xe0bc:
      return (x, y) => !under(x, y, [0, b], [W, t])
    case 0xe0be:
      return (x, y) => !under(x, y, [0, t], [W, b])
  }
  throw new Error(cp.toString(16))
}

// The cell edges each solid separator fills to the end, for the neighbour
// cell of its colour to meet without a seam.
const FLAT: Record<number, ('left' | 'right' | 'top' | 'bottom')[]> = {
  0xe0b0: ['left'],
  0xe0b2: ['right'],
  0xe0b4: ['left'],
  0xe0b6: ['right'],
  0xe0b8: ['left', 'bottom'],
  0xe0ba: ['right', 'bottom'],
  0xe0bc: ['left', 'top'],
  0xe0be: ['right', 'top'],
}

const hex = (cp: number) => cp.toString(16).toUpperCase()
const SOLID: [string, number][] = Object.keys(FLAT).map((k) => [hex(Number(k)), Number(k)])

const ROWS: [number, number][] = [
  [12, 1],
  [12, 2],
  [12, 3],
  [13, 2],
  [12, 2.625],
]

// ---- the tests -------------------------------------------------------------

describe('rowFit', () => {
  // Measured in Chrome and WebKit: the top and bottom edge of an xterm.js row
  // in font units from the baseline, with JetBrains Mono's ascent and descent.
  it.each([
    [12, 1, 12, 4, 1083, -417],
    [12, 2, 12, 4, 1083, -417],
    [12, 3, 12, 4, 1083, -444],
    [12, 2.2, 12, 4, 1083, -470],
    [13, 1, 13, 4, 1077, -385],
    [13, 2, 13, 4, 1077, -423],
    [13, 3, 13, 4, 1077, -410],
  ])('fits the row of %ipx text at %f dppx', (size, dpr, ascent, descent, top, bottom) => {
    const f = rowFit(size, dpr, ascent, descent)
    expect(f.top).toBeCloseTo(top, 0)
    expect(f.bottom).toBeCloseTo(bottom, 0)
    expect(f.px).toBeCloseTo(1000 / (size * dpr))
  })

  it('takes the line height xterm.js is given', () => {
    expect(LINE_HEIGHT).toBe(1.15)
    expect(rowFit(12, 2, 12, 4)).toEqual(rowFit(12, 2, 12, 4, LINE_HEIGHT))
    // without leading the row is the text: ascent above the baseline, descent below
    const f = rowFit(12, 1, 12, 4, 1)
    expect(f.top).toBeCloseTo(1000)
    expect(f.bottom).toBeCloseTo(-333.33)
  })
})

describe('powerlineFont', () => {
  const font = open(powerlineFont(fitFor(12, 2)))
  const { v, t } = font

  it('is a TrueType font with the tables a browser asks for, in order', () => {
    expect(v.getUint32(0)).toBe(0x00010000)
    expect([...t.keys()]).toEqual(['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post'])
    expect([v.getUint16(4), v.getUint16(6), v.getUint16(8), v.getUint16(10)]).toEqual([10, 128, 3, 32])
  })

  it('keeps each table on a four-byte boundary, inside the file, with its checksum', () => {
    expect(v.byteLength % 4).toBe(0)
    const head = t.get('head')!
    const adjustment = v.getUint32(head.offset + 8)
    for (const [tag, r] of t) {
      expect(r.offset % 4, tag).toBe(0)
      expect(r.offset + r.length, tag).toBeLessThanOrEqual(v.byteLength)
      const s = sum(v, r.offset, r.length)
      expect(tag === 'head' ? (s - adjustment + 2 ** 32) % 2 ** 32 : s, tag).toBe(r.checksum)
    }
    expect(sum(v, 0, v.byteLength)).toBe(0xb1b0afba)
  })

  it('has the head, hhea, OS/2 and post a monospace font of 1000 units has', () => {
    const head = t.get('head')!.offset
    expect(v.getUint32(head + 12)).toBe(0x5f0f3cf5)
    expect(v.getUint16(head + 18)).toBe(1000)
    expect(v.getInt16(head + 50)).toBe(1) // long loca offsets
    const hhea = t.get('hhea')!.offset
    expect([v.getInt16(hhea + 4), v.getInt16(hhea + 6), v.getInt16(hhea + 8)]).toEqual([1020, -300, 0])
    const os2 = t.get('OS/2')!.offset
    expect(v.getUint16(os2)).toBe(4)
    expect(v.getUint16(os2 + 4)).toBe(400)
    expect([v.getUint16(os2 + 64), v.getUint16(os2 + 66)]).toEqual([0xe0a0, 0xe0bf])
    // the glyphs run past the ascent to meet the row; no system may clip them there
    const [, yMin, , yMax] = [0, 2, 4, 6].map((k) => v.getInt16(head + 36 + k))
    expect(v.getUint16(os2 + 74)).toBeGreaterThanOrEqual(yMax)
    expect(v.getUint16(os2 + 76)).toBeGreaterThanOrEqual(-yMin)
    expect(v.getUint32(t.get('post')!.offset + 12)).toBe(1) // isFixedPitch
  })

  it('maps the Powerline code points and nothing else', () => {
    const cmap = t.get('cmap')!.offset
    const seen = new Set<number>()
    for (const cp of [0xe0a0, 0xe0a1, 0xe0a2, 0xe0a3]) seen.add(glyphOf(v, cmap, cp))
    for (let cp = 0xe0b0; cp <= 0xe0bf; cp++) seen.add(glyphOf(v, cmap, cp))
    expect(seen.size).toBe(20)
    expect(seen.has(0)).toBe(false)
    for (const cp of [0x20, 0x41, 0xe09f, 0xe0a4, 0xe0af, 0xe0c0, 0xf000]) expect(glyphOf(v, cmap, cp), cp.toString(16)).toBe(0)
  })

  it('gives every glyph the advance of one cell and its own left side bearing', () => {
    const n = v.getUint16(t.get('maxp')!.offset + 4)
    expect(n).toBe(21)
    expect(v.getUint16(t.get('hhea')!.offset + 34)).toBe(n)
    expect(t.get('hmtx')!.length).toBe(4 * n)
    expect(t.get('loca')!.length).toBe(4 * (n + 1))
    const loca = t.get('loca')!.offset
    for (let g = 0; g < n; g++) expect(v.getUint32(loca + 4 * (g + 1))).toBeGreaterThanOrEqual(v.getUint32(loca + 4 * g))
    expect(v.getUint32(loca + 4 * n)).toBeLessThanOrEqual(t.get('glyf')!.length)
    const glyphs = font.glyphs()
    glyphs.forEach((g, i) => {
      const hmtx = t.get('hmtx')!.offset + 4 * i
      expect(v.getUint16(hmtx)).toBe(W)
      expect(v.getInt16(hmtx + 2)).toBe(g ? g.box[0] : 0)
    })
    // maxp counts the largest glyph
    const maxp = t.get('maxp')!.offset
    const sizes = glyphs.filter((g) => g !== null).map((g) => g!.contours)
    expect(v.getUint16(maxp + 6)).toBe(Math.max(...sizes.map((c) => c.flat().length)))
    expect(v.getUint16(maxp + 8)).toBe(Math.max(...sizes.map((c) => c.length)))
  })

  it('states each glyph its own bounds', () => {
    for (const g of font.glyphs()) {
      if (!g) continue
      const pts = g.contours.flat()
      expect(g.box).toEqual([
        Math.min(...pts.map((p) => p.x)),
        Math.min(...pts.map((p) => p.y)),
        Math.max(...pts.map((p) => p.x)),
        Math.max(...pts.map((p) => p.y)),
      ])
    }
  })

  it('winds every outline clockwise, its holes the other way', () => {
    for (const g of font.glyphs()) {
      const polys = polygons(g)
      for (let x = -100; x <= 700; x += 20) {
        for (let y = -600; y <= 1300; y += 20) expect(winding(polys, x, y)).toBeLessThanOrEqual(0)
      }
    }
  })
})

describe.each(ROWS)('the separators in a row of %ipx text at %f dppx', (size, dpr) => {
  const fit = fitFor(size, dpr)
  const font = open(powerlineFont(fit))
  const { top: t, bottom: b, px } = fit
  const m = (t + b) / 2

  it.each(SOLID)('draws U+%s as the cell shape it stands for', (_, cp) => {
    const polys = polygons(font.glyph(cp))
    const want = solid(cp, fit)
    // a pixel above and below its slanted and curved edges, where the glyph
    // reaches past the row, and the rounding of its points
    const d = px + 4
    // however thin the shape is there, as at an arrow's tip
    const near = (x: number, y: number, w: boolean) => {
      for (let s = -d; s <= d; s += 4) if (want(x, y + s) !== w) return true
      return false
    }
    let checked = 0
    for (let x = 5; x < W; x += 10) {
      for (let y = b + 5; y < t; y += 10) {
        const w = want(x, y)
        if (near(x, y, w)) continue
        checked++
        expect(winding(polys, x, y) !== 0, `U+${cp.toString(16)} at ${x},${y.toFixed(0)}`).toBe(w)
      }
    }
    expect(checked).toBeGreaterThan(5000)
  })

  it.each(SOLID)('fills U+%s to its flat cell edges and past them', (_, cp) => {
    const polys = polygons(font.glyph(cp))
    const inside = (x: number, y: number) => winding(polys, x, y) !== 0
    for (const edge of FLAT[cp]) {
      // short of the corners, where a corner triangle's slant meets the edge
      for (let k = 1; k < 40; k++) {
        const y = b + ((t - b) * k) / 40
        const x = (W * k) / 40
        if (edge === 'left') expect(inside(0, y) && inside(-px / 2, y), `left ${y}`).toBe(true)
        if (edge === 'right') expect(inside(W, y) && inside(W + px / 2, y), `right ${y}`).toBe(true)
        if (edge === 'top') expect(inside(x, t), `top ${x}`).toBe(true)
        if (edge === 'bottom') expect(inside(x, b), `bottom ${x}`).toBe(true)
      }
    }
  })

  // The thin ones are lines from edge to edge of the row.
  const THIN = (
    [
      [0xe0b1, [[W - 10, m]]],
      [0xe0b3, [[10, m]]],
      [0xe0b5, [[W - 20, m]]],
      [0xe0b7, [[20, m]]],
      [0xe0b9, [[5, t - 5], [W - 5, b + 5]]],
      [0xe0bf, [[5, t - 5], [W - 5, b + 5]]],
      [0xe0bb, [[5, b + 5], [W - 5, t - 5]]],
      [0xe0bd, [[5, b + 5], [W - 5, t - 5]]],
    ] as [number, Pt[]][]
  ).map(([cp, through]): [string, number, Pt[]] => [hex(cp), cp, through])

  it.each(THIN)('draws U+%s as a thin line across the row', (_, cp, through) => {
    const polys = polygons(font.glyph(cp))
    const inside = (x: number, y: number) => winding(polys, x, y) !== 0
    for (const [x, y] of through) expect(inside(x, y), `${x},${y}`).toBe(true)
    const row = (y: number) => Array.from({ length: 61 }, (_, i) => inside(i * 10, y)).some(Boolean)
    expect(row(t), 'top').toBe(true)
    expect(row(b), 'bottom').toBe(true)
    let ink = 0
    let all = 0
    for (let x = 5; x < W; x += 10) {
      for (let y = b + 5; y < t; y += 10) {
        all++
        if (inside(x, y)) ink++
      }
    }
    expect(ink / all).toBeGreaterThan(0.05)
    expect(ink / all).toBeLessThan(0.3)
  })

  it('draws the icons inside the text, the same in every row', () => {
    const plain = open(powerlineFont(fitFor(13, 1)))
    for (const cp of [0xe0a0, 0xe0a1, 0xe0a2, 0xe0a3]) {
      const g = font.glyph(cp)!
      expect(g, cp.toString(16)).not.toBeNull()
      const [x0, y0, x1, y1] = g.box
      expect(x0).toBeGreaterThanOrEqual(0)
      expect(x1).toBeLessThanOrEqual(W)
      expect(y0).toBeGreaterThanOrEqual(-300)
      expect(y1).toBeLessThanOrEqual(1020)
      expect(g).toEqual(plain.glyph(cp))
      const polys = polygons(g)
      let ink = 0
      for (let x = 5; x < W; x += 10) for (let y = -295; y < 1020; y += 10) if (winding(polys, x, y) !== 0) ink++
      expect(ink, cp.toString(16)).toBeGreaterThan(200)
    }
  })
})

// ---- giving it to the page -------------------------------------------------

const FAMILY = "'JetBrains Mono', 'Mori Powerline', monospace"

class FakeFace {
  static made: FakeFace[] = []
  static fail = false
  status = 'unloaded'
  readonly bytes: Uint8Array
  constructor(
    readonly family: string,
    source: ArrayBuffer,
    readonly descriptors: FontFaceDescriptors,
  ) {
    this.bytes = new Uint8Array(source.slice(0))
    FakeFace.made.push(this)
  }
  async load(): Promise<this> {
    await Promise.resolve()
    if (FakeFace.fail) {
      this.status = 'error'
      throw new DOMException('bad font', 'SyntaxError')
    }
    this.status = 'loaded'
    return this
  }
}

class FakeFonts extends Set<FakeFace> {
  addedLoaded: boolean[] = []
  override add(f: FakeFace): this {
    this.addedLoaded.push(f.status === 'loaded')
    return super.add(f)
  }
}

let fonts: FakeFonts
let fontsSet: string[]
let canvasMetrics: Partial<TextMetrics>

class FakeCanvas {
  getContext() {
    return {
      set font(f: string) {
        fontsSet.push(f)
      },
      measureText: () => ({ width: 7.2, ...canvasMetrics }),
    }
  }
}

describe('loadPowerline', () => {
  let loadPowerline: (family: string, size: number) => Promise<void>

  beforeEach(async () => {
    vi.resetModules()
    ;({ loadPowerline } = await import('./powerline'))
    FakeFace.made = []
    FakeFace.fail = false
    fonts = new FakeFonts()
    fontsSet = []
    canvasMetrics = { fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4 }
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true })
    vi.stubGlobal('FontFace', FakeFace)
    vi.stubGlobal('OffscreenCanvas', FakeCanvas)
    vi.stubGlobal('devicePixelRatio', 2)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (document as { fonts?: unknown }).fonts
  })

  const same = (f: FakeFace, fit: Fit) => expect(f.bytes).toEqual(new Uint8Array(powerlineFont(fit)))

  it('does nothing where the page cannot make fonts', async () => {
    vi.stubGlobal('FontFace', undefined)
    await expect(loadPowerline(FAMILY, 12)).resolves.toBeUndefined()
    expect(fonts.size).toBe(0)
  })

  it('adds a loaded face fitted to the row of the text it measures', async () => {
    await loadPowerline(FAMILY, 12)
    expect(fontsSet).toEqual([`12px ${FAMILY}`])
    expect(FakeFace.made).toHaveLength(1)
    const [f] = FakeFace.made
    expect(f.family).toBe(POWERLINE)
    expect(f.descriptors).toMatchObject({ unicodeRange: POWERLINE_RANGE, weight: '100 900' })
    same(f, rowFit(12, 2, 12, 4))
    expect([...fonts]).toEqual([f])
    expect(fonts.addedLoaded).toEqual([true])
  })

  it('keeps the face while the row stays as it was', async () => {
    await loadPowerline(FAMILY, 12)
    await loadPowerline(FAMILY, 12)
    expect(FakeFace.made).toHaveLength(1)
    expect(fonts.size).toBe(1)
  })

  it('puts a new face in place of the old when the row changes', async () => {
    await loadPowerline(FAMILY, 12)
    vi.stubGlobal('devicePixelRatio', 3)
    await loadPowerline(FAMILY, 12)
    expect(FakeFace.made).toHaveLength(2)
    expect([...fonts]).toEqual([FakeFace.made[1]])
    same(FakeFace.made[1], rowFit(12, 3, 12, 4))
  })

  it('adds only the last face when calls overlap', async () => {
    const first = loadPowerline(FAMILY, 12)
    vi.stubGlobal('devicePixelRatio', 3)
    const second = loadPowerline(FAMILY, 12)
    await Promise.all([first, second])
    expect([...fonts]).toEqual([FakeFace.made.at(-1)])
    same([...fonts][0], rowFit(12, 3, 12, 4))
  })

  it("takes JetBrains Mono's metrics where the canvas reports none", async () => {
    canvasMetrics = {}
    await loadPowerline(FAMILY, 13)
    same(FakeFace.made[0], rowFit(13, 2, 13, 4))
  })

  it('leaves the page as it was when the face does not load', async () => {
    FakeFace.fail = true
    await expect(loadPowerline(FAMILY, 12)).resolves.toBeUndefined()
    expect(fonts.size).toBe(0)
  })
})

describe('followPixelRatio', () => {
  let followPixelRatio: (fn: () => void) => () => void
  let queries: { media: string; fire(): void; listening(): number }[]

  beforeEach(async () => {
    vi.resetModules()
    ;({ followPixelRatio } = await import('./powerline'))
    queries = []
    vi.stubGlobal('devicePixelRatio', 2)
    vi.stubGlobal('matchMedia', (media: string) => {
      const fns = new Set<() => void>()
      const q = {
        media,
        matches: true,
        addEventListener: (_: string, fn: () => void) => fns.add(fn),
        removeEventListener: (_: string, fn: () => void) => fns.delete(fn),
      }
      queries.push({ media, fire: () => [...fns].forEach((fn) => fn()), listening: () => fns.size })
      return q
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls back each time the pixel ratio changes', () => {
    const fn = vi.fn()
    followPixelRatio(fn)
    expect(queries.map((q) => q.media)).toEqual(['(resolution: 2dppx)'])
    vi.stubGlobal('devicePixelRatio', 3)
    queries[0].fire()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(queries.map((q) => q.media)).toEqual(['(resolution: 2dppx)', '(resolution: 3dppx)'])
    expect(queries[0].listening()).toBe(0)
    queries[1].fire()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('stops when told', () => {
    const fn = vi.fn()
    const stop = followPixelRatio(fn)
    stop()
    queries[0].fire()
    expect(fn).not.toHaveBeenCalled()
    expect(queries[0].listening()).toBe(0)
  })

  it('does nothing where the page has no media queries', () => {
    vi.stubGlobal('matchMedia', undefined)
    const fn = vi.fn()
    expect(() => followPixelRatio(fn)()).not.toThrow()
  })
})
