// The other Mori hosts of Settings (spec §7.1 hosts): links in the header.
import type { Host } from './types'

/** The hosts that are not this page's, in their order; broken URLs are left out. */
export function otherHosts(hs: Host[], origin = location.origin): Host[] {
  return hs.filter((h) => {
    try {
      const u = new URL(h.url)
      return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin !== origin
    } catch {
      return false
    }
  })
}
