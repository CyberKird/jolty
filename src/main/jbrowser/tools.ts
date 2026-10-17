// The browser tools models can call. Names and arguments follow Playwright MCP's, so the permission
// lists and the habits models already have keep working.
import fs from 'fs'
import path from 'path'
import { keyPress } from './keys'
import type { BrowserService } from './service'
import { NoTabError, type Tab } from './tab'

export type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }
type Args = Record<string, unknown>

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  run(svc: BrowserService, sid: string, args: Args): Promise<ToolResult>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const text = (...parts: string[]): ToolResult => ({ content: [{ type: 'text', text: parts.join('\n\n') }] })

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(`"${name}" is required (a string)`)
  return v
}
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function cur(svc: BrowserService, sid: string): Tab {
  const t = svc.currentOf(sid)
  if (!t || t.dead) throw new NoTabError()
  return t
}

/** A dialog freezes the page: every call except answering it has to wait. */
function free(tab: Tab): void {
  if (tab.dialog) throw new Error(`A JavaScript ${tab.dialog.type} dialog is open (${JSON.stringify(tab.dialog.message)}). Answer it with browser_handle_dialog first.`)
}

async function done(svc: BrowserService, sid: string, tab: Tab, what: string): Promise<ToolResult> {
  await tab.settle()
  return text(`### Result\n${what}`, await svc.state(sid, tab))
}

interface Target {
  x: number
  y: number
  w: number
  h: number
  ok: boolean
  blocker: string
  tag: string
  error?: string
}

/** Scrolls an element into view, makes sure nothing covers it, and shows the cursor on it. */
async function reach(tab: Tab, ref: string, clicking: boolean): Promise<Target> {
  let t: Target | undefined
  for (let i = 0; i < 4; i++) {
    t = await tab.P<Target>('target', ref)
    if (t.error) throw new Error(t.error)
    if (t.ok) break
    // an animation or a closing menu may be in the way for a moment
    await sleep(250)
  }
  if (!t || !t.ok) throw new Error(`Another element covers it${t?.blocker ? ': ' + t.blocker : ''}. Close whatever is in front (a banner, menu or dialog) or scroll, then try again.`)
  await tab.touch([t.x - t.w / 2, t.y - t.h / 2, t.w, t.h, clicking ? 1 : 0])
  await sleep(340)
  // the page may have moved while the cursor travelled
  const again = await tab.P<Target>('target', ref)
  return again.error || !again.ok ? t : again
}

const MODS: Record<string, number> = { Alt: 1, Control: 2, ControlOrMeta: 2, Meta: 4, Shift: 8 }
const modBits = (v: unknown): number => (Array.isArray(v) ? v.reduce((a: number, m) => a | (MODS[String(m)] || 0), 0) : 0)

const ALLOWED_URL = /^(https?:\/\/|about:blank$)/i

/** Only ordinary web pages: local files, the browser's own pages and script URLs stay out of a model's reach. */
function cleanUrl(raw: string): string {
  let u = raw.trim()
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = (/^(localhost|127\.|\[::1\]|\d+\.\d+\.\d+\.\d+)/i.test(u) ? 'http://' : 'https://') + u
  if (!ALLOWED_URL.test(u)) throw new Error(`Only http, https and about:blank pages can be opened (not "${u.split(':')[0]}:").`)
  return u
}

const REF = { type: 'string', description: 'Exact target element ref from the page snapshot (like e12)' }
const ELEMENT = { type: 'string', description: 'Human-readable description of the element, for the permission prompt' }
const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false })
const READ = { readOnlyHint: true }

async function typeInto(tab: Tab, ref: string, value: string, opts: { slowly?: boolean; submit?: boolean }): Promise<string> {
  const target = await reach(tab, ref, true)
  let info = await tab.P<{ editable: boolean; tag?: string; type?: string; error?: string }>('focusForTyping', ref, true)
  if (info.error) throw new Error(info.error)
  if (!info.editable) {
    // a wrapper around the real field: a click usually puts the keyboard in the editable part
    await tab.click(target.x, target.y)
    const active = await tab.P<{ editable: boolean; tag?: string; type?: string; ref?: string }>('active')
    if (!active.editable) throw new Error(`This is a <${info.tag}>, not a text field. Use the ref of the input itself (see the snapshot) or click it first.`)
    if (active.ref) await tab.P('focusForTyping', active.ref, true)
    info = active
  }
  const secret = (info.type || '').toLowerCase() === 'password'
  if (opts.slowly) {
    for (const ch of value) {
      if (ch === '\n') await tab.key(keyPress('Enter').down.concat(keyPress('Enter').up))
      else await tab.key([{ type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }, { type: 'keyUp', key: ch }])
      await sleep(25)
    }
  } else if (value) {
    // a real text insertion: the page sees beforeinput / input events, like typing or pasting
    const rich = await tab.eval<boolean>(`!!window.__joltyP.active().editable && document.activeElement && document.activeElement.isContentEditable`).catch(() => false)
    if (rich && value.includes('\n')) {
      const lines = value.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) await tab.insertText(lines[i])
        if (i < lines.length - 1) await tab.key(keyPress('Enter').down.concat(keyPress('Enter').up))
      }
    } else await tab.insertText(value)
  } else {
    // empty text clears the field
    await tab.key(keyPress('Backspace').down.concat(keyPress('Backspace').up))
  }
  // some controlled or masked inputs swallow typing: set the value the way the framework listens for it
  if (value && !opts.slowly) {
    const now = await tab.P<string | null>('valueOf', ref)
    if (typeof now === 'string' && !now.includes(value.replace(/\n/g, '')) && info.tag !== 'div') await tab.P('setValue', ref, value)
  }
  if (opts.submit) {
    const k = keyPress('Enter')
    await tab.key([...k.down, ...k.up])
  }
  return secret ? `Typed [hidden] into ${await tab.P<string>('label', ref)}` : `Typed ${JSON.stringify(value.length > 80 ? value.slice(0, 80) + '…' : value)} into ${await tab.P<string>('label', ref)}`
}

async function screenshot(tab: Tab, args: Args): Promise<ToolResult> {
  const png = args.type === 'png'
  const base: Record<string, unknown> = { format: png ? 'png' : 'jpeg', ...(png ? {} : { quality: 82 }), captureBeyondViewport: false, fromSurface: true }
  const m = await tab.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number }; cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics')
  let clip: { x: number; y: number; width: number; height: number; scale: number }
  const view = m.cssVisualViewport
  if (typeof args.ref === 'string' && args.ref) {
    await reach(tab, args.ref, false)
    const r = await tab.P<{ x: number; y: number; width: number; height: number } | null>('rectOf', args.ref)
    if (!r) throw new Error(`ref ${args.ref} is not on the page any more: take a new snapshot`)
    clip = { x: r.x, y: r.y, width: Math.max(1, r.width), height: Math.max(1, r.height), scale: 1 }
    base.captureBeyondViewport = true
  } else if (args.fullPage === true) {
    clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 12000), scale: 1 }
    base.captureBeyondViewport = true
  } else {
    clip = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale: 1 }
  }
  // models read images up to about 1568 px on the long side: more only costs tokens
  clip.scale = Math.min(1, 1568 / Math.max(clip.width, clip.height))
  let shot: { data: string } | undefined
  for (let attempt = 0; attempt < 2 && !shot; attempt++) {
    try {
      shot = await tab.send<{ data: string }>('Page.captureScreenshot', { ...base, clip }, 12000)
    } catch (e) {
      // a page that is not on screen may not paint: bring it forward once and try again
      if (attempt) throw e
      await tab.send('Page.bringToFront').catch(() => undefined)
      await sleep(300)
    }
  }
  const text1 = `### Screenshot\n${args.ref ? 'Element ' + args.ref : args.fullPage === true ? 'Full page' : 'Viewport'} of ${tab.url}`
  return { content: [{ type: 'text', text: text1 }, { type: 'image', data: shot!.data, mimeType: png ? 'image/png' : 'image/jpeg' }] }
}

async function drag(tab: Tab, from: Target, to: Target): Promise<string> {
  await tab.send('Input.setInterceptDrags', { enabled: true }).catch(() => undefined)
  tab.dragData = undefined
  try {
    await tab.mouse('mouseMoved', from.x, from.y)
    await tab.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1 })
    const steps = 8
    for (let i = 1; i <= steps; i++) {
      await tab.mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { button: 'left', buttons: 1 })
      await sleep(25)
    }
    await sleep(120)
    if (tab.dragData) {
      // an HTML5 drag: the browser handed over its data, so Jolty plays the drop
      const data = tab.dragData
      for (const type of ['dragEnter', 'dragOver', 'drop']) await tab.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data })
      await tab.mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 })
      return 'dragged (HTML5 drag and drop)'
    }
    await tab.mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 })
    return 'dragged'
  } finally {
    await tab.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
  }
}

const STATIC_TYPES = new Set(['Image', 'Stylesheet', 'Font', 'Media', 'Other', 'Manifest', 'Ping', 'CSPViolationReport', 'Preflight'])

export const TOOLS: ToolDef[] = [
  {
    name: 'browser_navigate',
    description: 'Go to a URL (http or https). Opens a tab of its own if none is open yet.',
    inputSchema: obj({ url: { type: 'string', description: 'The URL to navigate to' } }, ['url']),
    async run(svc, sid, a) {
      const url = cleanUrl(str(a.url, 'url'))
      let tab = svc.currentOf(sid)
      if (!tab || tab.dead) tab = await svc.openTab(sid)
      free(tab)
      svc.touched(tab)
      tab.state = 'loading'
      const r = await tab.send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url }, 45000)
      if (r.errorText) {
        tab.state = 'complete'
        throw new Error(`The page did not load: ${r.errorText} (${url})`)
      }
      if (r.loaderId) await tab.waitLoad(25000)
      else tab.state = 'complete'
      await tab.touch()
      return done(svc, sid, tab, `Opened ${url}`)
    }
  },
  {
    name: 'browser_navigate_back',
    description: 'Go back to the previous page in the tab history.',
    inputSchema: obj({}),
    async run(svc, sid) {
      const tab = cur(svc, sid)
      free(tab)
      const h = await tab.send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory')
      if (h.currentIndex <= 0) throw new Error('There is no earlier page in this tab.')
      tab.state = 'loading'
      await tab.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id })
      await tab.waitLoad(20000)
      return done(svc, sid, tab, 'Went back')
    }
  },
  {
    name: 'browser_snapshot',
    description:
      'Read the current page. Default: roles, names, values and refs of everything on it, to act on it. With mode "text": only the readable text (articles, threads, product pages), far smaller, no refs; long pages come in parts, continue with offset. Pass ref to read only one part of the tree.',
    inputSchema: obj({
      ref: { type: 'string', description: 'Optional: only this element and what is inside it' },
      mode: { type: 'string', enum: ['tree', 'text'], description: 'tree (default) to act on the page, text to read it' },
      offset: { type: 'number', description: 'text mode: character to continue from (the previous answer says where)' },
      maxChars: { type: 'number', description: 'text mode: how much to return at most (default 20000)' }
    }),
    annotations: READ,
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      await tab.touch()
      if (a.mode === 'text') {
        if (tab.state === 'loading') await tab.waitLoad(10000)
        type Read = { text: string; total: number; from: number; to: number; loading?: boolean }
        const offset = Number(a.offset) || 0
        const max = Math.min(Math.max(Number(a.maxChars) || 20000, 1000), 60000)
        let r = await tab.P<Read>('readable', { offset, max })
        for (let i = 0; r.loading && i < 25; i++) {
          await sleep(200)
          r = await tab.P<Read>('readable', { offset, max })
        }
        const header = await svc.state(sid, tab, { snapshot: false })
        const note = r.to < r.total ? `[characters ${r.from}-${r.to} of ${r.total}. Call browser_snapshot with mode "text" and offset ${r.to} for the next part.]` : `[characters ${r.from}-${r.to} of ${r.total}: the end]`
        return text(header, '### Text\n' + (r.text || '(no readable text on this page)'), note)
      }
      return text(await svc.state(sid, tab, { ref: optStr(a.ref), budget: 60000 }))
    }
  },
  {
    name: 'browser_take_screenshot',
    description: 'Take a picture of the page (or one element). Use it to see layout and images; use browser_snapshot to act.',
    inputSchema: obj({
      type: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default jpeg)' },
      ref: REF,
      element: ELEMENT,
      fullPage: { type: 'boolean', description: 'The whole scrollable page instead of the visible part' }
    }),
    annotations: READ,
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      await tab.touch()
      return screenshot(tab, a)
    }
  },
  {
    name: 'browser_click',
    description: 'Click an element of the page.',
    inputSchema: obj(
      {
        element: ELEMENT,
        ref: REF,
        doubleClick: { type: 'boolean', description: 'Double click instead of a single click' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] } }
      },
      ['ref']
    ),
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      const ref = str(a.ref, 'ref')
      const t = await reach(tab, ref, true)
      const label = await tab.P<string>('label', ref)
      if (t.tag === 'select') throw new Error('This is a drop-down: use browser_select_option instead of clicking it.')
      await tab.click(t.x, t.y, { button: (a.button as 'left' | 'right' | 'middle') || 'left', count: a.doubleClick === true ? 2 : 1, modifiers: modBits(a.modifiers) })
      return done(svc, sid, tab, `Clicked ${label}`)
    }
  },
  {
    name: 'browser_hover',
    description: 'Hover the mouse over an element (menus, tooltips).',
    inputSchema: obj({ element: ELEMENT, ref: REF }, ['ref']),
    annotations: READ,
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      const ref = str(a.ref, 'ref')
      const t = await reach(tab, ref, false)
      await tab.mouse('mouseMoved', t.x, t.y)
      return done(svc, sid, tab, `Hovering ${await tab.P<string>('label', ref)}`)
    }
  },
  {
    name: 'browser_type',
    description: 'Type text into an editable element, replacing what is there.',
    inputSchema: obj(
      {
        element: ELEMENT,
        ref: REF,
        text: { type: 'string', description: 'Text to type' },
        submit: { type: 'boolean', description: 'Press Enter afterwards' },
        slowly: { type: 'boolean', description: 'Type one key at a time, for pages that react to every key' }
      },
      ['ref', 'text']
    ),
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      const what = await typeInto(tab, str(a.ref, 'ref'), typeof a.text === 'string' ? a.text : '', { slowly: a.slowly === true, submit: a.submit === true })
      return done(svc, sid, tab, what)
    }
  },
  {
    name: 'browser_fill_form',
    description: 'Fill several form fields at once.',
    inputSchema: obj(
      {
        fields: {
          type: 'array',
          description: 'Fields to fill',
          items: obj(
            {
              name: { type: 'string', description: 'Human-readable field name' },
              type: { type: 'string', enum: ['textbox', 'checkbox', 'radio', 'combobox', 'slider'] },
              ref: REF,
              value: { type: 'string', description: 'The value: text, "true"/"false" for checkboxes, the option for combo boxes' }
            },
            ['name', 'type', 'ref', 'value']
          )
        }
      },
      ['fields']
    ),
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      const fields = Array.isArray(a.fields) ? (a.fields as Args[]) : []
      if (!fields.length) throw new Error('"fields" needs at least one field')
      const out: string[] = []
      for (const f of fields) {
        const ref = str(f.ref, 'ref')
        const value = String(f.value ?? '')
        const kind = String(f.type)
        if (kind === 'checkbox' || kind === 'radio') {
          const want = /^(true|1|yes|on|checked)$/i.test(value)
          const is = await tab.P<boolean | null>('checked', ref)
          if (is === null) throw new Error(`ref ${ref} is not on the page any more: take a new snapshot`)
          if (is !== want) {
            const t = await reach(tab, ref, true)
            await tab.click(t.x, t.y)
          }
          out.push(`${f.name}: ${want ? 'checked' : 'unchecked'}`)
        } else if (kind === 'combobox') {
          const r = await tab.P<{ chosen?: string[]; error?: string }>('selectOption', ref, [value])
          if (r.error) throw new Error(`${f.name}: ${r.error}`)
          out.push(`${f.name}: ${r.chosen!.join(', ')}`)
        } else if (kind === 'slider') {
          await tab.P('setValue', ref, value)
          out.push(`${f.name}: ${value}`)
        } else {
          out.push(await typeInto(tab, ref, value, {}))
        }
      }
      return done(svc, sid, tab, out.join('\n'))
    }
  },
  {
    name: 'browser_select_option',
    description: 'Pick one or more options in a drop-down (<select>).',
    inputSchema: obj({ element: ELEMENT, ref: REF, values: { type: 'array', items: { type: 'string' }, description: 'Option values or labels to select' } }, ['ref', 'values']),
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      const ref = str(a.ref, 'ref')
      const values = (Array.isArray(a.values) ? a.values : []).map(String)
      if (!values.length) throw new Error('"values" needs at least one option')
      await reach(tab, ref, false)
      const r = await tab.P<{ chosen?: string[]; error?: string }>('selectOption', ref, values)
      if (r.error) throw new Error(r.error)
      return done(svc, sid, tab, `Selected ${r.chosen!.map((c) => JSON.stringify(c)).join(', ')}`)
    }
  },
  {
    name: 'browser_press_key',
    description: 'Press a key or a chord on the keyboard: Enter, Tab, Escape, ArrowDown, Control+A, Shift+Tab, F5, or a single character.',
    inputSchema: obj({ key: { type: 'string', description: 'Key name or chord' } }, ['key']),
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      const key = str(a.key, 'key')
      const k = keyPress(key)
      await tab.key([...k.down, ...k.up])
      await tab.touch()
      return done(svc, sid, tab, `Pressed ${key}`)
    }
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page, or an element, up, down, left or right; or jump to the top or bottom.',
    inputSchema: obj({
      ref: { type: 'string', description: 'Optional element to scroll (a list, a panel). Default: the page' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] },
      amount: { type: 'number', description: 'Pixels (default: about one screen)' }
    }, ['direction']),
    annotations: READ,
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      const dir = String(a.direction)
      const scope = optStr(a.ref)
      if (dir === 'top' || dir === 'bottom') {
        await tab.eval(
          `(() => { const P = window.__joltyP; const el = ${scope ? 'P.get(' + JSON.stringify(scope) + ')' : '(document.scrollingElement || document.documentElement)'}; if (el) el.scrollTo({ top: ${dir === 'top' ? 0 : 'el.scrollHeight'}, behavior: 'instant' }) })()`
        )
      } else {
        const view = await tab.eval<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })')
        const px = typeof a.amount === 'number' && a.amount > 0 ? a.amount : Math.round((dir === 'left' || dir === 'right' ? view.w : view.h) * 0.85)
        let x = Math.round(view.w / 2)
        let y = Math.round(view.h / 2)
        if (scope) {
          const t = await tab.P<Target>('target', scope)
          if (t.error) throw new Error(t.error)
          x = t.x
          y = t.y
        }
        const dx = dir === 'left' ? -px : dir === 'right' ? px : 0
        const dy = dir === 'up' ? -px : dir === 'down' ? px : 0
        await tab.mouse('mouseWheel', x, y, { deltaX: dx, deltaY: dy })
        await sleep(350)
      }
      await tab.touch()
      return done(svc, sid, tab, `Scrolled ${dir}`)
    }
  },
  {
    name: 'browser_drag',
    description: 'Drag one element onto another.',
    inputSchema: obj({ startElement: ELEMENT, startRef: REF, endElement: ELEMENT, endRef: REF }, ['startRef', 'endRef']),
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      const from = await reach(tab, str(a.startRef, 'startRef'), true)
      const to = await tab.P<Target>('target', str(a.endRef, 'endRef'))
      if (to.error) throw new Error(to.error)
      const how = await drag(tab, from, to)
      return done(svc, sid, tab, `Element ${how}`)
    }
  },
  {
    name: 'browser_drop',
    description: 'Drop files or data onto an element, as if dragged in from outside the page.',
    inputSchema: obj({
      element: ELEMENT,
      ref: REF,
      paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files to drop (up to 5 MB each)' },
      data: { type: 'object', description: 'Optional drag data by MIME type, e.g. {"text/plain": "hello"}', additionalProperties: { type: 'string' } }
    }, ['ref']),
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      const files = (Array.isArray(a.paths) ? a.paths : []).map((p) => {
        const file = path.resolve(String(p))
        const st = fs.statSync(file)
        if (!st.isFile()) throw new Error(`${file} is not a file`)
        if (st.size > 5 * 1024 * 1024) throw new Error(`${file} is larger than 5 MB`)
        return { name: path.basename(file), base64: fs.readFileSync(file).toString('base64'), type: '' }
      })
      const ref = str(a.ref, 'ref')
      await reach(tab, ref, false)
      const r = await tab.P<{ error?: string }>('drop', ref, files, a.data || {})
      if (r.error) throw new Error(r.error)
      return done(svc, sid, tab, `Dropped ${files.length ? files.length + ' file(s)' : 'data'} on ${await tab.P<string>('label', ref)}`)
    }
  },
  {
    name: 'browser_file_upload',
    description: 'Give files to a page that asked for them: after a click opened a file chooser, or straight into a file input by ref.',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files' }, ref: { type: 'string', description: 'Optional: a file input to fill directly' } }, ['paths']),
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      const files = (Array.isArray(a.paths) ? a.paths : []).map((p) => {
        const file = path.resolve(String(p))
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${file} is not a file that exists`)
        return file
      })
      if (!files.length) throw new Error('"paths" needs at least one file')
      const ref = optStr(a.ref)
      if (ref) {
        if (!(await tab.P<boolean>('fileInput', ref))) throw new Error('That element is not a file input.')
        const obj1 = await tab.send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: `window.__joltyP.get(${JSON.stringify(ref)})` })
        if (!obj1.result.objectId) throw new Error('The file input is not on the page any more: take a new snapshot')
        await tab.send('DOM.setFileInputFiles', { files, objectId: obj1.result.objectId })
      } else if (tab.chooser) {
        await tab.send('DOM.setFileInputFiles', { files: tab.chooser.mode === 'selectMultiple' ? files : files.slice(0, 1), backendNodeId: tab.chooser.backendNodeId })
        tab.chooser = undefined
      } else throw new Error('No file chooser is open. Click the upload button first, or pass the ref of the file input.')
      return done(svc, sid, tab, `Uploaded ${files.length} file${files.length > 1 ? 's' : ''}: ${files.map((f) => path.basename(f)).join(', ')}`)
    }
  },
  {
    name: 'browser_handle_dialog',
    description: 'Accept or dismiss a JavaScript alert, confirm or prompt dialog.',
    inputSchema: obj({ accept: { type: 'boolean', description: 'Accept (OK) or dismiss (Cancel)' }, promptText: { type: 'string', description: 'Text for a prompt dialog' } }, ['accept']),
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      if (!tab.dialog) throw new Error('No dialog is open.')
      const d = tab.dialog
      await tab.send('Page.handleJavaScriptDialog', { accept: a.accept === true, ...(typeof a.promptText === 'string' ? { promptText: a.promptText } : {}) })
      tab.dialog = undefined
      return done(svc, sid, tab, `${a.accept === true ? 'Accepted' : 'Dismissed'} the ${d.type} dialog`)
    }
  },
  {
    name: 'browser_evaluate',
    description: 'Run a JavaScript function in the page and return its result. Example: "() => document.title" or, with ref, "(element) => element.innerText".',
    inputSchema: obj({ function: { type: 'string', description: '() => { ... } or (element) => { ... } when ref is given' }, element: ELEMENT, ref: { type: 'string', description: 'Optional element passed to the function' } }, ['function']),
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      const fn = str(a.function, 'function')
      const ref = optStr(a.ref)
      const expr = `(async () => {
        const P = window.__joltyP
        const el = ${ref ? 'P.get(' + JSON.stringify(ref) + ')' : 'undefined'}
        ${ref ? "if (!el) return { __err: 'ref is not on the page any more: take a new snapshot' }" : ''}
        const f = (${fn})
        const v = await f(el)
        try { const s = JSON.stringify(v === undefined ? null : v, (k, x) => (x instanceof Node ? '<' + x.nodeName.toLowerCase() + '>' : typeof x === 'bigint' ? String(x) : x)); return { v: s && s.length > 40000 ? s.slice(0, 40000) + '… [cut]' : s } } catch (e) { return { v: JSON.stringify(String(v)) } }
      })()`
      const r = await tab.eval<{ v?: string; __err?: string }>(expr)
      if (r.__err) throw new Error(r.__err)
      return text(`### Result\n${r.v ?? 'undefined'}`, await svc.state(sid, tab, { snapshot: false }))
    }
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for text to appear or disappear, or for some seconds to pass.',
    inputSchema: obj({ time: { type: 'number', description: 'Seconds to wait (max 30)' }, text: { type: 'string', description: 'Text to wait for' }, textGone: { type: 'string', description: 'Text to wait to disappear' } }),
    annotations: READ,
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      if (typeof a.time === 'number' && a.time > 0) await sleep(Math.min(a.time, 30) * 1000)
      const want = optStr(a.text)
      const gone = optStr(a.textGone)
      if (want || gone) {
        const end = Date.now() + 30000
        for (;;) {
          const body = await tab.P<string>('text')
          if (want && body.includes(want)) break
          if (gone && !body.includes(gone)) break
          if (Date.now() > end) throw new Error(want ? `"${want}" did not appear within 30 seconds` : `"${gone}" was still there after 30 seconds`)
          await sleep(300)
        }
      }
      return done(svc, sid, tab, want ? `Found "${want}"` : gone ? `"${gone}" is gone` : `Waited ${a.time ?? 0}s`)
    }
  },
  {
    name: 'browser_find',
    description: 'Look for elements by words in their name, role or link, anywhere on the page (also off screen). Returns refs you can act on.',
    inputSchema: obj({ query: { type: 'string', description: 'Words to look for, e.g. "sign in" or "search box"' } }, ['query']),
    annotations: READ,
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      svc.touched(tab)
      const found = await tab.P<{ ref: string; role: string; name: string; inView: boolean }[]>('find', str(a.query, 'query'), 25)
      return text(`### Matches for ${JSON.stringify(a.query)}`, found.length ? found.map((f) => `- ${f.role} ${JSON.stringify(f.name)} [ref=${f.ref}]${f.inView ? '' : ' (off screen)'}`).join('\n') : 'Nothing matches. Try other words, or take a snapshot.')
    }
  },
  {
    name: 'browser_tabs',
    description: 'List, open, switch to or close the tabs Jolty controls in this chat.',
    inputSchema: obj({ action: { type: 'string', enum: ['list', 'new', 'select', 'close'] }, index: { type: 'number', description: 'Tab index for select / close (default: the current tab for close)' }, url: { type: 'string', description: 'URL to open for "new"' } }, ['action']),
    annotations: READ,
    async run(svc, sid, a) {
      const tabs = svc.tabsOf(sid)
      const list = (): string => (tabs.length ? tabs.map((t, i) => `- ${i}:${t === svc.currentOf(sid) ? ' (current)' : ''} [${t.title || 'untitled'}](${t.url})`).join('\n') : 'No tabs are open.')
      const act = String(a.action)
      if (act === 'list') return text('### Tabs', list())
      if (act === 'new') {
        const tab = await svc.openTab(sid)
        if (typeof a.url === 'string' && a.url) {
          tab.state = 'loading'
          const r = await tab.send<{ errorText?: string }>('Page.navigate', { url: cleanUrl(a.url) }, 45000)
          if (r.errorText) throw new Error(`The page did not load: ${r.errorText}`)
          await tab.waitLoad(25000)
        }
        return text('### Result\nOpened a new tab', await svc.state(sid, tab))
      }
      const pick = typeof a.index === 'number' ? tabs[a.index] : svc.currentOf(sid)
      if (!pick) throw new Error(`There is no tab ${a.index ?? ''}. Tabs:\n${list()}`)
      if (act === 'select') {
        svc.select(sid, pick)
        return text('### Result\nSwitched tab', await svc.state(sid, pick))
      }
      if (act === 'close') {
        await svc.closeTab(sid, pick)
        const now = svc.currentOf(sid)
        return text('### Result\nClosed the tab', now ? await svc.state(sid, now) : 'No tabs are open.')
      }
      throw new Error('"action" must be list, new, select or close')
    }
  },
  {
    name: 'browser_use_current_tab',
    description: 'Take over the tab the user is looking at right now (an ordinary web page). Use it only when the user says to work on the page they have open.',
    inputSchema: obj({}),
    async run(svc, sid) {
      const tab = await svc.takeCurrent(sid)
      svc.touched(tab)
      await tab.touch()
      return text('### Result\nWorking in the tab the user has open', await svc.state(sid, tab))
    }
  },
  {
    name: 'browser_close',
    description: 'Close the current tab.',
    inputSchema: obj({}),
    async run(svc, sid) {
      const tab = cur(svc, sid)
      await svc.closeTab(sid, tab)
      const now = svc.currentOf(sid)
      return text('### Result\nClosed the tab', now ? await svc.state(sid, now) : 'No tabs are open.')
    }
  },
  {
    name: 'browser_resize',
    description: 'Resize the browser window of the tab (to test a layout).',
    inputSchema: obj({ width: { type: 'number' }, height: { type: 'number' } }, ['width', 'height']),
    annotations: READ,
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      free(tab)
      const w = Math.round(Number(a.width))
      const h = Math.round(Number(a.height))
      if (!(w >= 200 && w <= 4000 && h >= 200 && h <= 4000)) throw new Error('width and height must be between 200 and 4000')
      await svc.hub.request('window.bounds', { windowId: tab.windowId, width: w, height: h })
      return done(svc, sid, tab, `Window ${w}x${h}`)
    }
  },
  {
    name: 'browser_console_messages',
    description: 'What the page wrote to its console (errors, warnings, logs) since it loaded.',
    inputSchema: obj({ level: { type: 'string', enum: ['error', 'warning', 'info', 'debug'], description: 'Lowest level to show (default info)' } }),
    annotations: READ,
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      const rank: Record<string, number> = { error: 3, warning: 2, info: 1, log: 1, debug: 0 }
      const min = rank[String(a.level || 'info')] ?? 1
      const msgs = tab.console.filter((c) => rank[c.level] >= min).slice(-100)
      return text('### Console', msgs.length ? msgs.map((m) => `- [${m.level.toUpperCase()}] ${m.text}`).join('\n') : 'No messages.')
    }
  },
  {
    name: 'browser_network_requests',
    description: 'The requests the page made (newest last). Scripts, API calls and documents by default; add includeStatic for images, styles and fonts.',
    inputSchema: obj({ includeStatic: { type: 'boolean' } }),
    annotations: READ,
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      const rows = tab.network.filter((n) => a.includeStatic === true || !STATIC_TYPES.has(n.type)).slice(-100)
      return text('### Network requests', rows.length ? rows.map((n, i) => `- ${i}. [${n.method}] ${n.url} => ${n.failed ? 'FAILED ' + n.failed : n.status ?? 'pending'}`).join('\n') : 'No requests recorded.')
    }
  },
  {
    name: 'browser_network_request',
    description: 'Details and response body of one request from browser_network_requests (by its number there).',
    inputSchema: obj({ index: { type: 'number' }, includeStatic: { type: 'boolean', description: 'Use the same value as in the list call' } }, ['index']),
    annotations: READ,
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      const rows = tab.network.filter((n) => a.includeStatic === true || !STATIC_TYPES.has(n.type)).slice(-100)
      const n = rows[Number(a.index)]
      if (!n) throw new Error(`No request ${a.index}`)
      let body = ''
      try {
        const r = await tab.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: n.id })
        body = r.base64Encoded ? '(binary body)' : r.body.length > 20000 ? r.body.slice(0, 20000) + '… [cut]' : r.body
      } catch {
        body = '(no body available)'
      }
      return text(`### ${n.method} ${n.url}`, `- Status: ${n.failed ? 'FAILED ' + n.failed : n.status ?? 'pending'}\n- Type: ${n.type}${n.mime ? ' (' + n.mime + ')' : ''}`, '### Response body\n' + body)
    }
  },
  {
    name: 'browser_emulate_media',
    description: 'Switch the page to dark or light mode, or reduced motion, to check how it looks.',
    inputSchema: obj({ colorScheme: { type: 'string', enum: ['dark', 'light', 'no-preference'] }, reducedMotion: { type: 'string', enum: ['reduce', 'no-preference'] } }),
    annotations: READ,
    async run(svc, sid, a) {
      const tab = cur(svc, sid)
      const features: { name: string; value: string }[] = []
      if (a.colorScheme) features.push({ name: 'prefers-color-scheme', value: String(a.colorScheme) === 'no-preference' ? '' : String(a.colorScheme) })
      if (a.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: String(a.reducedMotion) === 'no-preference' ? '' : String(a.reducedMotion) })
      await tab.send('Emulation.setEmulatedMedia', { features })
      return done(svc, sid, tab, 'Media emulation updated')
    }
  }
]
