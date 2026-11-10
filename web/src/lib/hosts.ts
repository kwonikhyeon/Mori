// The hosts linked to the hub (spec §7.1 hosts): whether one is the page's own.

/** The link of this page itself. */
export function isHere(url: string, origin = location.origin): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}
