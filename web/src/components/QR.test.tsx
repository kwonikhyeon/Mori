import { render } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { QR, qrPath } from './QR'

const LINK = 'https://macmini.example.ts.net/pair#code=K7QM-4TZP'

describe('qrPath', () => {
  it('draws each run of dark modules once, inside a white border', () => {
    const { size, d } = qrPath(LINK)
    expect(size).toBe(33) // version 3 and two modules each side
    const rects = d.match(/M\d+ \d+h\d+v1H\d+z/g)!
    expect(rects.join('')).toBe(d)
    // The finder pattern's top edge is one run of seven, two modules in.
    expect(rects[0]).toBe('M2 2h7v1H2z')
    expect(d).not.toMatch(/M\d+ [01]h|M[01] /)
  })

  it('changes with the value', () => {
    expect(qrPath(LINK).d).not.toBe(qrPath(LINK.replace('K7QM', 'K7QN')).d)
  })
})

describe('QR', () => {
  it('is one image with a name, at the size asked', () => {
    const { getByRole } = render(<QR value={LINK} size={104} label="페어링 QR 코드" />)
    const svg = getByRole('img', { name: '페어링 QR 코드' })
    expect(svg.getAttribute('width')).toBe('104')
    expect(svg.getAttribute('viewBox')).toBe('0 0 33 33')
    expect(svg.querySelector('path')!.getAttribute('d')).toBe(qrPath(LINK).d)
  })
})
