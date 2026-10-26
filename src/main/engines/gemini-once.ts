// One question to Gemini and one answer, for ask_model: a tab of its own on gemini.google.com (a new chat each time),
// the question typed with its files, the answer read when the page has finished it, the tab closed again whatever happens.
// A chat that lives on is GeminiWebSession; this has no state, so it never touches a chat the user has open.
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { tr } from '@shared/i18n'
import type { Attachment } from '@shared/types'
import type { GeminiBrowser, GeminiPage } from './gemini-web'
import { ACCOUNT_SCRIPT, ATTACHED_SCRIPT, CLOSE_MENU_SCRIPT, MENU_SCRIPT, PAGE_LIB, SEND_SCRIPT, STOP_SCRIPT, UPLOAD_SCRIPT, pickScript, typeScript } from './gemini-page'

// not imported from gemini-web: that file imports this one
const GEMINI_APP = 'https://gemini.google.com/app'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface OnceTiming {
  /** between two looks at the page */
  poll: number
  /** how long the answer must stay unchanged and finished */
  settle: number
  /** how long the page may take to start answering */
  start: number
  /** the longest the whole answer may take (a model that thinks for minutes is fine) */
  cap: number
  /** after choosing a model, the menu closes */
  menu: number
}

const TIMING: OnceTiming = { poll: 250, settle: 900, start: 90_000, cap: 300_000, menu: 400 }

interface State {
  responses: number
  busy: boolean
  stop: boolean
  markdown: string
}

const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' }

/** The files the page uploads: those already on disk as they are, bytes written to a folder of their own. */
function toFiles(items: Attachment[]): { files: string[]; cleanup: () => void } {
  let dir: string | undefined
  try {
    const files = items.map((a, i) => {
      if (a.path) return a.path
      if (!a.data) throw new Error('attachment without data')
      dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-gemini-'))
      const file = path.join(dir, `file-${i + 1}${path.extname(a.name || '') || EXT[a.mime] || ''}`)
      fs.writeFileSync(file, Buffer.from(a.data, 'base64'))
      return file
    })
    return { files, cleanup: () => dir && fs.rmSync(dir, { recursive: true, force: true }) }
  } catch (e) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

async function ready(page: GeminiPage): Promise<void> {
  await page.eval(PAGE_LIB)
  for (let i = 0; i < 50; i++) {
    const a = await page.eval<{ composer: boolean; signIn: boolean }>(ACCOUNT_SCRIPT)
    if (a.composer) return
    if (a.signIn && i > 4) break
    await sleep(200)
  }
  throw new Error(tr("Nu ești conectat la Google în browserul Jolty. Deschide gemini.google.com acolo, conectează-te cu abonamentul tău și încearcă din nou."))
}

/** The model of the page, by the name in its menu. A name the menu does not have is an error: an answer from another model would be a lie. */
async function choose(page: GeminiPage, model: string, timing: OnceTiming): Promise<void> {
  const menu = await page.eval<{ ok: boolean; models?: { id: string; title: string; locked: boolean }[] }>(MENU_SCRIPT)
  const open = (menu.models ?? []).filter((m) => !m.locked)
  const row = open.find((m) => m.title === model) ?? open.find((m) => m.title.toLowerCase() === model.toLowerCase())
  if (!row) {
    await page.eval(CLOSE_MENU_SCRIPT)
    throw new Error(`Gemini has no model "${model}" on this account${open.length ? `; it has ${open.map((m) => m.title).join(', ')}` : ''}`)
  }
  await page.eval(pickScript('model', row.id))
  // choosing a model closes the menu
  await sleep(timing.menu)
  await page.eval(CLOSE_MENU_SCRIPT)
}

async function attach(page: GeminiPage, items: Attachment[], timing: OnceTiming): Promise<void> {
  const { files, cleanup } = toFiles(items)
  try {
    await page.upload(UPLOAD_SCRIPT, files)
    // sending before the page has read the files would send the question without them
    for (let i = 0; ; i++) {
      const a = await page.eval<{ count: number; loading: number }>(ATTACHED_SCRIPT)
      if (a.count >= items.length && a.loading === 0) return
      // audio and video take a while to be read by the page
      if (i * timing.poll > timing.cap) throw new Error('the page did not finish reading the files')
      await sleep(timing.poll)
    }
  } finally {
    cleanup()
  }
}

/** The answer, as markdown, once the page has stopped writing it. */
async function answer(page: GeminiPage, before: number, timing: OnceTiming): Promise<string> {
  const started = Date.now()
  let seen = ''
  let changed = Date.now()
  for (;;) {
    const st = await page.eval<State>('window.__joltyGemini.state()')
    if (st.responses > before) {
      if (st.markdown !== seen) {
        seen = st.markdown
        changed = Date.now()
      }
      if (seen && !st.busy && !st.stop && Date.now() - changed >= timing.settle) return seen
    } else if (Date.now() - started > timing.start) {
      throw new Error(`Gemini did not start answering in ${Math.round(timing.start / 1000)} seconds`)
    }
    if (Date.now() - started > timing.cap) {
      await page.eval(STOP_SCRIPT).catch(() => undefined)
      throw new Error(`Gemini did not finish in ${Math.round(timing.cap / 60000)} minutes`)
    }
    await sleep(timing.poll)
  }
}

export async function geminiOnce(browser: GeminiBrowser, prompt: string, files: Attachment[], model?: string, timing: Partial<OnceTiming> = {}): Promise<string> {
  const t = { ...TIMING, ...timing }
  const page = await browser.open(`gemini-once-${randomUUID().slice(0, 8)}`, GEMINI_APP)
  try {
    await ready(page)
    if (model) await choose(page, model, t)
    if (files.length) await attach(page, files, t)
    const before = (await page.eval<State>('window.__joltyGemini.state()')).responses
    const typed = await page.eval<{ ok: boolean; why?: string }>(typeScript(prompt))
    if (!typed.ok) throw new Error(typed.why || 'no message box')
    let sent = false
    for (let i = 0; i < 60 && !sent; i++) {
      await sleep(i ? 150 : 300)
      sent = (await page.eval<{ ok: boolean }>(SEND_SCRIPT)).ok
    }
    if (!sent) throw new Error('Gemini did not take the question (the send button stayed off)')
    return await answer(page, before, t)
  } finally {
    await page.dispose().catch(() => undefined)
  }
}
