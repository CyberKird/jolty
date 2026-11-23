// Phone page only (the server adds it to the page; the desktop window never loads it).
// The server draws the app's bar with its bolt inside #root (class "boot-shell") until the app's scripts take over. When they never
// do (a script of an older copy kept on the phone is gone from the PC, the entry module throws, the first render crashes) that
// bar stays alone on a black screen. This file turns that into a way out: a stale copy is cleared and the page loads again once,
// and anything else gets a visible note with Reload, and the last error in small print so a screenshot says what happened.
// Plain ES5 on purpose: it runs before everything else and must not depend on the build.
(function () {
  var HEAL = 'jolty-heal'
  var WAIT = 12000
  var lastError = ''
  var panel = null

  function say(en, ro) {
    return window.joltyLang === 'ro' ? ro : en
  }
  function root() {
    return document.getElementById('root')
  }
  // the bar of the server is still alone, or nothing is drawn at all (the whole tree was dropped)
  function stuck() {
    var r = root()
    if (!r) return false
    return !!r.querySelector('.boot-shell') || r.childElementCount === 0
  }
  function note(e) {
    if (e) lastError = String((e && (e.message || e.reason && (e.reason.message || e.reason))) || e).slice(0, 220)
  }

  // the kept copies (pages, scripts, the service worker) go and the page asks the PC again
  function wipe() {
    var jobs = []
    var go = function () {
      location.reload()
    }
    try {
      if (window.caches) jobs.push(caches.keys().then(function (k) { return Promise.all(k.map(function (n) { return caches.delete(n) })) }))
    } catch (e) {}
    try {
      if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (r) { return Promise.all(r.map(function (x) { return x.unregister() })) }))
    } catch (e) {}
    setTimeout(go, 3000)
    Promise.all(jobs).then(go, go)
  }

  // once in ten minutes, so a page that cannot load never loops
  function heal() {
    var last = 0
    try {
      last = Number(sessionStorage.getItem(HEAL) || 0)
      if (Date.now() - last < 600000) return show()
      sessionStorage.setItem(HEAL, String(Date.now()))
    } catch (e) {
      return show()
    }
    wipe()
  }

  function button(label, primary, run) {
    var b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.style.cssText =
      'flex:1;min-height:44px;padding:0 14px;border-radius:10px;font:600 13px/1 system-ui,sans-serif;letter-spacing:.04em;cursor:pointer;' +
      (primary ? 'border:0;background:var(--volt,#d4ff00);color:#060709' : 'border:1px solid rgba(255,255,255,.22);background:transparent;color:#fff')
    b.addEventListener('click', run)
    return b
  }

  function show() {
    if (panel || !document.body) return
    panel = document.createElement('div')
    panel.setAttribute('role', 'alert')
    panel.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483000;padding:16px;border-radius:16px;' +
      'background:rgba(10,11,14,.96);border:1px solid rgba(255,255,255,.14);color:#fff;font:14px/1.45 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5)'
    var h = document.createElement('div')
    h.textContent = say('Jolty did not finish loading', 'Jolty nu a pornit complet')
    h.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:4px'
    var p = document.createElement('div')
    p.textContent = say('The page is loading slowly, or the copy kept on this phone is out of date.', 'Pagina se încarcă mai greu decât de obicei sau copia păstrată pe telefon e veche.')
    p.style.cssText = 'color:rgba(255,255,255,.72)'
    var row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:8px;margin-top:12px'
    row.appendChild(button(say('Reload', 'Reîncarcă'), true, function () { location.reload() }))
    row.appendChild(button(say('Clear and reload', 'Curăță și reîncarcă'), false, wipe))
    panel.appendChild(h)
    panel.appendChild(p)
    panel.appendChild(row)
    if (lastError) {
      var d = document.createElement('div')
      d.textContent = lastError
      d.style.cssText = 'margin-top:10px;font:11px/1.35 ui-monospace,monospace;color:rgba(255,255,255,.45);word-break:break-all'
      panel.appendChild(d)
    }
    document.body.appendChild(panel)
    // the app took over after all (a slow line): the note goes away by itself
    var watch = setInterval(function () {
      if (stuck()) return
      clearInterval(watch)
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
      panel = null
    }, 1500)
  }

  // a script or stylesheet of the page is gone from the PC: the copy kept on the phone is older than the PC's Jolty
  window.addEventListener(
    'error',
    function (e) {
      var t = e.target
      if (t && t !== window && (t.tagName === 'SCRIPT' || (t.tagName === 'LINK' && t.rel === 'stylesheet'))) {
        lastError = 'load failed: ' + String(t.src || t.href).replace(location.origin, '')
        return heal()
      }
      note(e)
    },
    true
  )
  window.addEventListener('unhandledrejection', function (e) {
    note(e)
    // a page of the app (a chunk loaded on demand) that is not there any more: same cause, same way out
    if (/dynamically imported module|importing a module script|module script failed/i.test(lastError)) heal()
  })
  window.addEventListener('vite:preloadError', function (e) {
    note(e.payload || e)
    heal()
  })
  // main.tsx gives up reloading after a crash: say so instead of leaving a black screen
  window.addEventListener('jolty:crashed', function (e) {
    note(e.detail)
    show()
  })

  setTimeout(function () {
    if (stuck()) show()
  }, WAIT)
})()
