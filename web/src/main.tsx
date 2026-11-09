import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import { render } from 'preact'
import { App } from './app'
import { initTheme } from './lib/theme'
import { trackViewport } from './lib/viewport'

initTheme()
trackViewport()
render(<App />, document.getElementById('app')!)

// The service worker only shows pushes (public/sw.js). A click on a
// notification while Mori is open asks this page to go to the terminal.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as { type?: string; url?: string } | null
    if (msg?.type !== 'navigate' || typeof msg.url !== 'string') return
    const url = new URL(msg.url, location.origin)
    if (url.origin === location.origin) location.hash = url.hash
  })
}
