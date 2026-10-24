// Jolty browser bridge for Firefox. Firefox does not let extensions use the Chrome DevTools Protocol, so this
// script answers the same requests as the Chromium extension by translating the protocol commands Jolty uses
// into what Firefox offers: tabs, webNavigation, webRequest, screenshots, and driver.js inside the page.
// It talks to the Jolty desktop app over a WebSocket on 127.0.0.1; nothing leaves the computer.
// The token proves the caller is Jolty. A copy loaded from a folder has it in config.json (written by Jolty); the signed
// add-on cannot be changed after signing, so it asks Jolty for the token once (pairing, started by Install in Jolty) and keeps it.
'use strict'

const VERSION = browser.runtime.getManifest().version
const FIRST_PORT = 47820
const PORT_COUNT = 10

let sock = null
let config = null
let retry = 0
let reconnectTimer = 0
let state = 'offline' // offline | connecting | online
let detail = ''
const attached = new Set()
const boot = new Map() // tabId -> script that runs in every new document
const answers = new Map() // tabId -> a pending dialog or navigation answer
const gates = new Map() // tabId -> what is held back until the new page's own request has been reported
const requests = new Map() // requestId -> { url, method }, the last few hundred
const seen = new Set() // tabs whose new main request was reported before the navigation itself

const say = (m) => {
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m))
}
const emit = (tabId, method, params) => {
  if (attached.has(tabId)) say({ type: 'event', tabId, method, params })
}

// Firefox reports a navigation and its request in no fixed order, and Jolty starts its log of a page at the
// request. Everything the new page says is held back until that request has been reported (or a moment passed).
function emitPage(tabId, method, params) {
  const g = gates.get(tabId)
  if (g) g.held.push([method, params])
  else emit(tabId, method, params)
}
function release(tabId) {
  const g = gates.get(tabId)
  if (!g) return
  gates.delete(tabId)
  clearTimeout(g.timer)
  for (const [method, params] of g.held) emit(tabId, method, params)
}

function setState(next, why) {
  state = next
  detail = why || ''
  browser.browserAction.setBadgeText({ text: next === 'online' ? '' : '!' }).catch(() => {})
  browser.browserAction.setBadgeBackgroundColor({ color: '#d03b3b' }).catch(() => {})
}

async function loadConfig() {
  try {
    const r = await fetch(browser.runtime.getURL('config.json'), { cache: 'no-store' })
    config = await r.json()
  } catch {
    config = null
  }
  return config
}

async function findHubs() {
  const ports = config && Array.isArray(config.ports) && config.ports.length ? config.ports : Array.from({ length: PORT_COUNT }, (_, i) => FIRST_PORT + i)
  const found = []
  for (const port of ports) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/jolty-hello`, { signal: AbortSignal.timeout(900), cache: 'no-store' })
      const j = await r.json()
      if (j && j.app === 'jolty') found.push(port)
    } catch {
      // not this port
    }
  }
  return found
}

// Where the token came from: a rejected pairing token is forgotten so the next attempt pairs again
let fromStorage = false

async function tokenFor(port) {
  fromStorage = false
  if (config && config.token) return config.token
  const { token } = await browser.storage.local.get('token')
  if (token) {
    fromStorage = true
    return token
  }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/jolty-pair`, { method: 'POST', cache: 'no-store' })
    if (!r.ok) return ''
    const j = await r.json()
    if (!j || !j.token) return ''
    await browser.storage.local.set({ token: j.token })
    return j.token
  } catch {
    return ''
  }
}

async function connect() {
  if (state === 'connecting' || (sock && sock.readyState <= WebSocket.OPEN)) return
  setState('connecting')
  await loadConfig()
  const hubs = await findHubs()
  if (!hubs.length) return fail('Jolty is not running')
  // more than one Jolty may be running (an installed one and a development copy): the one that knows this extension
  let port = 0
  let token = ''
  for (const p of hubs) {
    token = await tokenFor(p)
    if (token) {
      port = p
      break
    }
  }
  if (!token) return fail('not paired: press Install in Jolty (Settings > Browser)')
  let ws
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ext`)
  } catch (e) {
    return fail(String(e))
  }
  sock = ws
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, version: VERSION, agent: navigator.userAgent }))
  ws.onmessage = (m) => onMessage(ws, m)
  ws.onclose = () => {
    if (sock === ws) sock = null
    attached.clear()
    boot.clear()
    stopScreencast()
    fail('connection closed')
  }
  ws.onerror = () => {}
  // a socket that never opens must not block the next attempt
  setTimeout(() => {
    if (sock === ws && ws.readyState === WebSocket.CONNECTING) ws.close()
  }, 5000)
}

function fail(why) {
  setState('offline', why)
  clearTimeout(reconnectTimer)
  // quick at first, then every few seconds: the app may simply not be started yet
  retry = Math.min(retry + 1, 6)
  reconnectTimer = setTimeout(connect, Math.min(500 * retry, 4000))
}

async function onMessage(ws, m) {
  let msg
  try {
    msg = JSON.parse(m.data)
  } catch {
    return
  }
  if (msg.type === 'ready') {
    retry = 0
    setState('online')
    // Jolty replaced the extension's files with a newer version: reload once to pick them up
    if (msg.bundled && msg.bundled !== VERSION) {
      const { reloadedFor } = await browser.storage.local.get('reloadedFor')
      if (reloadedFor !== msg.bundled) {
        await browser.storage.local.set({ reloadedFor: msg.bundled })
        browser.runtime.reload()
      }
    }
    return
  }
  if (msg.type === 'reject') {
    if (fromStorage) await browser.storage.local.remove('token')
    setState('offline', msg.reason || 'rejected')
    ws.close()
    return
  }
  if (msg.type === 'pong') return
  if (msg.type === 'reload') {
    browser.runtime.reload()
    return
  }
  if (typeof msg.id !== 'number') return
  try {
    const handler = handlers[msg.method]
    if (!handler) throw new Error('unknown method ' + msg.method)
    const result = await handler(msg.params || {})
    say({ id: msg.id, result: result === undefined ? null : result })
  } catch (e) {
    say({ id: msg.id, error: { message: e && e.message ? e.message : String(e) } })
  }
}

const tabInfo = (t) => ({ id: t.id, windowId: t.windowId, title: t.title || '', url: t.url || '', active: Boolean(t.active), status: t.status })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ running things in the page
async function run(tabId, code) {
  // between two documents the tab has no page the extension may touch: it comes back within a moment
  for (let i = 0; ; i++) {
    try {
      return (await browser.tabs.executeScript(tabId, { code, runAt: 'document_start' }))[0]
    } catch (e) {
      if (i >= 14 || !/Missing host permission|Receiving end|No matching message/.test(String(e && e.message))) throw e
      await sleep(150)
    }
  }
}

/** The page side (driver.js) is in every page the extension was installed before; this covers the others. */
async function withDriver(tabId, call) {
  const code = `window.__joltyF ? (${call}, 1) : 0`
  if ((await run(tabId, code)) === 1) return
  await browser.tabs.executeScript(tabId, { file: 'driver.js', runAt: 'document_start' })
  if ((await run(tabId, code)) !== 1) throw new Error('Jolty could not run its script in this page')
}

async function attach(tabId) {
  if (attached.has(tabId)) return
  attached.add(tabId)
  // a page that loads later asks for itself; waiting here would hold up a tab that has no page yet
  void withDriver(tabId, 'window.__joltyF.arm()').catch(() => {})
}

async function evaluate(tabId, expression) {
  try {
    const value = await run(tabId, expression)
    return { result: { type: typeof value, value } }
  } catch (e) {
    const text = e && e.message ? e.message : String(e)
    return { result: { type: 'object' }, exceptionDetails: { text, exception: { description: text } } }
  }
}

// Some browsers open a new window on a start page and ignore the URL: pointing the tab at the URL with the
// tabs API makes it an ordinary page.
async function settleTab(t, want) {
  if (!/^https?:/i.test(want)) return t
  for (let i = 0; i < 40; i++) {
    const cur = await browser.tabs.get(t.id)
    if (cur.url && cur.url.startsWith(want.split('#')[0]) && cur.status === 'complete') return cur
    if (i === 2 && !(cur.url || '').startsWith(want.split('#')[0])) await browser.tabs.update(t.id, { url: want }).catch(() => {})
    await sleep(150)
  }
  return browser.tabs.get(t.id)
}

/** Page.navigate: answers once the navigation has committed (or failed), like the protocol does. */
async function navigate(tabId, url) {
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), 15000)
    answers.set(tabId, (r) => {
      clearTimeout(timer)
      resolve(r)
    })
  })
  await browser.tabs.update(tabId, { url })
  const r = await done
  answers.delete(tabId)
  return r.errorText ? { errorText: r.errorText } : { loaderId: 'nav' + Date.now() }
}

// ------------------------------------------------------------------ the protocol subset
const NOOP = new Set([
  'Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable', 'Page.setLifecycleEventsEnabled', 'Page.setInterceptFileChooserDialog',
  'Emulation.setFocusEmulationEnabled', 'Emulation.setEmulatedMedia', 'Input.setInterceptDrags'
])

const LAYOUT = `(() => {
  const v = window.visualViewport, d = document.documentElement
  return {
    cssVisualViewport: { clientWidth: v.width, clientHeight: v.height, pageX: v.pageLeft, pageY: v.pageTop },
    cssContentSize: { width: Math.max(d.scrollWidth, d.clientWidth), height: Math.max(d.scrollHeight, d.clientHeight) }
  }
})()`

const protocol = {
  'Page.addScriptToEvaluateOnNewDocument': async (tabId, { source }) => {
    boot.set(tabId, source)
    return { identifier: '1' }
  },
  'Page.getFrameTree': async (tabId) => ({ frameTree: { frame: { id: 'main', url: (await browser.tabs.get(tabId)).url } } }),
  'Page.getLayoutMetrics': (tabId) => run(tabId, LAYOUT),
  'Page.navigate': (tabId, { url }) => navigate(tabId, url),
  'Page.bringToFront': async (tabId) => {
    await browser.tabs.update(tabId, { active: true })
  },
  'Page.getNavigationHistory': async (tabId) => ({ currentIndex: 1, entries: [{ id: 0, url: '' }, { id: 1, url: (await browser.tabs.get(tabId)).url }] }),
  'Page.navigateToHistoryEntry': async (tabId) => {
    await browser.tabs.goBack(tabId)
  },
  'Page.captureScreenshot': async (tabId, { format, quality, clip }) => {
    const opts = format === 'jpeg' ? { format: 'jpeg', quality: quality || 80 } : { format: 'png' }
    if (clip) {
      opts.rect = { x: clip.x, y: clip.y, width: clip.width, height: clip.height }
      opts.scale = clip.scale
    }
    const url = await browser.tabs.captureTab(tabId, opts)
    return { data: url.slice(url.indexOf(',') + 1) }
  },
  'Page.handleJavaScriptDialog': async (tabId) => {
    // the page was never blocked: the dialog was reported and answered on the spot
    emit(tabId, 'Page.javascriptDialogClosed', { result: true })
  },
  'Page.startScreencast': async (tabId, p) => {
    startScreencast(tabId, p)
    return {}
  },
  'Page.stopScreencast': async () => {
    stopScreencast()
    return {}
  },
  'Page.screencastFrameAck': async () => {
    if (cast) cast.ack()
    return {}
  },
  'Runtime.evaluate': (tabId, { expression }) => evaluate(tabId, expression),
  'Input.dispatchMouseEvent': async (tabId, p) => {
    const { type, x, y, ...rest } = p
    await withDriver(tabId, `window.__joltyF.mouse(${JSON.stringify(type)}, ${Number(x)}, ${Number(y)}, ${JSON.stringify(rest)})`)
    return {}
  },
  'Input.dispatchKeyEvent': async (tabId, p) => {
    await withDriver(tabId, `window.__joltyF.key(${JSON.stringify(p)})`)
    return {}
  },
  'Input.insertText': async (tabId, { text }) => {
    await withDriver(tabId, `window.__joltyF.insertText(${JSON.stringify(text)})`)
    return {}
  },
  'Input.dispatchDragEvent': async () => {
    throw new Error('Dragging a file or text between page parts is not available in Firefox yet. Try a plain click instead.')
  },
  'DOM.setFileInputFiles': async () => {
    throw new Error('Choosing a file to upload is not available in Firefox yet.')
  },
  // Firefox does not keep response bodies for extensions: a GET is fetched again (same cookies, cache first)
  'Network.getResponseBody': async (_tabId, { requestId }) => {
    const req = requests.get(requestId)
    if (!req) throw new Error('This request is not known any more.')
    if (req.method !== 'GET') throw new Error('Only the body of a GET request can be read in Firefox.')
    const r = await fetch(req.url, { credentials: 'include', cache: 'force-cache' })
    const type = r.headers.get('content-type') || ''
    if (/^text\/|json|xml|javascript|svg/i.test(type)) return { body: await r.text(), base64Encoded: false }
    const bytes = new Uint8Array(await r.arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return { body: btoa(bin), base64Encoded: true }
  }
}

// a live picture of the tab: one screenshot after the other, the next one when the app has taken the last
let cast = null
function startScreencast(tabId, p) {
  stopScreencast()
  const c = (cast = { tabId, ack: () => {}, stopped: false })
  const quality = p.quality || 60
  const loop = async () => {
    let n = 0
    while (!c.stopped) {
      try {
        const url = await browser.tabs.captureTab(tabId, { format: 'jpeg', quality })
        if (c.stopped) return
        const wait = new Promise((r) => (c.ack = r))
        say({ type: 'event', tabId, method: 'Page.screencastFrame', params: { data: url.slice(url.indexOf(',') + 1), sessionId: ++n } })
        await Promise.race([wait, sleep(2000)])
      } catch {
        await sleep(500)
      }
      await sleep(250)
    }
  }
  void loop()
}
function stopScreencast() {
  if (cast) cast.stopped = true
  cast = null
}

// ------------------------------------------------------------------ requests from Jolty
const handlers = {
  ping: () => 'pong',
  info: () => ({ version: VERSION, agent: navigator.userAgent }),

  'tabs.list': async () => (await browser.tabs.query({})).map(tabInfo),
  'tabs.get': async ({ tabId }) => tabInfo(await browser.tabs.get(tabId)),

  // the tab the user is looking at right now, in the last focused normal window
  'tabs.current': async () => {
    const [t] = await browser.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' })
    return t ? tabInfo(t) : null
  },

  // a new tab for the model. `windowId` keeps the model's tabs together in one window of its own.
  'tabs.create': async ({ url, windowId, newWindow }) => {
    const want = url || 'about:blank'
    let t
    if (newWindow || !windowId) {
      const w = await browser.windows.create({ url: want, type: 'normal', width: 1280, height: 860 })
      t = w.tabs[0]
    } else t = await browser.tabs.create({ url: want, windowId, active: true })
    return tabInfo(await settleTab(t, want))
  },
  'tabs.update': async ({ tabId, url, active }) => tabInfo(await browser.tabs.update(tabId, { ...(url ? { url } : {}), ...(active ? { active: true } : {}) })),
  'tabs.close': async ({ tabId }) => {
    attached.delete(tabId)
    await browser.tabs.remove(tabId)
  },
  // Firefox has no named tab groups for extensions: the model's tabs are already in a window of their own
  'tabs.group': async () => null,
  'window.bounds': async ({ windowId, width, height, state: s }) => {
    const w = await browser.windows.update(windowId, s ? { state: s } : { state: 'normal', width, height })
    return { width: w.width, height: w.height, state: w.state }
  },
  'window.raise': async ({ windowId }) => {
    await browser.windows.update(windowId, { drawAttention: true })
  },

  'debugger.attach': async ({ tabId }) => {
    await attach(tabId)
  },
  'debugger.detach': async ({ tabId }) => {
    attached.delete(tabId)
    boot.delete(tabId)
  },
  cdp: async ({ tabId, method, params }) => {
    await attach(tabId)
    if (NOOP.has(method)) return {}
    const fn = protocol[method]
    if (!fn) throw new Error(`${method} is not available in Firefox`)
    return fn(tabId, params || {})
  }
}

// ------------------------------------------------------------------ what the browser reports back
const frameOf = (id) => (id === 0 ? 'main' : String(id))
const TYPES = { main_frame: 'Document', sub_frame: 'Document', stylesheet: 'Stylesheet', script: 'Script', image: 'Image', imageset: 'Image', font: 'Font', xmlhttprequest: 'XHR', media: 'Media', websocket: 'WebSocket', ping: 'Ping', beacon: 'Ping', csp_report: 'CSPViolationReport', speculative: 'Prefetch' }

browser.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return
  release(d.tabId)
  if (seen.delete(d.tabId)) return
  gates.set(d.tabId, { held: [], timer: setTimeout(() => release(d.tabId), 400) })
})
browser.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return
  emitPage(d.tabId, 'Page.frameNavigated', { frame: { id: 'main', url: d.url } })
  const a = answers.get(d.tabId)
  if (a) a({})
})
browser.webNavigation.onDOMContentLoaded.addListener((d) => {
  if (d.frameId !== 0 || !attached.has(d.tabId)) return
  emitPage(d.tabId, 'Page.lifecycleEvent', { frameId: 'main', name: 'DOMContentLoaded' })
  const src = boot.get(d.tabId)
  if (src) void run(d.tabId, src).catch(() => {})
})
browser.webNavigation.onCompleted.addListener((d) => {
  if (d.frameId === 0) emitPage(d.tabId, 'Page.lifecycleEvent', { frameId: 'main', name: 'load' })
})
const sameDocument = (d) => {
  if (d.frameId !== 0) return
  emitPage(d.tabId, 'Page.navigatedWithinDocument', { frameId: 'main', url: d.url })
  const a = answers.get(d.tabId)
  if (a) a({})
}
browser.webNavigation.onHistoryStateUpdated.addListener(sameDocument)
browser.webNavigation.onReferenceFragmentUpdated.addListener(sameDocument)
browser.webNavigation.onErrorOccurred.addListener((d) => {
  // a navigation that another one replaced is aborted, not failed
  if (d.frameId !== 0 || /2152398850|NS_BINDING_ABORTED/.test(d.error || '')) return
  const a = answers.get(d.tabId)
  if (a) a({ errorText: d.error || 'navigation failed' })
  // the error page counts as loaded: nothing else will tell the waiting tool
  emitPage(d.tabId, 'Page.lifecycleEvent', { frameId: 'main', name: 'load' })
})

const all = { urls: ['<all_urls>'] }
browser.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0 || !attached.has(d.tabId)) return
    const main = d.type === 'main_frame'
    requests.set(d.requestId, { url: d.url, method: d.method })
    if (requests.size > 500) requests.delete(requests.keys().next().value)
    emit(d.tabId, 'Network.requestWillBeSent', {
      requestId: d.requestId,
      loaderId: main ? d.requestId : 'sub',
      frameId: frameOf(d.frameId),
      type: TYPES[d.type] || 'Other',
      request: { url: d.url, method: d.method }
    })
    if (main) {
      if (gates.has(d.tabId)) release(d.tabId)
      else seen.add(d.tabId)
    }
  },
  all
)
browser.webRequest.onCompleted.addListener(
  (d) => {
    if (d.tabId < 0 || !attached.has(d.tabId)) return
    const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type')
    emit(d.tabId, 'Network.responseReceived', { requestId: d.requestId, response: { status: d.statusCode, mimeType: ct ? String(ct.value).split(';')[0].trim() : '' } })
    emit(d.tabId, 'Network.loadingFinished', { requestId: d.requestId })
  },
  all,
  ['responseHeaders']
)
browser.webRequest.onErrorOccurred.addListener(
  (d) => {
    if (d.tabId < 0 || !attached.has(d.tabId)) return
    emit(d.tabId, 'Network.loadingFailed', { requestId: d.requestId, errorText: d.error })
  },
  all
)

browser.tabs.onCreated.addListener((t) => say({ type: 'tabCreated', tab: tabInfo(t), openerTabId: t.openerTabId }))
browser.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId)
  boot.delete(tabId)
  release(tabId)
  seen.delete(tabId)
  if (cast && cast.tabId === tabId) stopScreencast()
  say({ type: 'tabRemoved', tabId })
})

browser.runtime.onMessage.addListener((m, sender, reply) => {
  const tabId = sender.tab && sender.tab.id
  if (m.t === 'armed?') return Promise.resolve(attached.has(tabId))
  if (m.t === 'console') emitPage(tabId, 'Runtime.consoleAPICalled', { type: m.type === 'warning' ? 'warning' : m.type, args: [{ value: m.text }] })
  else if (m.t === 'exception') emitPage(tabId, 'Runtime.exceptionThrown', { exceptionDetails: { text: m.text, url: m.url, lineNumber: (m.line || 1) - 1 } })
  else if (m.t === 'dialog') emitPage(tabId, 'Page.javascriptDialogOpening', { type: m.type, message: m.message, defaultPrompt: m.defaultPrompt })
  else if (m.type === 'reconnect') {
    if (sock) sock.close()
    retry = 0
    void connect()
    reply(true)
  } else if (m.type === 'status') reply({ state, detail })
})

// the page of this script stays alive, but a ping keeps the socket from idling out
setInterval(() => say({ type: 'ping' }), 15000)
setInterval(() => {
  if (!sock || sock.readyState > WebSocket.OPEN) void connect()
}, 30000)

void connect()
