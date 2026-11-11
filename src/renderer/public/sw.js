// Keeps Jolty's page on the phone, so it opens at once even on a poor connection and while the PC that serves it is off
// (that is when "Start the PC" is needed). The cache is named after the version (the server fills it in), so an update replaces the old pages.
const CACHE = 'jolty-shell-__VERSION__'
const SHELL = ['/', '/lang.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

// the page asks, once it is up and idle, for the rest of the built files to be kept: a screen opened later does not wait for the network
self.addEventListener('message', (e) => {
  if (e.data !== 'warm') return
  e.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE)
        const list = await (await fetch('/shell.json', { cache: 'no-cache' })).json()
        const missing = []
        for (const f of list) if (!(await cache.match(f))) missing.push(f)
        // a few at a time, so the page in use keeps the line
        for (let i = 0; i < missing.length; i += 3) await Promise.all(missing.slice(i, i + 3).map((f) => cache.add(f).catch(() => undefined)))
      } catch {
        // offline: tried again at the next visit
      }
    })()
  )
})

// the kept copy answers at once; the PC's copy is fetched behind it and is what shows next time
function refresh(req, cache, key) {
  return fetch(req).then((res) => {
    if (res.ok) cache.put(key, res.clone())
    return res
  })
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname === '/ws' || url.pathname.startsWith('/api/') || url.pathname === '/shell.json') return

  // built files carry a hash in their name: once kept, they never change
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res.ok) cache.put(req, res.clone())
        return res
      })
    )
    return
  }

  // the page and the small files: the kept copy first (the line may be slow or gone), refreshed behind it
  const key = req.mode === 'navigate' ? '/' : req
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(key, { ignoreSearch: true })
      const fresh = refresh(req, cache, key)
      if (hit) {
        e.waitUntil(fresh.catch(() => undefined))
        return hit
      }
      return fresh.catch(() => Response.error())
    })
  )
})
