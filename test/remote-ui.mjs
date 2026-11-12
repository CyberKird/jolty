// The phone page: a second window with no preload (like a phone's browser) pairs with the running Jolty through
// the phone link, lists the conversations and opens one. Run once and short: it opens two windows.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const shots = path.resolve(process.env.SHOTS || 'shots-remote')
fs.mkdirSync(shots, { recursive: true })
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-remote-ui-'))
const PORT = 47823
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
    const w = new BrowserWindow({ width: 390, height: 844, show: true, webPreferences: { sandbox: true } })
    void w.loadURL(url)
  }, `http://127.0.0.1:${PORT}/#pair=${code}`)
  const phone = await opened
  phone.setDefaultTimeout(30000)
  await phone.waitForSelector('.brand-name', { timeout: 60000 })
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
    await phone.screenshot({ path: path.join(shots, `phone-page-${i}.png`) })
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
