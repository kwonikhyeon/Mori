// Whether a person looks at this page now (spec §3 #127): it is visible
// and the window has the focus. Programs read it to decide whether to
// notify, so it is sent only when it changes.

export function watchFocus(fn: (focused: boolean) => void): () => void {
  let last: boolean | null = null
  const check = () => {
    const f = document.visibilityState === 'visible' && document.hasFocus()
    if (f === last) return
    last = f
    fn(f)
  }
  document.addEventListener('visibilitychange', check)
  window.addEventListener('focus', check)
  window.addEventListener('blur', check)
  check()
  return () => {
    document.removeEventListener('visibilitychange', check)
    window.removeEventListener('focus', check)
    window.removeEventListener('blur', check)
  }
}
