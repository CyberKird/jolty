// The phone's conversation follows a streaming answer, and the app always fills the visible area (no band under it).
// An iPhone is imitated: 390x844, finger input, home bar and notch insets, and a visualViewport the test drives by hand, because on
// iOS the keyboard covers the page (only visualViewport shrinks) and the area it reports can be wrong (stale after the keyboard
// went down, short by the status bar in a home screen app). The same checks run in the Safari tab and as a home screen app,
// with the keyboard up, after it went down, with the drawer open and on its side. One Electron, closed at the end.
import assert from 'node:assert/strict'
import path from 'node:path'
import { openPhone } from './remote-ui-phone.mjs'

const PORT = 47837
const W = 390
// the whole window (innerHeight), whatever visualViewport says
const FULL = 'full'
const H = 844

// a long conversation: 70 messages, some with code blocks
const transcript = Array.from({ length: 70 }, (_, i) =>
  i % 2
    ? { kind: 'assistant', id: `a${i}`, text: `Answer ${i}. ${'Some words that wrap over a few lines on a phone. '.repeat(3)}${i % 6 === 1 ? '\n\n```js\nconst x = ' + i + '\nconsole.log(x)\n```' : ''}` }
    : { kind: 'user', id: `u${i}`, text: `Question ${i}` }
)

// runs in the phone page before its own scripts: a visualViewport the test moves, and on request (localStorage) an iPhone home screen app
const init = () => {
  if (location.hostname !== '127.0.0.1') return
  const app = localStorage.getItem('__fakeApp')
  if (app) {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
    Object.defineProperty(navigator, 'userAgent', { get: () => ua })
    Object.defineProperty(navigator, 'standalone', { get: () => true })
    Object.defineProperty(screen, 'width', { get: () => 390 })
    Object.defineProperty(screen, 'height', { get: () => 844 })
  }
  const st = { h: app ? Number(app) : null, top: 0 }
  const vv = new EventTarget()
  Object.defineProperties(vv, {
    height: { get: () => (st.h === null ? innerHeight : Math.min(st.h, innerHeight)) },
    width: { get: () => innerWidth },
    offsetTop: { get: () => st.top },
    offsetLeft: { get: () => 0 },
    pageTop: { get: () => scrollY + st.top },
    pageLeft: { get: () => 0 },
    scale: { get: () => 1 }
  })
  Object.defineProperty(window, 'visualViewport', { get: () => vv, configurable: true })
  addEventListener('resize', () => vv.dispatchEvent(new Event('resize')))
  window.__vv = (h, top = 0) => {
    st.h = h
    st.top = top
    vv.dispatchEvent(new Event('resize'))
  }
}

const p = await openPhone({ port: PORT, prefix: 'jolty-remote-scroll-', transcript, init, size: [W, H] })
const { phone, app } = p
const failures = []
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}
// SHOTS=<dir> keeps a picture of each checked state
const shot = (name) => (process.env.SHOTS ? phone.screenshot({ path: path.join(process.env.SHOTS, `scroll-${name}.png`) }) : undefined)
const frame = () => phone.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

/** where the app, the box and the drawer end, against the bottom of the visible area */
const edges = () =>
  phone.evaluate(() => {
    const vv = window.visualViewport
    const b = (sel) => {
      const el = document.querySelector(sel)
      return el ? Math.round(el.getBoundingClientRect().bottom) : null
    }
    return {
      visible: Math.round(vv.offsetTop + vv.height),
      inner: innerHeight,
      body: b('body'),
      app: b('.app'),
      composer: b('.composer-wrap'),
      drawer: document.querySelector('.app.no-sidebar') ? null : b('.sidebar'),
      kb: document.documentElement.classList.contains('kb'),
      fill: document.documentElement.style.getPropertyValue('--fill-h'),
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      bodyBg: getComputedStyle(document.body).backgroundColor
    }
  })
const fills = async (label, want) => {
  await frame()
  const e = await edges()
  const bottom = want === FULL ? e.inner : want ?? e.visible
  const near = (v) => v !== null && Math.abs(v - bottom) <= 1
  await shot(label.replace(/[^a-z0-9]+/gi, '-'))
  check(near(e.body) && near(e.app), `${label}: app ends at the visible bottom ${bottom} (body ${e.body}, app ${e.app})`)
  if (e.composer !== null) check(near(e.composer), `${label}: the message box sits on the bottom edge (${e.composer})`)
  if (e.drawer !== null) check(near(e.drawer), `${label}: the drawer reaches the bottom (${e.drawer})`)
  return e
}
const gap = () => phone.evaluate(() => {
  const m = document.querySelector('.messages')
  return Math.round(m.scrollHeight - m.scrollTop - m.clientHeight)
})
const top = () => phone.evaluate(() => Math.round(document.querySelector('.messages').scrollTop))

// the largest distance from the end seen right after each growth of the conversation (an observer made after the chat's own runs after it)
const watchGap = () =>
  phone.evaluate(() => {
    const m = document.querySelector('.messages')
    window.__maxGap = 0
    window.__gapObs?.disconnect()
    window.__gapObs = new ResizeObserver(() => (window.__maxGap = Math.max(window.__maxGap, m.scrollHeight - m.scrollTop - m.clientHeight)))
    window.__gapObs.observe(m.firstElementChild)
  })
const maxGap = () => phone.evaluate(() => Math.round(window.__maxGap))

/** streams n chunks into the open conversation from the PC (main process), about 60 per second, code blocks among them */
const stream = (id, n, start = 'live') =>
  app.evaluate(async (_e, [id, n, start]) => {
    const ev = globalThis.joltyTestEvent
    ev({ type: 'status', sessionId: 's1', status: 'running' })
    if (start) ev({ type: 'item', sessionId: 's1', item: { kind: 'assistant', id, text: '' } })
    for (let i = 0; i < n; i++) {
      const d = i % 25 === 24 ? '\n\n```py\nfor i in range(3):\n    print(i)\n```\n\n' : `word${i} `
      ev({ type: 'delta', sessionId: 's1', itemId: id, kind: 'assistant', delta: d })
      if (i % 2) await new Promise((r) => setTimeout(r, 30))
    }
  }, [id, n, start])
const idle = () => app.evaluate(() => globalThis.joltyTestEvent({ type: 'status', sessionId: 's1', status: 'idle' }))
/** a finger drag on the conversation: dy > 0 moves the finger down, which scrolls back up */
const drag = (dy) => p.cdp.send('Input.synthesizeScrollGesture', { x: Math.round(W / 2), y: Math.round(H / 2), xDistance: 0, yDistance: dy, gestureSourceType: 'touch', speed: 3000, preventFling: true })

try {
  const insetsOk = await p.insets({ top: 47, bottom: 34, left: 0, right: 0 })
  console.log(`safe-area insets emulated: ${insetsOk}`)
  await p.theme('glass')

  // ---- the conversation follows
  await p.openChat()
  await p.drawer(false)
  await phone.waitForTimeout(800)
  check((await gap()) <= 2, `opening a long conversation lands at the end (gap ${await gap()})`)

  await watchGap()
  await stream('live1', 120)
  await frame()
  check((await maxGap()) <= 2, `while an answer streams the chat stays at the end (largest gap ${await maxGap()})`)
  check((await gap()) <= 2, `after the stream it is at the end (gap ${await gap()})`)

  // the reader scrolls up by hand while the answer keeps coming: the chat does not move under them
  const streaming = stream('live1', 160, '')
  await phone.waitForTimeout(300)
  await drag(500)
  await phone.waitForTimeout(150)
  const held = await top()
  await streaming
  await phone.waitForTimeout(300)
  const after = await top()
  check(Math.abs(after - held) <= 2 && (await gap()) > 200, `scrolled up during a stream, it stays put (${held} -> ${after}, gap ${await gap()})`)

  // back down to the end by hand: it follows again
  for (let i = 0; i < 6 && (await gap()) > 2; i++) await drag(-1500)
  await phone.waitForTimeout(400)
  await watchGap()
  await stream('live1', 60, '')
  await frame()
  check((await gap()) <= 2 && (await maxGap()) <= 2, `back at the end it follows again (gap ${await gap()}, largest ${await maxGap()})`)
  await idle()

  // the header bar of the glass themes floats over the conversation: at the top the first message starts below it
  // as the reader (a wheel turn just before): a scroll set by a script alone is not the reader's, and the chat would follow the end again
  const readerTo = (y) =>
    phone.evaluate((y) => {
      const m = document.querySelector('.messages')
      m.dispatchEvent(new WheelEvent('wheel', { deltaY: y ? 100 : -100 }))
      m.scrollTop = y === null ? m.scrollHeight : y
    }, y)
  for (let i = 0; i < 12 && ((await top()) > 0 || (await phone.locator('.older-marker').count())); i++) {
    await readerTo(0)
    await phone.waitForTimeout(400)
  }
  const cover = await phone.evaluate(() => {
    const h = document.querySelector('.main > .chat-header').getBoundingClientRect()
    const first = document.querySelector('.messages-inner > :not(.older-marker)').getBoundingClientRect()
    return { header: Math.round(h.bottom), first: Math.round(first.top) }
  })
  check(cover.first >= cover.header, `scrolled to the top, the first message (${cover.first}) is below the header bar (${cover.header})`)

  await readerTo(null)
  await phone.waitForTimeout(400)
  check((await gap()) <= 2, `back at the end (gap ${await gap()})`)

  // ---- the app fills the visible area: Safari tab
  await phone.waitForTimeout(300)
  let e = await fills('Safari tab')
  check(e.htmlBg === e.bodyBg || e.htmlBg !== 'rgba(0, 0, 0, 0)', `behind the app the page has the theme's color (html ${e.htmlBg})`)

  // the keyboard comes up: iOS shrinks only visualViewport; the box sits on the keyboard and the newest message stays in view
  await phone.locator('.composer textarea').focus()
  await phone.evaluate(() => window.__vv(470))
  await phone.waitForTimeout(300)
  e = await fills('keyboard up', 470)
  check(e.kb, 'keyboard up: read as a keyboard (html.kb)')
  check((await gap()) <= 2, `keyboard up: the conversation is still at its end (gap ${await gap()})`)

  // iOS also scrolls the visible area down to the field: the page moves with it
  await phone.evaluate(() => window.__vv(470, 120))
  await phone.waitForTimeout(200)
  await fills('keyboard up, page scrolled by iOS', 590)

  // the keyboard goes down, and iOS keeps reporting the keyboard's height for a while (the stale value): the app fills the screen anyway
  await phone.evaluate(() => document.activeElement.blur())
  await phone.waitForTimeout(300)
  e = await fills('keyboard down, visualViewport stale', FULL)
  check(!e.kb, 'keyboard down: not a keyboard any more')
  await phone.evaluate(() => window.__vv(null))
  await phone.waitForTimeout(200)
  await fills('keyboard down, visualViewport back', FULL)
  check((await gap()) <= 2, `keyboard down: the conversation is still at its end (gap ${await gap()})`)

  // the drawer: it reaches the bottom as well
  await p.drawer(true)
  await fills('drawer open', FULL)
  await p.drawer(false)

  // the box grows with a few lines of text: the end of the conversation stays in view above it
  await phone.locator('.composer textarea').fill('one\ntwo\nthree\nfour\nfive')
  await phone.evaluate(() => document.activeElement.blur())
  await phone.waitForTimeout(400)
  check((await gap()) <= 2, `a taller message box keeps the conversation at its end (gap ${await gap()})`)
  await phone.locator('.composer textarea').fill('')
  await phone.evaluate(() => document.activeElement.blur())

  // on its side
  await p.resize(H, W)
  await phone.waitForTimeout(400)
  await fills('landscape', W)
  check((await gap()) <= 2, `landscape: the conversation is still at its end (gap ${await gap()})`)
  await p.resize(W, H)
  await phone.waitForTimeout(400)
  await fills('portrait again', FULL)

  // ---- a home screen app on an iPhone that reports the visible height 47 px short (the status bar): no band under the app
  await phone.evaluate(() => localStorage.setItem('__fakeApp', '797'))
  await phone.reload()
  await phone.waitForSelector('.brand-name', { timeout: 60000 })
  await phone.waitForTimeout(1200)
  await p.insets({ top: 47, bottom: 34, left: 0, right: 0 })
  e = await fills('home screen app, short visualViewport', FULL)
  check(e.fill === '844px', `home screen app: the page is at least the whole screen (--fill-h ${e.fill})`)
  await p.openChat()
  await p.drawer(false)
  await fills('home screen app, conversation', FULL)
  await p.drawer(true)
  await fills('home screen app, drawer open', FULL)
  await p.drawer(false)
  await phone.locator('.composer textarea').focus()
  await phone.evaluate(() => window.__vv(440))
  await phone.waitForTimeout(300)
  await fills('home screen app, keyboard up', 440)
  await phone.evaluate(() => document.activeElement.blur())
  await phone.waitForTimeout(300)
  await fills('home screen app, keyboard down (stale)', FULL)
  await phone.evaluate(() => localStorage.removeItem('__fakeApp'))

  for (const t of ['volt', 'frost']) {
    await p.theme(t)
    await fills(`theme ${t}`, FULL)
  }
} finally {
  await p.close()
}
if (failures.length) {
  console.log(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nall passed')
