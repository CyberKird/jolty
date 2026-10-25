// Jolty the mascot must never be in the way: over minutes of sped-up behaviour, in three window sizes, his
// silhouette may not sit over anything clickable (or the newest message) for more than a short grace time, and
// clicks must pass through his layer to what is beneath. Starts its own mock model; needs `electron-vite build`.
import { _electron as electron } from 'playwright-core'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// OBSTRUCT_SIZES=800x600 runs one size
const SIZES = (process.env.OBSTRUCT_SIZES || '800x600,1200x800,1920x1080').split(',').map((s) => s.split('x').map(Number))
const GRACE_MS = 1500
const MOCK_PORT = 8791
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-obstruct-'))
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-obstruct-project-'))
fs.writeFileSync(
  path.join(data, 'profiles.json'),
  JSON.stringify([{ id: 'mock', name: 'Mock', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: `http://127.0.0.1:${MOCK_PORT}`, models: ['mock-model'], vision: false, color: '#e0a23b' }])
)
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lastCwd: project, lastProfileId: 'mock', mascotSounds: false }))

const mock = spawn('python', [path.resolve('test/mocks/mock_anthropic.py'), String(MOCK_PORT)], { stdio: 'ignore' })
const failures = []
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

/** the page's timers run 6x faster, so minutes of idle behaviour fit in seconds (animations keep real time) */
const FAST = () => {
  const st = window.setTimeout.bind(window)
  const si = window.setInterval.bind(window)
  window.__realInterval = si
  window.setTimeout = (f, ms, ...a) => st(f, ms > 400 ? ms / 6 : ms, ...a)
  window.setInterval = (f, ms, ...a) => si(f, ms > 400 ? ms / 6 : ms, ...a)
}

/** samples his silhouette against everything clickable every 100 ms; keeps the longest overlap streak */
const SAMPLER = () => {
  const INTERACTIVE = 'button, a[href], input, textarea, select, summary, [role=button], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=switch], [contenteditable=true]'
  const rep = (window.__obstruct = { worst: 0, who: '', samples: 0, at: '', now: '' })
  let since = 0
  window.__realInterval(() => {
    const m = document.querySelector('.m-hit')
    const mascot = document.querySelector('.mascot')
    if (!m || !mascot) return
    rep.samples++
    // the silhouette, a little inside its box (the hit box is wider than the figure)
    const b = m.getBoundingClientRect()
    const mx = b.width * 0.12
    const my = b.height * 0.08
    const me = { l: b.left + mx, r: b.right - mx, t: b.top + my, b: b.bottom - my }
    let who = ''
    const cands = [...document.querySelectorAll(INTERACTIVE)]
    for (const k of ['.msg-assistant', '.msg-user']) {
      const last = [...document.querySelectorAll(`.messages ${k}`)].at(-1)
      if (last) cands.push(last)
    }
    for (const el of cands) {
      if (el.closest('.mascot')) continue
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      const l = Math.max(me.l, r.left)
      const rr = Math.min(me.r, r.right)
      const t = Math.max(me.t, r.top)
      const bb = Math.min(me.b, r.bottom)
      if (l >= rr || t >= bb) continue
      // really visible there (not scrolled out of, or hidden behind, something): it is in the stack at that point
      const stack = document.elementsFromPoint((l + rr) / 2, (t + bb) / 2)
      if (!stack.some((s) => s === el || el.contains(s))) continue
      who = `${el.tagName}.${String(el.className).slice(0, 40)} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}"`
      break
    }
    const now = performance.now()
    if (!who || mascot.dataset.pose === 'held') since = 0
    else {
      since ||= now
      if (now - since > rep.worst) Object.assign(rep, { worst: now - since, who, at: `${Math.round(b.left)},${Math.round(b.top)} ${mascot.dataset.pose}` })
    }
  }, 100)
}

const app = await electron.launch({
  executablePath: path.resolve('node_modules/.bin/electron'),
  args: ['--no-sandbox', path.resolve('out/main/index.js')],
  env: { ...process.env, JOLTY_DATA_DIR: data, JOLTY_TEST: '1' }
})
console.log('electron pid', app.process().pid, 'mock pid', mock.pid)
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.addInitScript(FAST)
  await win.evaluate(() => localStorage.setItem('jolty-mascot-debug', '1'))
  await win.reload()

  for (const [w, h] of SIZES) {
    // the window may go below its normal minimum here: the app must still hold up in a small one
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => {
      const bw = BrowserWindow.getAllWindows()[0]
      bw.setMinimumSize(1, 1)
      bw.setContentSize(cw, ch)
    }, [w, h])
    await win.waitForTimeout(500)
    const size = await win.evaluate(() => [innerWidth, innerHeight])
    check(size[0] === w && size[1] === h, `${w}x${h}: window has that size (${size.join('x')})`)
    await win.waitForSelector('.mascot')
    await win.waitForTimeout(1500)
    await win.evaluate(SAMPLER)

    // 1. an empty chat, left alone
    await win.waitForTimeout(8000)
    // 2. you type in the composer
    const ta = win.locator('.composer textarea')
    await ta.click()
    for (let i = 0; i < 18; i++) {
      await win.keyboard.type('scriu ceva ', { delay: 20 })
      await win.waitForTimeout(250)
    }
    // 3. a menu is open
    await win.locator('.composer .picker-btn').first().click()
    await win.waitForTimeout(4000)
    await win.keyboard.press('Escape')
    // 4. a conversation with messages, then his own gags
    await ta.fill('salut')
    await win.keyboard.press('Enter')
    await win.waitForSelector('.msg-assistant', { timeout: 60000 })
    for (let i = 0; i < 2; i++) {
      await ta.fill(`inca un mesaj ${i}`)
      await win.keyboard.press('Enter')
      await win.waitForFunction((n) => document.querySelectorAll('.msg-assistant').length > n, i + 1, { timeout: 60000 })
    }
    await win.waitForTimeout(8000)
    // 5. text selected in a message
    await win.locator('.msg-assistant').last().dblclick()
    await win.waitForTimeout(3000)
    await win.evaluate(() => getSelection()?.removeAllRanges())
    await win.waitForTimeout(6000)

    const rep = await win.evaluate(() => window.__obstruct)
    console.log(`  ${w}x${h}: ${rep.samples} samples, worst overlap ${Math.round(rep.worst)} ms ${rep.who} at ${rep.at}`)
    check(rep.samples > 300, `${w}x${h}: sampled the whole run`)
    check(rep.worst <= GRACE_MS, `${w}x${h}: never over anything clickable or the newest message for more than ${GRACE_MS} ms`)

    // a button appearing right under his feet: he gets out from under it
    const st = await win.evaluate(() => {
      const hit = document.querySelector('.m-hit').getBoundingClientRect()
      const b = document.createElement('button')
      b.id = 'probe-under'
      b.textContent = 'x'
      b.style.cssText = `position:fixed;left:${hit.left - 8}px;top:${hit.top + 10}px;width:${hit.width + 16}px;height:${hit.height - 10}px;z-index:10;opacity:0.01`
      document.body.appendChild(b)
      return true
    })
    const left = await win
      .waitForFunction(() => {
        const b = document.getElementById('probe-under').getBoundingClientRect()
        const m = document.querySelector('.m-hit').getBoundingClientRect()
        return m.right < b.left || m.left > b.right || m.bottom < b.top || m.top > b.bottom
      }, null, { timeout: 5000 })
      .then(() => true, () => false)
    check(st && left, `${w}x${h}: leaves the spot when a button appears under him`)
    if (!left) console.log('  stuck:', JSON.stringify(await win.evaluate(() => ({ ...window.__mascot.state(), ...window.__mascot.free(), spot: undefined }))))
    await win.evaluate(() => document.getElementById('probe-under').remove())

    // clicks go through his layer: every point of his box outside the silhouette lands on what is beneath
    const through = await win.evaluate(() => {
      const mascot = document.querySelector('.mascot').getBoundingClientRect()
      const hit = document.querySelector('.m-hit').getBoundingClientRect()
      const canvas = document.querySelector('.m-canvas').getBoundingClientRect()
      let bad = 0
      let n = 0
      for (let x = canvas.left; x < canvas.right; x += 6) {
        for (let y = canvas.top; y < canvas.bottom; y += 6) {
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
          if (x >= hit.left && x <= hit.right && y >= hit.top && y <= hit.bottom) continue
          n++
          if (document.elementFromPoint(x, y)?.closest('.mascot')) bad++
        }
      }
      return { bad, n, pe: ['.mascot', '.m-canvas', '.m-glow', '.mascot-bubble'].map((s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).pointerEvents : 'none' }) }
    })
    check(through.bad === 0 && through.n > 50, `${w}x${h}: clicks pass through his layer outside the silhouette (${through.n} points)`)
    check(through.pe.slice(1).every((v) => v === 'none'), `${w}x${h}: canvas, glow and bubble ignore the pointer`)
    // a real click on a button right beside his canvas edge reaches it
    const real = await win.evaluate(() => {
      const hit = document.querySelector('.m-hit').getBoundingClientRect()
      const canvas = document.querySelector('.m-canvas').getBoundingClientRect()
      const b = document.createElement('button')
      b.id = 'probe-through'
      b.style.cssText = `position:fixed;left:${Math.max(0, Math.min(innerWidth - 22, canvas.left + 4))}px;top:${Math.max(0, Math.min(innerHeight - 22, canvas.top + 4))}px;width:18px;height:18px;z-index:1;opacity:0.01`
      document.body.appendChild(b)
      window.__clicked = 0
      b.addEventListener('click', () => window.__clicked++)
      const r = b.getBoundingClientRect()
      return { x: r.left + 9, y: r.top + 9, inHit: r.left < hit.right && r.right > hit.left && r.top < hit.bottom && r.bottom > hit.top }
    })
    if (!real.inHit) {
      await win.mouse.click(real.x, real.y)
      check((await win.evaluate(() => window.__clicked)) === 1, `${w}x${h}: a click on a button under his canvas edge reaches the button`)
    }
    await win.evaluate(() => document.getElementById('probe-through')?.remove())
  }
  check(errors.length === 0, `no renderer errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await app.close()
  mock.kill()
}
if (failures.length) {
  console.error(`${failures.length} failed`)
  process.exit(1)
}
