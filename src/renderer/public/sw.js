// Keeps Jolty's page on the phone, so it opens even while the PC that serves it is off: that is when "Start the PC" is needed.
// The cache is named after the version (the server fills it in), so an update replaces the old pages.
const CACHE = 'jolty-shell-__VERSION__'
const SHELL = ['/', '/lang.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']
// a PC that is off does not answer: waiting for it longer than this only delays the page that explains it
const WAIT = 3500

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

function fromNetwork(req) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('slow')), WAIT)
    fetch(req).then(
      (res) => {
        clearTimeout(t)
        resolve(res)
      },
      (err) => {
        clearTimeout(t)
        reject(err)
      }
    )
  })
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname === '/ws' || url.pathname.startsWith('/api/')) return

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

  // the page and the small files: the PC's copy when it answers, the kept one when it does not
  e.respondWith(
    fromNetwork(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy))
        }
        return res
      })
      .catch(async () => (await caches.match(req.mode === 'navigate' ? '/' : req, { ignoreSearch: true })) || Response.error())
  )
})
