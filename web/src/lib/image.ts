// A picture over the core's 8 MB, made smaller in the browser before it goes
// up (spec §3 #255). The core takes 8 MiB a put; Claude Code sends the model
// a picture of at most 2576 px a side, made smaller itself past that, so a
// picture brought to that loses nothing the model sees. A PNG stays a PNG
// while one fits, as a screenshot's letters stay sharp; else a JPEG at 0.9;
// else smaller again. A GIF would lose its motion: it is left as it is.

/** The longest side the model takes (Claude Code 2.1.323's image_limits). */
export const EDGE = 2576
/** Each further try, this much smaller. */
const STEP = 0.75
const TRIES = 6

/** A picture to draw again: its size, and its pixels encoded at a scale. */
export interface Picture {
  width: number
  height: number
  encode(scale: number, type: string, quality?: number): Promise<Blob | null>
}

/** The picture again under max bytes, or null when no try fits. */
export async function shrink(p: Picture, type: string, max: number): Promise<Blob | null> {
  let scale = Math.min(1, EDGE / Math.max(p.width, p.height))
  const forms: [string, number?][] = type === 'image/png' ? [['image/png'], ['image/jpeg', 0.9]] : [['image/jpeg', 0.9]]
  for (let i = 0; i < TRIES; i++) {
    for (const [t, q] of forms) {
      const b = await p.encode(scale, t, q)
      if (b && b.size <= max) return b
    }
    scale *= STEP
  }
  return null
}

/** Whether a picture of this kind can be drawn again without losing anything but pixels. */
export const shrinkable = (f: File) => /^image\/(?:png|jpeg|webp)$/.test(f.type)

/** The file as it is when it fits, else smaller (a new name's ending to match); null when it cannot be. */
export async function fitImage(f: File, max: number): Promise<File | null> {
  if (f.size <= max) return f
  if (!shrinkable(f) || typeof createImageBitmap !== 'function') return null
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(f)
  } catch {
    return null
  }
  try {
    const b = await shrink(
      {
        width: bmp.width,
        height: bmp.height,
        encode: (scale, type, quality) => {
          const c = document.createElement('canvas')
          c.width = Math.max(1, Math.round(bmp.width * scale))
          c.height = Math.max(1, Math.round(bmp.height * scale))
          const g = c.getContext('2d')
          if (!g) return Promise.resolve(null)
          if (type === 'image/jpeg') {
            // no transparency in a JPEG: white, as a page shows it
            g.fillStyle = '#fff'
            g.fillRect(0, 0, c.width, c.height)
          }
          g.drawImage(bmp, 0, 0, c.width, c.height)
          return new Promise((done) => c.toBlob(done, type, quality))
        },
      },
      f.type,
      max,
    )
    if (!b) return null
    const ext = b.type === 'image/png' ? '.png' : '.jpg'
    return new File([b], f.name.replace(/\.[^./]+$/, '') + ext, { type: b.type })
  } finally {
    bmp.close()
  }
}
