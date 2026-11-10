// Shell prompts such as agnoster draw their segments with the Powerline
// glyphs, U+E0A0–E0A3 and U+E0B0–E0BF. A font draws them at one height, but
// a row of xterm.js is taller than its text by a leading that changes with
// the text's size and the pixel ratio, so a bundled font's arrows would stop
// short of the row and leave seams. This font is made for the row it is
// drawn in: its separators run a device pixel past the row's top and bottom,
// and the row cuts them off (spec §3 #176). It is a TrueType font built in
// memory; a FontFace made from bytes fetches nothing, so the page's CSP,
// which lets no font in from a data: or blob: URL, has nothing to stop.

export const POWERLINE = 'Mori Powerline'
export const POWERLINE_RANGE = 'U+E0A0-E0A3, U+E0B0-E0BF'

/** The line height the terminal is opened with. */
export const LINE_HEIGHT = 1.15

/** A row of the terminal in font units, 1000 to the em, from the baseline:
 * where its top and bottom are, and how many units one device pixel is. */
export interface Fit {
  top: number
  bottom: number
  px: number
}

/**
 * The row xterm.js lays out for text of `size` CSS pixels at `dpr` device
 * pixels to the CSS pixel, from the font's ascent and descent as xterm.js
 * measures them. xterm.js rounds the text's height up to device pixels and
 * the row's height down; the browser puts half the leading above the text,
 * rounded down to a CSS pixel.
 */
export function rowFit(size: number, dpr: number, ascent: number, descent: number, lineHeight = LINE_HEIGHT): Fit {
  const char = Math.ceil((ascent + descent) * dpr)
  const row = Math.floor(char * lineHeight) / dpr
  const above = ascent + Math.floor((row - ascent - descent) / 2)
  const unit = 1000 / size
  return { top: above * unit, bottom: -(row - above) * unit, px: unit / dpr }
}

// ---- the outlines ----------------------------------------------------------

/** A point in font units; the third element marks one off the curve. */
type P = [x: number, y: number, off?: boolean]

const W = 600 // the advance of JetBrains Mono: one cell
const STROKE = 90 // the line of the thin separators

const side = (a: P, b: P, q: P) => (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])

/** The part of polygon p to the left of the line from a through b. */
function cut(p: P[], a: P, b: P): P[] {
  const out: P[] = []
  p.forEach((q, i) => {
    const r = p[(i + 1) % p.length]
    const sq = side(a, b, q)
    const sr = side(a, b, r)
    if (sq >= 0) out.push(q)
    if (sq >= 0 !== sr >= 0) {
      const k = sq / (sq - sr)
      out.push([q[0] + k * (r[0] - q[0]), q[1] + k * (r[1] - q[1])])
    }
  })
  return out
}

const area = (c: P[]) => c.reduce((s, q, i) => s + q[0] * c[(i + 1) % c.length][1] - c[(i + 1) % c.length][0] * q[1], 0)

// TrueType fills to the right of the way a contour runs: clockwise around
// ink, the other way around a hole.
const cw = (c: P[]): P[] => (area(c) > 0 ? [...c].reverse() : c)
const ccw = (c: P[]): P[] => (area(c) < 0 ? [...c].reverse() : c)
const flip = (g: P[][]): P[][] => g.map((c) => c.map(([x, y, off]): P => [W - x, y, off]).reverse())

const K = 1 / Math.cos(Math.PI / 8)

/** An ellipse's arc from angle a0 to a1 in degrees, as quadratic curves of
 * 45° each: every on-curve point and the off-curve point after it, short of
 * the end, which the caller puts next. */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): P[] {
  const step = a1 > a0 ? 45 : -45
  const at = (deg: number, k: number, off?: boolean): P => {
    const r = (deg * Math.PI) / 180
    return [cx + rx * k * Math.cos(r), cy + ry * k * Math.sin(r), off]
  }
  const out: P[] = []
  for (let a = a0; a !== a1; a += step) out.push(at(a, 1), at(a + step / 2, K, true))
  return out
}

/** The separators U+E0B0–E0BF, fitted to the row. */
function separators({ top: t, bottom: b, px }: Fit): P[][][] {
  // A device pixel past the row on every side, which the row and the cells
  // beside it cover, so that a separator meets its neighbours without a seam.
  const T = t + px
  const B = b - px
  const m = (t + b) / 2
  const box: P[] = [[-px, B], [W + px, B], [W + px, T], [-px, T]]
  const arrow = [cw(cut(cut(box, [W, m], [0, T]), [0, B], [W, m]))]
  const h = (STROKE * Math.hypot(W, T - m)) / (T - m)
  const chevron = [cw([[h, T], [W, m], [h, B], [0, B], [W - h, m], [0, T]])]
  const ry = (T - B) / 2
  const half: P[][] = [[[-px, T], ...arc(0, m, W, ry, 90, -90), [0, B], [-px, B]]]
  const bow: P[][] = [
    [...arc(0, m, W, ry, 90, -90), [0, B], ...arc(0, m, W - STROKE, ry - STROKE, -90, 90), [0, T - STROKE]],
  ]
  // The corner triangles and the slashes run from corner to corner of the
  // row itself, for the rows above and below to carry the line on.
  const corner = (a: P, c: P) => [cw(cut(box, a, c))]
  const h2 = (STROKE * Math.hypot(W, t - b)) / (t - b)
  const back = [cw(cut(cut(box, [W + h2 / 2, b], [h2 / 2, t]), [-h2 / 2, t], [W - h2 / 2, b]))]
  const slash = [cw(cut(cut(box, [h2 / 2, b], [W + h2 / 2, t]), [W - h2 / 2, t], [-h2 / 2, b]))]
  return [
    arrow, chevron, flip(arrow), flip(chevron), // E0B0–E0B3
    half, bow, flip(half), flip(bow), // E0B4–E0B7
    corner([W, b], [0, t]), back, corner([W, t], [0, b]), slash, // E0B8–E0BB
    corner([0, b], [W, t]), slash, corner([0, t], [W, b]), back, // E0BC–E0BF
  ]
}

const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [[x0, y0], [x0, y1], [x1, y1], [x1, y0]]
const N: P[] = [[320, 0], [320, 700], [390, 700], [490, 280], [490, 700], [560, 700], [560, 0], [490, 0], [390, 420], [390, 0]]

/** U+E0A0–E0A3, which sit on the baseline like letters, the same in every row. */
const ICONS: P[][][] = [
  // the branch: a stem, and the limb that leaves it
  [rect(130, -80, 210, 760), [[390, 760], [470, 760], [470, 480], [170, 180], [170, 293], [390, 513]]],
  // LN, the line number
  [[[40, 0], [40, 700], [110, 700], [110, 70], [280, 70], [280, 0]], N],
  // the padlock: its body with a keyhole, and the shackle
  [
    rect(90, -20, 510, 420),
    ccw(rect(262, 110, 338, 270)),
    [
      [120, 380], ...arc(300, 420, 180, 260, 180, 0), [480, 420], [480, 380],
      [400, 380], ...arc(300, 420, 100, 180, 0, 180), [200, 420], [200, 380],
    ],
  ],
  // CN, the column number
  [[[40, 0], [40, 700], [280, 700], [280, 630], [110, 630], [110, 70], [280, 70], [280, 0]], N],
]

// ---- the font --------------------------------------------------------------

class Bytes {
  private readonly b: number[] = []
  get length(): number {
    return this.b.length
  }
  u8(...xs: number[]): this {
    for (const x of xs) this.b.push(x & 0xff)
    return this
  }
  /** Signed or unsigned, big-endian as every number in the font. */
  u16(...xs: number[]): this {
    for (const x of xs) this.u8(x >> 8, x)
    return this
  }
  u32(...xs: number[]): this {
    for (const x of xs) this.u16(x >>> 16, x & 0xffff)
    return this
  }
  done(): Uint8Array {
    while (this.b.length % 4) this.b.push(0)
    return Uint8Array.from(this.b)
  }
}

interface Glyph {
  contours: P[][]
  box: [number, number, number, number] | null
}

/** The outline on whole units, without a point that repeats the one before it. */
function glyph(g: P[][]): Glyph {
  const contours = g.map((c) => {
    const r = c.map(([x, y, off]): P => [Math.round(x), Math.round(y), off])
    return r.filter((p, i) => p[0] !== r.at(i - 1)![0] || p[1] !== r.at(i - 1)![1])
  })
  const pts = contours.flat()
  if (!pts.length) return { contours: [], box: null }
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { contours, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }
}

/** A simple glyph: no instructions, every coordinate a 16-bit step. */
function encode({ contours, box }: Glyph): Uint8Array {
  if (!box) return new Uint8Array(0)
  const o = new Bytes().u16(contours.length, ...box)
  let end = -1
  for (const c of contours) o.u16((end += c.length))
  o.u16(0)
  const pts = contours.flat()
  o.u8(...pts.map((p) => (p[2] ? 0 : 1)))
  const steps = (k: 0 | 1) => pts.forEach((p, i) => o.u16(p[k] - (i ? pts[i - 1][k] : 0)))
  steps(0)
  steps(1)
  return o.done()
}

function checksum(d: Uint8Array): number {
  let s = 0
  for (let i = 0; i < d.length; i += 4) {
    s = (s + (((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0)) % 2 ** 32
  }
  return s
}

function sfnt(tables: Record<string, Uint8Array>): ArrayBuffer {
  const tags = Object.keys(tables).sort()
  const n = tags.length
  const range = 16 * 2 ** Math.floor(Math.log2(n))
  const dir = new Bytes().u32(0x00010000).u16(n, range, Math.log2(range / 16), 16 * n - range)
  const at: Record<string, number> = {}
  let end = 12 + 16 * n
  for (const tag of tags) {
    at[tag] = end
    dir.u8(...[...tag].map((c) => c.charCodeAt(0))).u32(checksum(tables[tag]), end, tables[tag].length)
    end += (tables[tag].length + 3) & ~3
  }
  const buf = new ArrayBuffer(end)
  const file = new Uint8Array(buf)
  file.set(dir.done())
  for (const tag of tags) file.set(tables[tag], at[tag])
  new DataView(buf).setUint32(at.head + 8, (0xb1b0afba - checksum(file)) >>> 0)
  return buf
}

/** The font for a row: .notdef, the icons, then the separators. */
export function powerlineFont(fit: Fit): ArrayBuffer {
  const glyphs = [[], ...ICONS, ...separators(fit)].map(glyph)
  const data = glyphs.map(encode)
  const boxes = glyphs.flatMap((g) => (g.box ? [g.box] : []))
  const xMin = Math.min(...boxes.map((x) => x[0]))
  const yMin = Math.min(...boxes.map((x) => x[1]))
  const xMax = Math.max(...boxes.map((x) => x[2]))
  const yMax = Math.max(...boxes.map((x) => x[3]))
  const points = Math.max(...glyphs.map((g) => g.contours.flat().length))
  const contours = Math.max(...glyphs.map((g) => g.contours.length))

  const head = new Bytes()
    .u16(1, 0)
    .u32(0x00010000, 0, 0x5f0f3cf5) // revision; checkSumAdjustment, set last; magic
    .u16(0x0001, 1000) // the baseline at 0; units per em
    .u32(0, 0, 0, 0) // created, modified
    .u16(xMin, yMin, xMax, yMax)
    .u16(0, 8, 2, 1, 0) // macStyle, lowestRecPPEM, fontDirectionHint, long loca, glyphDataFormat
  const hhea = new Bytes()
    .u32(0x00010000)
    .u16(1020, -300, 0, W) // JetBrains Mono's ascent, descent and line gap; advanceWidthMax
    .u16(xMin, Math.min(...boxes.map((x) => W - x[2])), xMax)
    .u16(1, 0, 0, 0, 0, 0, 0, 0) // an upright caret; reserved; metricDataFormat
    .u16(glyphs.length)
  const maxp = new Bytes().u32(0x00010000).u16(glyphs.length, points, contours, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)
  const os2 = new Bytes()
    .u16(4, W, 400, 5, 0) // version, xAvgCharWidth, usWeightClass, usWidthClass, fsType
    .u16(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0) // sub- and superscripts, strikeout, family class
    .u8(2, 0, 0, 9, 0, 0, 0, 0, 0, 0) // PANOSE: Latin text, monospaced
    .u32(0, 1 << 28, 0, 0) // Unicode ranges: the Private Use Area
    .u8(...[...'NONE'].map((c) => c.charCodeAt(0)))
    .u16(0x00c0, 0xe0a0, 0xe0bf) // regular, use the typo metrics; the first and last character
    .u16(1020, -300, 0)
    // past every glyph, so that no system clips one there
    .u16(Math.max(1020, yMax), Math.max(300, -yMin))
    .u32(1, 0) // code pages
    .u16(0, 0, 0, 0, 0) // xHeight, capHeight, defaultChar, breakChar, maxContext
  const hmtx = new Bytes()
  for (const g of glyphs) hmtx.u16(W, g.box ? g.box[0] : 0)
  const loca = new Bytes()
  let offset = 0
  for (const d of data) {
    loca.u32(offset)
    offset += d.length
  }
  loca.u32(offset)
  const glyf = new Uint8Array(offset)
  offset = 0
  for (const d of data) {
    glyf.set(d, offset)
    offset += d.length
  }
  // Windows Unicode BMP, format 4: the icons to glyphs 1–4, the separators
  // to 5–20, and the closing segment at U+FFFF to .notdef.
  const segs = [
    [0xe0a0, 0xe0a3, 1],
    [0xe0b0, 0xe0bf, 5],
    [0xffff, 0xffff, 0],
  ]
  const seg2 = 2 * segs.length
  const search = 2 * 2 ** Math.floor(Math.log2(segs.length))
  const cmap = new Bytes()
    .u16(0, 1, 3, 1)
    .u32(12)
    .u16(4, 16 + 4 * seg2, 0, seg2, search, Math.log2(search / 2), seg2 - search)
    .u16(...segs.map((s) => s[1]), 0, ...segs.map((s) => s[0]))
    .u16(...segs.map(([first, , g]) => (g - first) & 0xffff), ...segs.map(() => 0))
  const names = [POWERLINE, 'Regular', `${POWERLINE} Regular`, `${POWERLINE} Regular`, 'Version 1.000', 'MoriPowerline-Regular']
  const name = new Bytes().u16(0, names.length, 6 + 12 * names.length)
  let str = 0
  names.forEach((s, i) => {
    name.u16(3, 1, 0x409, i + 1, 2 * s.length, str)
    str += 2 * s.length
  })
  for (const s of names) name.u16(...[...s].map((c) => c.charCodeAt(0)))
  const post = new Bytes().u32(0x00030000, 0).u16(-100, 50).u32(1, 0, 0, 0, 0)

  const unpadded = (b: Bytes) => b.done().subarray(0, b.length)
  return sfnt({
    'OS/2': unpadded(os2),
    cmap: unpadded(cmap),
    glyf,
    head: unpadded(head),
    hhea: unpadded(hhea),
    hmtx: unpadded(hmtx),
    loca: unpadded(loca),
    maxp: unpadded(maxp),
    name: unpadded(name),
    post: unpadded(post),
  })
}

// ---- giving it to the page -------------------------------------------------

// The face the page has, and the row the last call was for.
let added: FontFace | null = null
let current: { key: string } | null = null

/** The font's ascent and descent in CSS pixels, as xterm.js measures a cell:
 * with a canvas where it can, else with the layout, which rounds JetBrains
 * Mono's to whole pixels. */
function measure(family: string, size: number): [number, number] {
  if (typeof OffscreenCanvas === 'function') {
    const ctx = new OffscreenCanvas(1, 1).getContext('2d')
    if (ctx) {
      ctx.font = `${size}px ${family}`
      const m = ctx.measureText('W')
      if (Number.isFinite(m.fontBoundingBoxAscent) && Number.isFinite(m.fontBoundingBoxDescent)) {
        return [m.fontBoundingBoxAscent, m.fontBoundingBoxDescent]
      }
    }
  }
  return [Math.round(1.02 * size), Math.round(0.3 * size)]
}

/**
 * Gives the page the Powerline font for the rows of text of `size` CSS
 * pixels in the font stack `family`, at the pixel ratio it has now, in place
 * of the one it had. Resolves once the face is in, or when it cannot be; a
 * prompt then draws its arrows with the other fonts of the stack.
 */
export async function loadPowerline(family: string, size: number): Promise<void> {
  try {
    if (typeof FontFace === 'undefined' || !document.fonts) return
    const [ascent, descent] = measure(family, size)
    const dpr = window.devicePixelRatio || 1
    const key = [size, dpr, ascent, descent].join()
    if (current?.key === key) return
    const mine = { key }
    current = mine
    const face = new FontFace(POWERLINE, powerlineFont(rowFit(size, dpr, ascent, descent)), {
      weight: '100 900',
      unicodeRange: POWERLINE_RANGE,
    })
    await face.load()
    if (current !== mine) return
    if (added) document.fonts.delete(added)
    document.fonts.add(face)
    added = face
  } catch {
    // the other fonts of the stack draw the arrows, or boxes
  }
}

/** Calls fn each time the pixel ratio changes: the page zoomed, or its
 * window moved to another screen. Returns the function that stops it. */
export function followPixelRatio(fn: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  let q: MediaQueryList | null = null
  const listen = () => {
    q = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    q.addEventListener('change', changed)
  }
  const changed = () => {
    q?.removeEventListener('change', changed)
    listen()
    fn()
  }
  listen()
  return () => q?.removeEventListener('change', changed)
}
