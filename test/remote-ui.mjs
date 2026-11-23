// The phone page: a second window with no preload (like a phone's browser) pairs with the running Jolty through
// the phone link, lists the conversations and opens one. Run once and short: it opens two windows.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { measurePhone } from './remote-ui-measure.mjs'

const shots = path.resolve(process.env.SHOTS || 'shots-remote')
fs.mkdirSync(shots, { recursive: true })
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-remote-ui-'))
const PORT = Number(process.env.REMOTE_UI_PORT) || 47823
const items = [
  { kind: 'user', id: 'u1', text: 'Make the bridge deck longer' },
  { kind: 'assistant', id: 'a1', text: 'Done. The deck is now **12 m** long.\n\n```py\nbpy.data.objects["Deck"].scale.x = 1.5\n```' }
]
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Tools', engine: 'claude', auth: 'subscription', color: '#d97757' }]))
// one real conversation and nineteen older ones: the drawer shows the latest fifteen, with a button for the rest
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p1', engine: 'claude', cwd: data, title: 'Blender bridge', permissionMode: 'ask', createdAt: 1, updatedAt: 100 }, ...Array.from({ length: 19 }, (_, i) => ({ id: `o${i}`, profileId: 'p1', engine: 'claude', cwd: data, title: `Older ${i}`, permissionMode: 'ask', createdAt: 1, updatedAt: 50 - i }))]))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: 'en', lastCwd: data }))
fs.writeFileSync(path.join(data, 'remote.json'), JSON.stringify({ enabled: true, port: PORT, devices: [] }))
fs.mkdirSync(path.join(data, 'transcripts'))
fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify(items))

const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron')], env, timeout: 60000 })
try {
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForSelector('.brand-name', { timeout: 60000 })
  // the phone link is a section of Settings, only in the desktop window
  const { code } = await win.evaluate(() => window.jolty.remote.pair())
  assert.match(code, /^[0-9A-F]{10}$/)

  const opened = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, url) => {
    const w = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: true, webPreferences: { sandbox: true } })
    globalThis.__phone = w
    void w.loadURL(url)
  }, `http://127.0.0.1:${PORT}/#pair=${code}`)
  const phone = await opened
  phone.setDefaultTimeout(30000)
  await phone.waitForSelector('.brand-name', { timeout: 60000 })
  // installable on Android and iOS: a manifest with a standalone display and both icon sizes that are really served, the iOS
  // home-screen tags, and the browser bar coloured like the theme's page (it follows a theme change)
  const install = await phone.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]')?.getAttribute('href')
    const m = href ? await (await fetch(href)).json() : {}
    const icons = await Promise.all((m.icons || []).map((i) => fetch(i.src).then((r) => `${i.sizes}:${r.status}`)))
    const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content')
    return { display: m.display, start: m.start_url, icons, ios: meta('apple-mobile-web-app-capable'), touch: Boolean(document.querySelector('link[rel="apple-touch-icon"]')), color: meta('theme-color'), page: getComputedStyle(document.documentElement).getPropertyValue('--black').trim(), viewport: meta('viewport') }
  })
  assert.equal(install.display, 'standalone')
  assert.ok(install.start)
  assert.deepEqual(install.icons.sort(), ['192x192:200', '512x512:200'])
  assert.equal(install.ios, 'yes')
  assert.ok(install.touch, 'an icon for the iOS home screen')
  assert.match(install.viewport, /viewport-fit=cover/, 'the page reaches under the notch and the home bar (safe-area insets apply)')
  assert.equal(install.color.toLowerCase(), install.page.toLowerCase(), 'the browser bar takes the page colour')

  // a phone starts with the sidebar closed, as a drawer: the button opens it
  assert.ok(await phone.evaluate(() => document.documentElement.classList.contains('remote')))
  assert.ok(await phone.evaluate(() => document.querySelector('.app')?.classList.contains('no-sidebar')))
  await phone.locator('.titlebar-btn').first().click()
  await phone.waitForSelector('.session-item')
  // only the pages that work from a phone are offered
  // the drawer scrolls as a whole: the list inside has no scroll of its own to catch the finger
  const drawer = await phone.evaluate(() => {
    const side = getComputedStyle(document.querySelector('.sidebar'))
    const list = getComputedStyle(document.querySelector('.session-list'))
    return { side: side.overflowY, list: list.overflowY }
  })
  assert.equal(drawer.side, 'auto')
  assert.equal(drawer.list, 'visible')
  assert.equal(await phone.locator('.session-item').count(), 15, 'the phone lists the latest 15 conversations')
  await phone.locator('.phone-more').click()
  assert.equal(await phone.locator('.session-item').count(), 20, 'show more lists them all')
  await phone.locator('.phone-more').click()
  assert.equal(await phone.locator('.session-item').count(), 15, 'show less goes back')
  const pages = (await phone.locator('.nav-item').allInnerTexts()).map((t) => t.trim())
  for (const want of ['Settings', 'Skills', 'Usage', 'Scheduled']) assert.ok(pages.some((t) => t.includes(want)), `${want} page is offered`)
  // every page opens on the phone without asking the PC for anything it refuses, and fits the screen
  for (let i = 0; i < pages.length; i++) {
    if (await phone.evaluate(() => document.querySelector('.app')?.classList.contains('no-sidebar'))) {
      await phone.locator('.titlebar-btn').first().click()
      await phone.waitForTimeout(350)
    }
    // the highlight sits on the page in use: rows are 44 px on a phone, and a highlight made for 34 px drifted up a row's height or more
    await phone.waitForTimeout(450)
    const glow = await phone.evaluate(() => {
      const g = document.querySelector('.nav-glow')?.getBoundingClientRect()
      const a = document.querySelector('.nav-item.active')?.getBoundingClientRect()
      return g && a && !document.querySelector('.nav-glow.off') ? { dy: Math.abs(g.top - a.top), dh: Math.abs(g.height - a.height) } : null
    })
    if (glow) assert.ok(glow.dy <= 1 && glow.dh <= 1, `${pages[i]}: the drawer highlight is on its row (off by ${glow.dy} px, ${glow.dh} px tall)`)
    await phone.locator('.nav-item').nth(i).click()
    await phone.waitForSelector('.page', { timeout: 15000 })
    await phone.waitForTimeout(500)
    assert.equal(await phone.locator('.toast.error').count(), 0, `${pages[i]}: no refused call`)
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${pages[i]} fits the screen`)
    // the page is clipped sideways, so a card wider than the screen would only be cut off: measure what is drawn, not the scroll width
    const cut = await phone.evaluate(() =>
      [...document.querySelectorAll('.page *')]
        .filter((e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.right > window.innerWidth + 1 && !e.closest('pre, table, .lib-chips')
        })
        .slice(0, 5)
        .map((e) => `${e.tagName}.${e.className}`)
    )
    assert.deepEqual(cut, [], `${pages[i]}: nothing is cut off at the right`)
    const m = await phone.evaluate(measurePhone)
    assert.deepEqual({ scroll: m.scroll, small: m.small, overlap: m.overlap }, { scroll: [], small: [], overlap: [] }, `${pages[i]}: every control is a 44 px target`)
    await phone.screenshot({ path: path.join(shots, `phone-page-${i}.png`) })
    // Settings on the phone: Animations, kept on the phone and applied at once, without a reload
    if (pages[i].includes('Settings')) {
      const card = phone.locator('.phone-motion')
      assert.equal(await card.count(), 1, 'the phone offers its own Animations setting')
      const mark = await phone.evaluate(() => (window.__noReload = Math.random()))
      const root = () => phone.evaluate(() => ({ cls: document.documentElement.className, saved: localStorage.getItem('jolty-motion') }))
      await card.locator('button', { hasText: 'Reduced' }).click()
      let st = await root()
      assert.ok(st.cls.includes('motion-reduced') && !st.cls.includes('motion-off') && st.saved === 'reduced', 'Reduced applies at once')
      await card.locator('button', { hasText: 'Off' }).click()
      st = await root()
      assert.ok(st.cls.includes('motion-off') && st.cls.includes('reduce-motion') && st.saved === 'off', 'Off stops every animation')
      await card.locator('button', { hasText: 'On' }).click()
      st = await root()
      assert.ok(!/motion-off|motion-reduced|reduce-motion/.test(st.cls) && st.saved === 'on', 'On brings them back')
      assert.equal(await phone.evaluate(() => window.__noReload), mark, 'no reload')
      assert.match(await phone.evaluate(() => document.documentElement.dataset.hz || ''), /^(30|60|90|120)$/, 'the refresh rate is measured and snapped')
      // the system's reduce-motion switch (and Low Power Mode) does not stop the phone's animations: only this setting does
      await phone.emulateMedia({ reducedMotion: 'reduce' })
      const drawerMs = await phone.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.sidebar')).transitionDuration) * 1000)
      assert.ok(drawerMs >= 150, `the drawer still slides with reduced motion asked by the system (${drawerMs} ms)`)
      await phone.emulateMedia({ reducedMotion: null })
    }
  }
  if (await phone.evaluate(() => document.querySelector('.app')?.classList.contains('no-sidebar'))) await phone.locator('.titlebar-btn').first().click()
  await phone.waitForSelector('.session-item')
  assert.equal(await phone.evaluate(() => typeof window.jolty.remote), 'object')
  // the phone cannot manage the link itself
  const denied = await phone.evaluate(() => window.jolty.remote.enable(true).then(() => 'allowed', (e) => e.message))
  assert.match(denied, /Not available from the phone/)
  assert.ok(await phone.evaluate(() => Boolean(localStorage.getItem('jolty-remote-token'))), 'the key is kept on the phone')
  await phone.locator('.session-item').first().click({ position: { x: 10, y: 10 } })
  phone.on('console', (m) => m.type() === 'error' && console.log('phone console:', m.text()))
  await phone.waitForSelector('.msg-assistant .md').catch(async (e) => {
    await phone.screenshot({ path: path.join(shots, 'phone-fail.png') })
    throw e
  })
  assert.match(await phone.locator('.msg-assistant').first().innerText(), /12 m/)
  // the chat keeps following the newest line after a finger touched it (a touch ends with pointercancel, never pointerup), even when the page
  // shrinks and grows under it, as a thinking block does
  const follows = await phone.evaluate(async () => {
    const el = document.querySelector('.messages')
    const inner = el.firstElementChild
    const tick = () => new Promise((r) => setTimeout(r, 120))
    const grow = (h) => {
      const d = document.createElement('div')
      d.style.height = `${h}px`
      d.className = 'probe'
      inner.append(d)
    }
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }))
    // the finger is long gone: the reader's half second is over, what moves the page now is the page
    await new Promise((r) => setTimeout(r, 700))
    grow(1500)
    await tick()
    document.querySelectorAll('.probe').forEach((e) => e.remove())
    await tick()
    grow(1500)
    await tick()
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 3
    document.querySelectorAll('.probe').forEach((e) => e.remove())
    return atEnd
  })
  assert.equal(follows, true, 'the chat still follows the newest line after a touch')

  // choosing a conversation closes the drawer, and the PC-only panels are gone
  assert.ok(await phone.evaluate(() => document.querySelector('.app')?.classList.contains('no-sidebar')))
  assert.equal(await phone.locator('.live').first().isVisible(), false)
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'nothing wider than the screen')
  await phone.screenshot({ path: path.join(shots, 'phone-chat.png') })
  // nothing inside the page reaches past the screen (a code block or table scrolls inside itself), and nothing scrolls sideways
  const wide = await phone.evaluate(() =>
    [...document.querySelectorAll('.app *')]
      .filter((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.right > window.innerWidth + 1 && !e.closest('pre, table, .sidebar') && getComputedStyle(e).position !== 'fixed'
      })
      .slice(0, 6)
      .map((e) => `${e.tagName}.${e.className}`)
  )
  assert.deepEqual(wide, [], 'nothing reaches past the screen')
  assert.equal(await phone.evaluate(() => getComputedStyle(document.querySelector('.messages')).touchAction), 'pan-y pinch-zoom')

  // every theme on the smallest phone, an iPhone and a phone on its side: nothing scrolls sideways or reaches past the screen, every tap
  // target is 44 px and none covers another (test/remote-ui-matrix.mjs runs every screen at seven sizes)
  const size = async (w, h) => {
    await app.evaluate((_e, [w, h]) => globalThis.__phone.setContentSize(w, h), [w, h])
    await phone.waitForFunction(([w, h]) => window.innerWidth === w && window.innerHeight === h, [w, h], { timeout: 5000 })
    await phone.waitForTimeout(400)
  }
  for (const theme of ['volt', 'glass', 'frost']) {
    await win.evaluate((t) => window.jolty.app.saveSettings({ theme: t }), theme)
    await phone.evaluate(() => window.dispatchEvent(new Event('jolty:settings')))
    await phone.waitForFunction((t) => document.documentElement.dataset.theme === t, theme)
    assert.equal((await phone.evaluate(() => document.querySelector('meta[name="theme-color"]').content)).toLowerCase(), (await phone.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--black').trim())).toLowerCase(), `${theme}: the browser bar follows the theme`)
    for (const [w, h] of [[320, 568], [390, 844], [844, 390]]) {
      await size(w, h)
      const m = await phone.evaluate(measurePhone)
      assert.deepEqual({ scroll: m.scroll, edge: m.edge, small: m.small, overlap: m.overlap }, { scroll: [], edge: [], small: [], overlap: [] }, `${theme} ${w}x${h}: the chat fits and every control is reachable`)
    }
  }
  await win.evaluate(() => window.jolty.app.saveSettings({ theme: 'volt' }))
  await phone.evaluate(() => window.dispatchEvent(new Event('jolty:settings')))
  await size(390, 844)
  // a phone on its side is a phone too: the drawer layout, not the desktop's
  assert.ok(await phone.evaluate(() => document.querySelector('.app').classList.contains('no-sidebar')), 'the drawer stays shut after the turns')

  // a finger moves the drawer: a swipe from the left edge opens it, a swipe to the left closes it, a short or low one does nothing
  const touch = await phone.context().newCDPSession(phone)
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  const swipe = async (x0, x1, y = 420) => {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] })
    for (let i = 1; i <= 8; i++) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 8, y }] })
      await phone.waitForTimeout(18)
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await phone.waitForTimeout(500)
  }
  const closed = () => phone.evaluate(() => document.querySelector('.app').classList.contains('no-sidebar'))
  await swipe(4, 40)
  assert.equal(await closed(), true, 'a short pull leaves the drawer shut')
  await swipe(4, 300)
  assert.equal(await closed(), false, 'a swipe from the edge opens the drawer')
  assert.equal(await phone.evaluate(() => document.documentElement.classList.contains('drawer-drag')), false, 'the drag ends')
  await swipe(320, 30)
  assert.equal(await closed(), true, 'a swipe to the left closes it')
  // text is selected (its handles are dragged by the same finger): the drawer stays where it is, from the edge too
  await phone.evaluate(() => {
    const p = document.querySelector('.msg-assistant')
    const r = document.createRange()
    r.selectNodeContents(p)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
  })
  await swipe(4, 300)
  assert.equal(await closed(), true, 'a swipe while text is selected does not pull the drawer')
  await phone.evaluate(() => window.getSelection().removeAllRanges())
  await phone.waitForTimeout(1700)
  // a thumb does not hit the very edge: from 40 px in it opens too, and so does a clear swipe over the chat (nothing selected)
  await swipe(40, 300)
  assert.equal(await closed(), false, 'a swipe from near the edge opens the drawer')
  await swipe(320, 30)
  await swipe(150, 340)
  assert.equal(await closed(), false, 'a clear swipe over the chat opens the drawer')
  await swipe(320, 30)
  // a mostly vertical move is a scroll, not the drawer
  const diagonal = async () => {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 300 }] })
    for (let i = 1; i <= 8; i++) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 150 + i * 6, y: 300 + i * 40 }] })
      await phone.waitForTimeout(18)
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await phone.waitForTimeout(500)
  }
  await diagonal()
  assert.equal(await closed(), true, 'scrolling the chat does not open the drawer')
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await touch.detach()

  // the phone works on its own: a page the PC opens does not move the phone (the data is the same, what is open is each one's own)
  await win.locator('.nav-item', { hasText: 'Usage' }).click()
  await win.waitForSelector('.page')
  await phone.waitForTimeout(800)
  assert.equal(await phone.locator('.msg-assistant .md').count() > 0, true, 'the phone keeps its conversation while the PC goes to another page')

  // the phone stays paired whatever its own storage loses: the IndexedDB copy brings the key back, then the PC's cookie alone is enough
  const paired = async (what) => {
    await phone.waitForSelector('.titlebar-btn', { timeout: 30000 })
    await phone.waitForFunction(() => window.jolty?.sessions.list().then((l) => l.length > 0), null, { timeout: 30000 })
    assert.equal(await phone.locator('input[placeholder="Pairing code"]').count(), 0, `${what}: still paired`)
  }
  await phone.evaluate(() => localStorage.removeItem('jolty-remote-token'))
  await phone.reload()
  await paired('key gone from localStorage')
  assert.ok(await phone.evaluate(() => Boolean(localStorage.getItem('jolty-remote-token'))), 'the key is restored from IndexedDB')
  await phone.evaluate(async () => {
    localStorage.clear()
    await new Promise((r) => {
      const q = indexedDB.deleteDatabase('jolty-remote')
      q.onsuccess = q.onerror = q.onblocked = r
    })
  })
  await phone.reload()
  await paired('all storage cleared, the cookie left')
  // the PC cuts every phone (as when Jolty restarts) and its list of phones is rewritten: the phone comes back by itself, still paired
  await app.evaluate((_e, f) => {
    const fs = process.mainModule.require('fs')
    fs.writeFileSync(f, JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8'))))
  }, path.join(data, 'remote.json'))
  await win.evaluate(() => window.jolty.remote.disconnect())
  await phone.waitForTimeout(1500)
  await paired('after the PC cut the line')

  // the desktop sees the paired phone
  const st = await win.evaluate(() => window.jolty.remote.status())
  assert.equal(st.running, true)
  assert.equal(st.devices.length, 1)
  // a revoked phone is sent back to pairing
  await win.evaluate((id) => window.jolty.remote.revoke(id), st.devices[0].id)
  await phone.waitForSelector('input[placeholder="Pairing code"]', { timeout: 15000 })

  // the PC off: the page opens from the phone's own copy and offers to start the PC. First pair again and set up the agent.
  const again = (await win.evaluate(() => window.jolty.remote.pair())).code
  await win.evaluate(() => window.jolty.remote.wakeSet('https://box.tailnet.ts.net:8443'))
  // only the hash changes, so the page has to be loaded again to read it
  await phone.goto(`http://127.0.0.1:${PORT}/#pair=${again}`)
  await phone.reload()
  await phone.waitForSelector('.titlebar-btn', { timeout: 30000 })
  assert.ok(await phone.evaluate(() => Boolean(localStorage.getItem('jolty-wake'))), 'the phone keeps the way to wake the PC')
  await phone.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  // reload once online so the worker holds this page, then switch the PC's server off
  await phone.reload()
  await phone.waitForSelector('.titlebar-btn', { timeout: 30000 })
  await win.evaluate(() => window.jolty.remote.enable(false))
  await phone.reload()
  await phone.waitForSelector('.offline', { timeout: 30000 })
  assert.match(await phone.locator('.pair-headline').innerText(), /not answering/i)
  assert.equal(await phone.locator('button', { hasText: 'Start the PC' }).count(), 1)
  await phone.screenshot({ path: path.join(shots, 'phone-offline.png') })
  await phone.locator('button', { hasText: 'Start the PC' }).click()
  await phone.waitForFunction(() => /wake agent/i.test(document.querySelector('.pair-error')?.textContent || ''), null, { timeout: 20000 })
  console.log('remote ui ok')
} finally {
  await app.close().catch(() => undefined)
  fs.rmSync(data, { recursive: true, force: true })
}
