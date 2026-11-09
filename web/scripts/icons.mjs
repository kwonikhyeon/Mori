// Draws the app icons into public/icons (run with `npm run icons`; the
// PNGs are committed). A white "M" on the accent blue, anti-aliased with
// distance fields; nothing but Node is needed.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
const BG = [0x24, 0x57, 0xd6]
// The glyph in a 100×100 box: a polyline stroked 10 wide with round ends.
const M = [[30, 72], [30, 30], [50, 55], [70, 30], [70, 72]]
const HALF = 5

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
      if (corner > 0) {
        const qx = Math.abs(ux - 50) - (50 - corner)
        const qy = Math.abs(uy - 50) - (50 - corner)
        const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner
        alpha = clamp(0.5 - d * px)
      }
      const gx = 50 + (ux - 50) / scale
      const gy = 51 + (uy - 50) / scale
      let d = Infinity
      for (let i = 0; i < M.length - 1; i++) d = Math.min(d, segment(gx, gy, M[i], M[i + 1]))
      const ink = clamp((HALF - d) * scale * px + 0.5)
      const o = (y * size + x) * 4
      for (let c = 0; c < 3; c++) buf[o + c] = Math.round(BG[c] * (1 - ink) + 255 * ink)
      buf[o + 3] = Math.round(alpha * 255)
    }
  }
  return png(size, buf)
}

mkdirSync(out, { recursive: true })
const icons = {
  'icon-192.png': icon(192, 22, 1),
  'icon-512.png': icon(512, 22, 1),
  'icon-maskable-512.png': icon(512, 0, 0.8), // inside the 80% safe circle
  'apple-touch-icon.png': icon(180, 0, 1), // iOS rounds the corners itself
}
for (const [name, data] of Object.entries(icons)) {
  writeFileSync(join(out, name), data)
  console.log(`${name} ${data.length} bytes`)
}
