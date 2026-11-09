// What the browser runs on, for the few places that differ by it.

/** A Mac, iPhone or iPad: ⌘ is the command key. */
export function isApple(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent)
}
