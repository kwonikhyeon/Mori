// Pairing a browser (spec §3 #130): the code as the person types it, and
// the name the device starts with.

/** The code as the server reads it: upper case, O as 0, I and L as 1. */
export function normalizeCode(s: string): string {
  return s
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 8)
}

/** XXXX-XXXX, as much of it as is typed. */
export function formatCode(s: string): string {
  const k = normalizeCode(s)
  return k.length > 4 ? k.slice(0, 4) + '-' + k.slice(4) : k
}

/** The code of a pairing link, /pair#code=XXXX-XXXX. */
export function codeFromHash(hash: string): string {
  const raw = hash.replace(/^#/, '')
  const q = raw.indexOf('?')
  const code = new URLSearchParams(q < 0 ? raw : raw.slice(q + 1)).get('code')
  return code ? formatCode(code) : ''
}

export function osName(ua: string, touchPoints = 0): string {
  if (/iPhone|iPod/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  if (/Linux/.test(ua)) return 'Linux'
  return ''
}

export function browserName(ua: string): string {
  if (/Edg(A|iOS)?\//.test(ua)) return 'Edge'
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet'
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox'
  if (/OPR\//.test(ua)) return 'Opera'
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return ''
}

/** "iPhone · Safari": what the device is called until someone renames it. */
export function deviceName(ua: string, touchPoints: number): string {
  return [osName(ua, touchPoints), browserName(ua)].filter(Boolean).join(' · ') || '새 기기'
}
