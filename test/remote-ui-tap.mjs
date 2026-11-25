// One tap is enough on a phone. iOS Safari sets :hover on the first tap and, when that hover reveals or moves something (a row's
// buttons fading in, the time giving way to a cross), it swallows the click: the user had to tap twice to open a conversation or a
// menu. Chromium has no such rule, so this test checks what causes it: on a touch screen (hover: none, pointer: coarse) a hover may
// change nothing that is drawn, every :hover rule sits under @media (hover: hover), and a real touch tap on a conversation, a
// menu item and the model menu works the first time. With a mouse (hover: hover) the hover look must still be there.
// One Electron with a seeded data dir (never the user's data), closed at the end. Run: electron-vite build && node test/remote-ui-tap.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openPhone } from './remote-ui-phone.mjs'

const PORT = Number(process.env.REMOTE_UI_PORT) || 47861
const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null
if (shots) fs.mkdirSync(shots, { recursive: true })

const p = await openPhone({ port: PORT, prefix: 'jolty-remote-tap-' })
const { phone, cdp, app } = p
console.log('electron pid', app.process().pid)
const results = []
const check = async (name, fn) => {
  try {
    await fn()
    results.push(['ok', name])
  } catch (e) {
    results.push(['FAIL', name, e.message])
  }
}

const media = async (hover) => {
  // a mouse: no touch emulation (it reports hover: none on its own) and the media features of a desktop
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: !hover, maxTouchPoints: hover ? 1 : 5 })
  await cdp.send('Emulation.setEmulatedMedia', {
    features: hover
      ? [{ name: 'hover', value: 'hover' }, { name: 'any-hover', value: 'hover' }, { name: 'pointer', value: 'fine' }, { name: 'any-pointer', value: 'fine' }]
      : [{ name: 'hover', value: 'none' }, { name: 'any-hover', value: 'none' }, { name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }]
  })
  const want = hover ? '(hover: hover) and (pointer: fine)' : '(hover: none) and (pointer: coarse)'
  assert.ok(await phone.evaluate((q) => matchMedia(q).matches, want), `the phone window does not report ${want}`)
}

/** a finger: touchStart and touchEnd at one point, which Chromium turns into a tap (and the compatibility mouse events a phone sends) */
const tap = async (locator, dx) => {
  const b = await locator.boundingBox()
  assert.ok(b, 'nothing to tap')
  const x = Math.round(b.x + (dx ?? b.width / 2))
  const y = Math.round(b.y + b.height / 2)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 4, radiusY: 4, force: 1 }] })
  await phone.waitForTimeout(60)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** what is drawn for an element and everything inside it: the things iOS watches when it decides that a tap was "only a hover" */
const drawn = (locator) =>
  locator.evaluate((el) =>
    [el, ...el.querySelectorAll('*')].map((n) => {
      const c = getComputedStyle(n)
      return [n.tagName, n.className?.baseVal ?? n.className, c.display, c.visibility, c.opacity, c.transform, c.translate, c.paddingInlineEnd, c.backgroundColor, c.color, c.borderColor].join('|')
    })
  )

/** the hover look of an element: rest the pointer on it (sets :hover in Chromium) and report what changed */
const hoverChanges = async (locator) => {
  await phone.mouse.move(1, 1)
  await phone.waitForTimeout(250)
  // an entrance (a menu opening) is still running: measure once it has ended, so only the hover can change what is drawn
  await locator.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))))
  const before = await drawn(locator)
  await locator.hover({ force: true })
  await phone.waitForTimeout(350)
  const after = await drawn(locator)
  await phone.mouse.move(1, 1)
  return before.flatMap((v, i) => (v === after[i] ? [] : [`${v}  ->  ${after[i]}`]))
}

try {
  await media(false)

  await check('every :hover rule is under @media (hover: hover)', async () => {
    const bare = await phone.evaluate(() => {
      const out = []
      const walk = (rules, hover) => {
        for (const r of rules) {
          if (r instanceof CSSMediaRule) walk(r.cssRules, hover || /hover/.test(r.conditionText))
          else if (r instanceof CSSStyleRule) {
            if (r.selectorText.includes(':hover') && !hover) out.push(r.selectorText)
            if (r.cssRules?.length) walk(r.cssRules, hover)
          } else if (r.cssRules) walk(r.cssRules, hover)
        }
      }
      for (const s of document.styleSheets) {
        try {
          walk(s.cssRules, false)
        } catch {
          // a sheet from another origin cannot be read
        }
      }
      return out
    })
    assert.deepEqual(bare, [])
  })

  await p.openChat()
  await p.drawer(true)
  await phone.waitForTimeout(300)
  if (shots) await phone.screenshot({ path: path.join(shots, 'tap-drawer-touch.png') })

  const other = phone.locator('.session-item:not(.active)').first()
  await check('touch: a hover changes nothing drawn on a conversation row', async () => assert.deepEqual(await hoverChanges(other), []))
  await check('touch: a hover changes nothing drawn on a menu item', async () => assert.deepEqual(await hoverChanges(phone.locator('.nav-item:not(.active)').first()), []))
  await check('touch: the open conversation shows its buttons without a hover, the other rows only their time', async () => {
    const look = (row) => row.locator('.row-act, .del').evaluateAll((els) => els.map((el) => `${getComputedStyle(el).opacity}/${getComputedStyle(el).pointerEvents}`))
    assert.deepEqual(await look(phone.locator('.session-item.active')), ['1/auto', '1/auto'])
    assert.deepEqual(await look(other), ['0/none', '0/none'])
    assert.equal(await other.locator('.when').evaluate((el) => getComputedStyle(el).opacity), '1')
  })

  await check('touch: one tap opens a conversation', async () => {
    const title = (await other.locator('.title').innerText()).trim()
    await tap(other, 40)
    await phone.waitForFunction((t) => document.querySelector('.session-item.active .title')?.textContent?.trim() === t, title, { timeout: 2500 })
  })

  await check('touch: one tap on the pin button pins the conversation', async () => {
    await p.drawer(true)
    await tap(phone.locator('.session-item.active .row-act'))
    await phone.waitForSelector('.session-group.pinned .session-item', { timeout: 2500 })
  })

  await check('touch: one tap on a menu item opens its page', async () => {
    await p.drawer(true)
    await tap(phone.locator('.nav-item', { hasText: 'Settings' }).first())
    await phone.waitForSelector('.page', { timeout: 4000 })
  })

  await check('touch: one tap opens the model menu, one tap picks in it', async () => {
    // the seeded conversation with a transcript (the pinned one now heads the list)
    await p.drawer(true)
    await tap(phone.locator('.session-item', { hasText: 'A conversation title' }).first(), 40)
    await phone.waitForSelector('.msg-assistant .md')
    await p.drawer(false)
    const btn = phone.locator('.composer-bar .picker > .picker-btn').first()
    assert.deepEqual(await hoverChanges(btn), [])
    await tap(btn)
    await phone.waitForSelector('.picker-pop', { state: 'visible', timeout: 2500 })
    if (shots) await phone.screenshot({ path: path.join(shots, 'tap-picker-touch.png') })
    const opt = phone.locator('.picker-pop .picker-opt:not(.active)').first()
    if (await opt.count()) {
      assert.deepEqual(await hoverChanges(opt), [])
      await tap(opt)
      await phone.waitForFunction(() => !document.querySelector('.picker-pop') || getComputedStyle(document.querySelector('.picker-pop')).opacity === '0', null, { timeout: 2500 })
    }
  })

  await check('mouse: the hover look is unchanged', async () => {
    await media(true)
    await phone.keyboard.press('Escape').catch(() => undefined)
    await p.drawer(true)
    const row = phone.locator('.session-item:not(.active)').first()
    const changes = await hoverChanges(row)
    assert.ok(changes.length > 0, 'a hover on a row changes nothing with a mouse')
    await row.hover({ force: true })
    await phone.waitForTimeout(350)
    const o = await row.locator('.row-act').evaluate((el) => getComputedStyle(el).opacity)
    assert.equal(o, '1')
    await phone.mouse.move(1, 1)
    await phone.waitForTimeout(350)
    assert.equal(await phone.locator('.session-item:not(.active)').nth(1).locator('.row-act').evaluate((el) => getComputedStyle(el).opacity), '0')
    if (shots) await phone.screenshot({ path: path.join(shots, 'tap-drawer-mouse.png') })
    await media(false)
  })
} finally {
  await p.close()
}

for (const r of results) console.log(r.join('  '))
const failed = results.filter((r) => r[0] === 'FAIL').length
console.log(failed ? `${failed} failed` : `all ${results.length} passed`)
process.exit(failed ? 1 : 0)
