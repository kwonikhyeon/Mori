// iOS Safari ignores interactive-widget=resizes-content: the on-screen
// keyboard covers the page instead of shrinking it. Following the visual
// viewport keeps the send box and quick keys above the keyboard.
export function trackViewport(): () => void {
  const vv = window.visualViewport
  if (!vv) return () => {}
  const root = document.documentElement
  const update = () => {
    if (vv.scale > 1.01) return // pinch zoom, not a keyboard
    root.style.setProperty('--app-h', `${Math.round(vv.height)}px`)
    if (window.scrollY !== 0) window.scrollTo(0, 0)
  }
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
    root.style.removeProperty('--app-h')
  }
}
