// Mori service worker: Web Push only (spec §3 #129). There is no fetch
// handler, so every request goes to the server as usual.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

// The keys a question's notification offers (spec §3 #196); with room for
// two only, the first choice and Esc. A device that shows no buttons (iOS)
// gets none, and the notification opens the session as before.
function answers() {
  const max = (self.Notification && self.Notification.maxActions) || 0
  const all = [
    { action: 'key:1', title: '1' },
    { action: 'key:2', title: '2' },
    { action: 'key:esc', title: 'Esc' },
  ]
  return max >= all.length ? all : [all[0], all[2]].slice(0, max)
}

// keysPath is where the keys for the session url opens go: a linked host's
// session goes through this hub (spec §3 #161). The address is escaped.
function keysPath(url) {
  const m = /^\/#\/(?:h\/([^/?#]+)\/)?t\/([^/?#]+)$/.exec(url)
  return m ? (m[1] ? '/h/' + m[1] : '') + '/api/terminals/' + m[2] + '/keys' : ''
}

// answer presses key as the answer to the question ask names. The server
// refuses it once the program asks something else (spec §3 #194). It gives
// up in time for the session to open in its place: a browser lets a
// notification open a window only for a few seconds after the press.
async function answer(url, key, ask) {
  const path = keysPath(url)
  if (!path || !ask) return false
  try {
    const r = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [key], expect: ask }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
    })
    return r.ok
  } catch (err) {
    return false
  }
}

self.addEventListener('push', (e) => {
  let msg = {}
  try {
    msg = e.data ? e.data.json() : {}
  } catch (err) {
    msg = { body: e.data ? e.data.text() : '' }
  }
  const tag = typeof msg.tag === 'string' ? msg.tag : undefined
  const ask = msg.kind === 'blocked' && typeof msg.ask === 'string' ? msg.ask : ''
  e.waitUntil(
    self.registration.showNotification(msg.title || 'Mori', {
      body: msg.body || '',
      tag,
      renotify: !!tag,
      icon: '/icons/icon-192-v2.png',
      badge: '/icons/icon-192-v2.png',
      actions: ask ? answers() : [],
      data: { url: typeof msg.url === 'string' ? msg.url : '/', ask },
    }),
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const data = e.notification.data || {}
  let url = '/'
  try {
    const u = new URL(data.url, self.location.origin)
    if (u.origin === self.location.origin) url = u.pathname + u.search + u.hash
  } catch (err) {}
  const key = typeof e.action === 'string' && e.action.startsWith('key:') ? e.action.slice(4) : ''
  e.waitUntil(
    (async () => {
      // A key that went in needs nothing more; one that did not opens the
      // session, to see what it asks now.
      if (key && (await answer(url, key, typeof data.ask === 'string' ? data.ask : ''))) return
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
