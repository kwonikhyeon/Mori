import { afterEach, describe, expect, it, vi } from 'vitest'
import { EDGE, fitImage, shrink, type Picture } from './image'

/** A picture whose encodings weigh what bytes() says for its scale and type; it notes each try. */
function picture(width: number, height: number, bytes: (scale: number, type: string) => number) {
  const tries: [number, string, number?][] = []
  const p: Picture = {
    width,
    height,
    encode: async (scale, type, quality) => {
      tries.push([Math.round(scale * 1000) / 1000, type, quality])
      return new Blob([new Uint8Array(bytes(scale, type))], { type })
    },
  }
  return { p, tries }
}

describe('shrink', () => {
  // a Retina screenshot: brought to the model's 2576 px, it fits as a PNG still
  it('brings a big PNG to the edge the model takes, a PNG while it fits', async () => {
    const { p, tries } = picture(5120, 2880, (s, t) => (t === 'image/png' ? 12e6 * s * s : 3e6 * s * s))
    const b = await shrink(p, 'image/png', 8 << 20)
    expect(b?.type).toBe('image/png')
    expect(tries).toEqual([[Math.round((EDGE / 5120) * 1000) / 1000, 'image/png', undefined]])
  })

  it('goes JPEG when no PNG fits, and smaller again when no JPEG does', async () => {
    const { p, tries } = picture(2000, 2000, (s, t) => (t === 'image/png' ? 40e6 * s * s : 12e6 * s * s))
    const b = await shrink(p, 'image/png', 8 << 20)
    expect(b?.type).toBe('image/jpeg')
    expect(tries.map((t) => t[1])).toEqual(['image/png', 'image/jpeg', 'image/png', 'image/jpeg'])
    expect(tries[2][0]).toBe(0.75)
  })

  it('keeps a JPEG a JPEG, and gives up after its tries', async () => {
    const { p, tries } = picture(1000, 1000, () => 9e6)
    expect(await shrink(p, 'image/jpeg', 8 << 20)).toBeNull()
    expect(tries.every((t) => t[1] === 'image/jpeg' && t[2] === 0.9)).toBe(true)
    expect(tries).toHaveLength(6)
  })
})

describe('fitImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // jsdom draws nothing: a canvas that gives what each type weighs
  it('draws a big picture again at the model\'s edge, its name\'s ending to match', async () => {
    const closed = vi.fn()
    vi.stubGlobal('createImageBitmap', async () => ({ width: 5120, height: 2880, close: closed }))
    const sizes: [number, number][] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      sizes.push([this.width, this.height])
      return { fillRect() {}, drawImage() {}, fillStyle: '' } as unknown as CanvasRenderingContext2D
    } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback, type?: string) {
      cb(new Blob([new Uint8Array(type === 'image/png' ? 9 << 20 : 2 << 20)], { type }))
    })
    const big = new File([new Uint8Array(10)], 'Screenshot 1.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: 12 << 20 })
    const g = (await fitImage(big, 8 << 20))!
    expect(g.name).toBe('Screenshot 1.jpg')
    expect(g.type).toBe('image/jpeg')
    expect(sizes[0]).toEqual([EDGE, Math.round(2880 * (EDGE / 5120))])
    expect(closed).toHaveBeenCalled()
  })

  it('leaves a picture that fits, and one it cannot draw again', async () => {
    const small = new File(['x'], 'a.png', { type: 'image/png' })
    expect(await fitImage(small, 8 << 20)).toBe(small)
    const gif = new File([new Uint8Array(10)], 'a.gif', { type: 'image/gif' })
    expect(await fitImage(gif, 5)).toBeNull()
  })
})
