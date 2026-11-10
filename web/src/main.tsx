import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/ui.css'
import { effect } from '@preact/signals'
import { render } from 'preact'
import { App } from './app'
import { initBackstack } from './lib/backstack'
import { showNeeds } from './lib/badge'
import { boot } from './lib/boot'
import { startClock } from './lib/clock'
import { trackWidth } from './lib/media'
import { initRouter, navigate, parseHash } from './lib/router'
import { totalNeeds } from './lib/scope'
import { initTheme } from './lib/theme'
import { trackViewport } from './lib/viewport'
import { startWake } from './lib/wake'

initTheme()
trackViewport()
trackWidth()
initRouter()
initBackstack()
startClock()
startWake()
effect(() => showNeeds(totalNeeds.value))
render(<App />, document.getElementById('app')!)
void boot()

// The service worker only shows pushes (public/sw.js). A click on a
// notification while Mori is open asks this page to go to the terminal.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as { type?: string; url?: string } | null
    if (msg?.type !== 'navigate' || typeof msg.url !== 'string') return
    const url = new URL(msg.url, location.origin)
    if (url.origin === location.origin) navigate(parseHash(url.hash))
  })
}
