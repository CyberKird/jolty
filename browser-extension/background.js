// Jolty browser bridge. It does one thing: relays Chrome DevTools Protocol commands and a few tab
// operations between this browser and the Jolty desktop app, over a WebSocket on 127.0.0.1.
// Nothing leaves the computer. The token in config.json (written by Jolty) proves the caller is Jolty.
'use strict'

const VERSION = chrome.runtime.getManifest().version
const FIRST_PORT = 47820
const PORT_COUNT = 10

let sock = null
let config = null
let retry = 0
let reconnectTimer = 0
let state = 'offline' // offline | connecting | online
const attached = new Set()

const say = (m) => {
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m))
}

function setState(next, detail) {
  state = next
  chrome.storage.session.set({ state: next, detail: detail || '' }).catch(() => {})
  chrome.action.setBadgeText({ text: next === 'online' ? '' : '!' }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ color: '#d03b3b' }).catch(() => {})
}

async function loadConfig() {
  try {
    const r = await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' })
    config = await r.json()
  } catch {
    config = null
  }
  return config
}

async function findHub() {
  const ports = config && Array.isArray(config.ports) && config.ports.length ? config.ports : Array.from({ length: PORT_COUNT }, (_, i) => FIRST_PORT + i)
  for (const port of ports) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/jolty-hello`, { signal: AbortSignal.timeout(900), cache: 'no-store' })
      const j = await r.json()
      if (j && j.app === 'jolty') return port
    } catch {
      // not this port
    }
  }
  return 0
}

async function connect() {
  if (state === 'connecting' || (sock && sock.readyState <= WebSocket.OPEN)) return
  setState('connecting')
  await loadConfig()
  if (!config || !config.token) return fail('no config.json: let Jolty install the extension again')
  const port = await findHub()
  if (!port) return fail('Jolty is not running')
  let ws
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ext`)
  } catch (e) {
    return fail(String(e))
  }
  sock = ws
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: config.token, version: VERSION, agent: navigator.userAgent }))
  ws.onmessage = (m) => onMessage(ws, m)
  ws.onclose = () => {
    if (sock === ws) sock = null
    for (const tabId of attached) chrome.debugger.detach({ tabId }).catch(() => {})
    attached.clear()
    fail('connection closed')
  }
  ws.onerror = () => {}
  // a socket that never opens must not block the next attempt
  setTimeout(() => {
    if (sock === ws && ws.readyState === WebSocket.CONNECTING) ws.close()
  }, 5000)
}

function fail(detail) {
  setState('offline', detail)
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
      const { reloadedFor } = await chrome.storage.local.get('reloadedFor')
      if (reloadedFor !== msg.bundled) {
        await chrome.storage.local.set({ reloadedFor: msg.bundled })
        chrome.runtime.reload()
      }
    }
    return
  }
  if (msg.type === 'reject') {
    setState('offline', msg.reason || 'rejected')
    ws.close()
    return
  }
  if (msg.type === 'pong') return
  if (msg.type === 'reload') {
    chrome.runtime.reload()
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

const tabInfo = (t) => ({ id: t.id, windowId: t.windowId, title: t.title || '', url: t.url || t.pendingUrl || '', active: Boolean(t.active), status: t.status, groupId: t.groupId })

async function attach(tabId) {
  if (attached.has(tabId)) return
  await chrome.debugger.attach({ tabId }, '1.3')
  attached.add(tabId)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Some browsers (Vivaldi) open a new window on their own start page and ignore the URL: there DevTools commands
// get no answer. Pointing the tab at the URL with the tabs API makes it an ordinary page.
async function settleTab(t, want) {
  if (!/^https?:/i.test(want)) return t
  for (let i = 0; i < 40; i++) {
    const cur = await chrome.tabs.get(t.id)
    if (cur.url && cur.url.startsWith(want.split('#')[0]) && cur.status === 'complete') return cur
    if (i === 2 && !(cur.url || '').startsWith(want.split('#')[0])) await chrome.tabs.update(t.id, { url: want }).catch(() => {})
    await sleep(150)
  }
  return chrome.tabs.get(t.id)
}

const handlers = {
  ping: () => 'pong',
  info: () => ({ version: VERSION, agent: navigator.userAgent }),

  'tabs.list': async () => (await chrome.tabs.query({})).map(tabInfo),
  'tabs.get': async ({ tabId }) => tabInfo(await chrome.tabs.get(tabId)),

  // the tab the user is looking at right now, in the last focused normal window
  'tabs.current': async () => {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' })
    return t ? tabInfo(t) : null
  },

  // a new tab for the model. `windowId` keeps the model's tabs together in one window of its own.
  'tabs.create': async ({ url, windowId, newWindow }) => {
    const want = url || 'about:blank'
    let t
    if (newWindow || !windowId) {
      const w = await chrome.windows.create({ url: want, focused: false, type: 'normal', width: 1280, height: 860 })
      t = w.tabs[0]
    } else t = await chrome.tabs.create({ url: want, windowId, active: true })
    return tabInfo(await settleTab(t, want))
  },
  'tabs.update': async ({ tabId, url, active }) => tabInfo(await chrome.tabs.update(tabId, { ...(url ? { url } : {}), ...(active ? { active: true } : {}) })),
  'tabs.close': async ({ tabId }) => {
    attached.delete(tabId)
    await chrome.tabs.remove(tabId)
  },
  // marks the model's tabs: a named group where the browser has tab groups (Chrome, Edge, Brave), a no-op elsewhere
  'tabs.group': async ({ tabIds, groupId, title }) => {
    try {
      const id = await chrome.tabs.group({ tabIds, ...(groupId ? { groupId } : {}) })
      if (!groupId) await chrome.tabGroups.update(id, { title: title || 'Jolty', color: 'yellow', collapsed: false })
      return id
    } catch {
      return null
    }
  },
  'window.bounds': async ({ windowId, width, height, state }) => {
    const w = await chrome.windows.update(windowId, state ? { state } : { state: 'normal', width, height })
    return { width: w.width, height: w.height, state: w.state }
  },
  'window.raise': async ({ windowId }) => {
    await chrome.windows.update(windowId, { drawAttention: true })
  },

  'debugger.attach': async ({ tabId }) => {
    await attach(tabId)
  },
  'debugger.detach': async ({ tabId }) => {
    attached.delete(tabId)
    await chrome.debugger.detach({ tabId }).catch(() => {})
  },
  cdp: async ({ tabId, sessionId, method, params }) => {
    await attach(tabId)
    return chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params || {})
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId) say({ type: 'event', tabId: source.tabId, sessionId: source.sessionId, method, params })
})
chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source.tabId) return
  attached.delete(source.tabId)
  say({ type: 'detached', tabId: source.tabId, reason })
})
chrome.tabs.onCreated.addListener((t) => say({ type: 'tabCreated', tab: tabInfo(t), openerTabId: t.openerTabId }))
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId)
  say({ type: 'tabRemoved', tabId })
})

// the worker sleeps when idle: a ping keeps the socket (and the worker) alive, the alarm revives both
setInterval(() => say({ type: 'ping' }), 15000)
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => {
  if (!sock || sock.readyState > WebSocket.OPEN) void connect()
})
chrome.runtime.onStartup.addListener(() => void connect())
chrome.runtime.onInstalled.addListener(() => void connect())
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m && m.type === 'reconnect') {
    if (sock) sock.close()
    retry = 0
    void connect()
    reply(true)
  }
})

void connect()
