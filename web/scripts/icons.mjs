// Draws the app icons into public/icons (run with `npm run icons`; the
// PNGs are committed). "M_" on white: the M in the accent blue and a
// lighter blue cursor after it (spec §3 #231), anti-aliased with distance
// fields; nothing but Node is needed.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
const BG = [0xff, 0xff, 0xff]
const INK = [0x24, 0x57, 0xd6]
const CURSOR = [0x5b, 0x8c, 0xff]
// The glyphs in a 100×100 box, stroked HALF*2 wide with round ends: the M
// as a polyline, the cursor as one short segment.
const M = [[23.5, 70], [23.5, 32], [39.5, 52], [55.5, 32], [55.5, 70]]
const BAR = [[67.75, 65.75], [76.25, 65.75]]
const HALF = 4.25
// A rounded icon's hairline edge, so white does not melt into a light page.
const EDGE = 0.1

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const clamp = (v) => Math.max(0, Math.min(1, v))
function segment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax
  const dy = by - ay
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

// corner: radius of the rounded square in box units (0 = full bleed);
// scale: glyph size relative to the box.
function icon(size, corner, scale) {
  const px = size / 100
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ux = (x + 0.5) / px
      const uy = (y + 0.5) / px
      let alpha = 1
      let edge = 0
      if (corner > 0) {
        const qx = Math.abs(ux - 50) - (50 - corner)
        const qy = Math.abs(uy - 50) - (50 - corner)
        const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner
        alpha = clamp(0.5 - d * px)
        edge = clamp((d + 0.6) * px + 0.5) // within 0.6 box unit of the outline
      }
      const gx = 50 + (ux - 50) / scale
      const gy = 50 + (uy - 50) / scale
      let dm = Infinity
      for (let i = 0; i < M.length - 1; i++) dm = Math.min(dm, segment(gx, gy, M[i], M[i + 1]))
      const inkM = clamp((HALF - dm) * scale * px + 0.5)
      const inkC = clamp((HALF - segment(gx, gy, BAR[0], BAR[1])) * scale * px + 0.5)
      const o = (y * size + x) * 4
      for (let c = 0; c < 3; c++) {
        let v = BG[c] * (1 - inkM) + INK[c] * inkM
        v = v * (1 - inkC) + CURSOR[c] * inkC
        buf[o + c] = Math.round(v * (1 - EDGE * edge))
      }
      buf[o + 3] = Math.round(alpha * 255)
    }
  }
  return png(size, buf)
}

mkdirSync(out, { recursive: true })
const icons = {
  'icon-192.png': icon(192, 22.5, 1),
  'icon-512.png': icon(512, 22.5, 1),
  'icon-maskable-512.png': icon(512, 0, 0.8), // inside the 80% safe circle
  'apple-touch-icon.png': icon(180, 0, 1), // iOS rounds the corners itself
}
for (const [name, data] of Object.entries(icons)) {
  writeFileSync(join(out, name), data)
  console.log(`${name} ${data.length} bytes`)
}
