// A paired phone for the phone UI tests: one Electron with a seeded data dir (never the user's), the desktop window, and a second
// window with no preload standing in for the phone's browser. Returns helpers that move the phone between its screens, resize it
// and switch the theme through the real settings. close() ends Electron and removes the data dir.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const long = 'A conversation title that is far too long to fit on one line of a small phone screen'
const items = [
  { kind: 'user', id: 'u1', text: 'Make the bridge deck longer and check C:\\Users\\someone\\Documents\\Projects\\bridge-builder\\scenes\\main_bridge_v12_final.blend' },
  { kind: 'assistant', id: 'a1', text: 'Done. The deck is now **12 m** long.\n\n```py\nbpy.data.objects["Deck"].scale.x = 1.5  # a long line of code that has to scroll inside its own box\n```\n\n| Part | Length | Width | Height | Material |\n|---|---|---|---|---|\n| Deck | 12 m | 3 m | 0.4 m | Concrete |\n\nSee https://example.com/a/very/long/link/that/should/wrap/instead/of/pushing/the/screen/wider' }
]

// transcript replaces the conversation's messages; init is a script run in the phone page before its own (a fake visualViewport)
export async function openPhone({ port, prefix = 'jolty-remote-phone-', lang = 'en', size = [390, 844], transcript = items, init }) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'p1', name: 'Tools', engine: 'claude', auth: 'subscription', color: '#d97757' }, { id: 'p2', name: 'NanoGPT', engine: 'claude', auth: 'endpoint', baseUrl: 'https://nano-gpt.com/api', models: ['zai-org/glm-5'], color: '#7aa2ff' }]))
  fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([{ id: 's1', profileId: 'p2', model: 'zai-org/glm-5', engine: 'claude', cwd: data, title: long, permissionMode: 'ask', createdAt: 1, updatedAt: 100 }, ...Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, profileId: 'p1', engine: 'claude', cwd: data, title: `Older ${i}`, permissionMode: 'ask', createdAt: 1, updatedAt: 50 - i }))]))
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ language: lang, lastCwd: data }))
  fs.writeFileSync(path.join(data, 'remote.json'), JSON.stringify({ enabled: true, port, devices: [] }))
  fs.mkdirSync(path.join(data, 'transcripts'))
  fs.writeFileSync(path.join(data, 'transcripts', 's1.json'), JSON.stringify(transcript))

  const env = { ...process.env, JOLTY_TEST: '1', JOLTY_DATA_DIR: data }
  delete env.ELECTRON_RUN_AS_NODE
  // a window behind others is not drawn by Chromium: the flags keep the phone window painting whatever is on top of it
  const app = await electron.launch({ args: [path.resolve('out/main/index.js'), '--user-data-dir=' + path.join(data, 'electron'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], env, timeout: 60000 })
  const close = async () => {
    await app.close().catch(() => undefined)
    fs.rmSync(data, { recursive: true, force: true })
  }
  try {
    const win = await app.firstWindow()
    win.setDefaultTimeout(30000)
    await win.waitForSelector('.brand-name', { timeout: 60000 })
    const { code } = await win.evaluate(() => window.jolty.remote.pair())
    if (init) await app.context().addInitScript(init)
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }, [url, w, h]) => {
      const bw = new BrowserWindow({ width: w, height: h, useContentSize: true, show: true, webPreferences: { sandbox: true } })
      globalThis.__phone = bw
      void bw.loadURL(url)
    }, [`http://127.0.0.1:${port}/#pair=${code}`, size[0], size[1]])
    const phone = await opened
    phone.setDefaultTimeout(20000)
    await phone.waitForSelector('.brand-name', { timeout: 60000 })
    // a finger, not a mouse: touch events and (pointer: coarse), as on a phone
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

    const isOpen = () => phone.evaluate(() => !document.querySelector('.app')?.classList.contains('no-sidebar'))
    const drawer = async (open) => {
      if ((await isOpen()) === open) return
      if (open) await phone.locator('.titlebar-btn').first().click()
      else await phone.evaluate(() => document.querySelector('.app').dispatchEvent(new MouseEvent('click', { bubbles: true })))
      if ((await isOpen()) !== open) await phone.keyboard.press('Control+b')
      await phone.waitForTimeout(550)
    }
    let kbFrom = null
    const closeAll = async () => {
      await phone.evaluate(() => document.activeElement?.blur?.())
      if (kbFrom) {
        await resize(...kbFrom)
        kbFrom = null
      }
      await phone.keyboard.press('Escape').catch(() => undefined)
      await phone.evaluate(() => document.querySelector('.sheet-scrim')?.click())
      await phone.evaluate(() => document.querySelector('.pcs-top .pcs-icon')?.click())
      await drawer(false)
    }
    const nav = async (label) => {
      await drawer(true)
      await phone.locator('.nav-item', { hasText: label }).first().click()
      await phone.waitForSelector('.page', { timeout: 15000 })
      // the page loads its list and its buttons settle (a button is disabled until then)
      await phone.waitForTimeout(1000)
    }
    const openChat = async () => {
      await drawer(true)
      await phone.locator('.session-item').first().click({ position: { x: 12, y: 12 } })
      await phone.waitForSelector('.msg-assistant .md')
      await phone.waitForTimeout(700)
    }
    const newChat = async () => {
      await drawer(true)
      await phone.locator('.new-chat').first().click()
      await phone.waitForTimeout(700)
      await drawer(false)
    }
    const screens = {
      welcome: newChat,
      chat: openChat,
      drawer: async () => {
        await openChat()
        await drawer(true)
        await phone.waitForTimeout(400)
      },
      // a finger resting on a row that is not the open one (the pressed and hover look)
      'drawer-hover': async () => {
        await openChat()
        await drawer(true)
        await phone.locator('.session-item:not(.active)').first().hover()
        await phone.waitForTimeout(300)
      },
      'model-picker': async () => {
        await openChat()
        await drawer(false)
        await phone.locator('.composer-bar .picker > .picker-btn').first().click()
        await phone.mouse.move(1, 1)
        await phone.waitForTimeout(500)
      },
      // the model menu of a model with every thinking level: the level strip at its foot (7 buttons) must not run into itself
      thinking: async () => {
        await openChat()
        await drawer(false)
        await phone.locator('.composer-bar .picker > .picker-btn').first().click()
        await phone.waitForSelector('.picker-foot .segmented')
        await phone.locator('.picker-foot').scrollIntoViewIfNeeded()
        // a finger leaves no pointer resting on a row (a mouse there would open the row's tooltip over the list)
        await phone.mouse.move(1, 1)
        await phone.waitForTimeout(400)
      },
      folders: async () => {
        await newChat()
        await phone.locator('.cwd-btn').click()
        await phone.waitForTimeout(500)
      },
      settings: () => nav('Settings'),
      accounts: () => nav('Accounts'),
      usage: () => nav('Usage'),
      library: () => nav('Library'),
      schedules: () => nav('Scheduled'),
      skills: () => nav('Skills'),
      system: () => nav('System'),
      // the keyboard is up: the visible area is about half the screen (what remote/phone.ts reads from visualViewport); the box
      // and the newest message have to sit above it
      // (as on Android, where the keyboard shrinks the window while the field has focus; remote/phone.ts reads that as a keyboard)
      keyboard: async () => {
        await openChat()
        await drawer(false)
        await phone.locator('.composer textarea').focus()
        const [w, h] = await phone.evaluate(() => [innerWidth, innerHeight])
        kbFrom = [w, h]
        await resize(w, Math.round(h * 0.55))
        await phone.waitForTimeout(400)
      },
      'pc-screen': async () => {
        await drawer(true)
        await phone.locator('.pc-screen-btn').click()
        await phone.waitForSelector('.pcs-state, .pcs', { timeout: 15000 })
        await phone.waitForTimeout(600)
      }
    }
    async function resize(w, h) {
      await app.evaluate((_e, [w, h]) => globalThis.__phone.setContentSize(w, h), [w, h])
      await phone.waitForFunction(([w, h]) => window.innerWidth === w && window.innerHeight === h, [w, h], { timeout: 5000 }).catch(() => undefined)
      await phone.waitForTimeout(250)
    }
    const theme = async (t) => {
      await win.evaluate((t) => window.jolty.app.saveSettings({ theme: t }), t)
      await phone.evaluate(() => window.dispatchEvent(new Event('jolty:settings')))
      await phone.waitForFunction((t) => document.documentElement.dataset.theme === t, t)
      await phone.waitForTimeout(450)
    }
    // a phone's notch, home bar or gesture bar: Chromium can pretend the screen has them (env(safe-area-inset-*))
    const insets = async (i) => {
      const ok = await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: i || {} }).then(() => true, () => false)
      await phone.waitForTimeout(150)
      return ok
    }
    return { app, win, phone, cdp, data, insets, drawer, closeAll, nav, openChat, newChat, screens, resize, theme, close }
  } catch (e) {
    await close()
    throw e
  }
}
