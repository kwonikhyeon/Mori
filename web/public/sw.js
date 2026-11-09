// Mori service worker: Web Push only (spec §3 #129). There is no fetch
// handler, so every request goes to the server as usual.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let msg = {}
  try {
    msg = e.data ? e.data.json() : {}
  } catch (err) {
    msg = { body: e.data ? e.data.text() : '' }
  }
  const tag = typeof msg.tag === 'string' ? msg.tag : undefined
  e.waitUntil(
    self.registration.showNotification(msg.title || 'Mori', {
      body: msg.body || '',
      tag,
      renotify: !!tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: typeof msg.url === 'string' ? msg.url : '/' },
    }),
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  let url = '/'
  try {
    const u = new URL(e.notification.data && e.notification.data.url, self.location.origin)
    if (u.origin === self.location.origin) url = u.pathname + u.search + u.hash
  } catch (err) {}
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const w of wins) {
        if (new URL(w.url).origin !== self.location.origin) continue
        await w.focus()
        w.postMessage({ type: 'navigate', url })
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})

// A push service may replace a subscription by itself (Firefox does). The
// new one goes to the server with the kinds this device chose. A device the
// server holds nothing for stays off: it was turned off, or the server
// forgot an expired subscription, and Settings says so.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(
    (async () => {
      const get = (path) => fetch(path, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null))
      const mine = await get('/api/push/subscriptions')
      if (!Array.isArray(mine) || mine.length === 0) return
      let sub = e.newSubscription
      if (!sub) {
        const k = await get('/api/push/key')
        if (!k || typeof k.key !== 'string') return
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: k.key })
      }
      await fetch('/api/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), kinds: mine[0].kinds }),
      })
    })(),
  )
})
