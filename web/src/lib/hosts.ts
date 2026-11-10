// The hosts linked to the hub (spec §7.1 hosts): whether one is the page's own.

/** The origin of an address or a pairing link, as the hub reads it; '' when it is neither. */
export function originOf(url: string): string {
  try {
    return new URL(url.trim()).origin
  } catch {
    return ''
  }
}

/** The link of this page itself. */
export function isHere(url: string, origin = location.origin): boolean {
  return originOf(url) === origin
}
