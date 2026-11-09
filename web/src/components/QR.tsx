// A QR code for a camera to read. It stays dark on white in the dark theme
// too, since that is what scanners expect.
import { useMemo } from 'preact/hooks'
import { encode } from 'uqr'

const QUIET = 2 // modules of white around the code

/** The dark modules as one path, a rectangle per run of a row. */
export function qrPath(value: string): { size: number; d: string } {
  const q = encode(value, { border: QUIET })
  let d = ''
  q.data.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue
      let end = x
      while (row[end + 1]) end++
      d += `M${x} ${y}h${end - x + 1}v1H${x}z`
      x = end
    }
  })
  return { size: q.size, d }
}

export function QR({ value, size, label }: { value: string; size: number; label: string }) {
  const { size: n, d } = useMemo(() => qrPath(value), [value])
  return (
    <svg class="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label}>
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#1C1B19" />
    </svg>
  )
}
