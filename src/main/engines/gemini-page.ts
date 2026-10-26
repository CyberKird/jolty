// What runs inside the gemini.google.com page: plain JavaScript source, kept as strings so the page gets it exactly as
// written (no bundler helpers). The page is the user's own signed-in Gemini, so every hook is language-neutral: custom
// element names, data-test-ids and aria-busy, never the words the interface shows.

/** HTML of a Gemini answer turned into the markdown Jolty shows. Defines `window.__joltyGemini`. */
export const PAGE_LIB = String.raw`(() => {
  if (window.__joltyGemini) return true
  const SKIP = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'MAT-ICON', 'SVG', 'TOOLTIP', 'SOURCES-CAROUSEL-INLINE', 'SOURCE-FOOTNOTE', 'SOURCES-LIST'])
  const TICK = String.fromCharCode(96)
  const fence = (t) => (t.includes(TICK + TICK + TICK) ? '~~~~' : TICK + TICK + TICK)
  function inline(n) {
    let out = ''
    for (const c of n.childNodes) out += walk(c)
    return out
  }
  function table(t) {
    const rows = [...t.querySelectorAll('tr')].map((r) => [...r.children].map((c) => inline(c).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()))
    if (!rows.length) return ''
    const w = Math.max(...rows.map((r) => r.length))
    const line = (r) => '| ' + Array.from({ length: w }, (_, i) => r[i] || '').join(' | ') + ' |'
    return [line(rows[0]), '| ' + Array(w).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n') + '\n\n'
  }
  function list(el, depth) {
    const ordered = el.tagName === 'OL'
    let i = Number(el.getAttribute('start') || 1)
    let out = ''
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue
      const mark = ordered ? i++ + '. ' : '- '
      let body = ''
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) body += '\n' + list(c, depth + 1).replace(/\n$/, '')
        else body += walk(c)
      }
      out += '  '.repeat(depth) + mark + body.trim().replace(/\n{2,}/g, '\n') + '\n'
    }
    return depth ? out : out + '\n'
  }
  function walk(n) {
    if (n.nodeType === 3) return n.textContent.replace(/\s+/g, ' ')
    if (n.nodeType !== 1) return ''
    const tag = n.tagName
    if (SKIP.has(tag) || n.hidden || n.getAttribute('aria-hidden') === 'true') return ''
    if (tag === 'CODE-BLOCK' || n.classList.contains('code-block')) {
      const code = n.querySelector('code') || n
      const lang = ((n.querySelector('.code-block-decoration span') || {}).textContent || '').trim().toLowerCase()
      const body = code.textContent.replace(/\n$/, '')
      const f = fence(body)
      return f + (lang && lang !== 'plaintext' ? lang : '') + '\n' + body + '\n' + f + '\n\n'
    }
    if (n.classList.contains('math-block') || n.hasAttribute('data-math')) {
      const m = n.getAttribute('data-math') || n.textContent
      return n.classList.contains('math-block') ? '$$\n' + m + '\n$$\n\n' : '$' + m + '$'
    }
    switch (tag) {
      case 'P': return inline(n).trim() + '\n\n'
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return '#'.repeat(Number(tag[1])) + ' ' + inline(n).trim() + '\n\n'
      case 'UL': case 'OL': return list(n, 0)
      case 'BLOCKQUOTE': return inline(n).trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n'
      case 'HR': return '---\n\n'
      case 'BR': return '\n'
      case 'TABLE': return table(n)
      case 'STRONG': case 'B': { const t = inline(n); return t.trim() ? '**' + t.trim() + '**' : t }
      case 'EM': case 'I': { const t = inline(n); return t.trim() ? '*' + t.trim() + '*' : t }
      case 'CODE': return TICK + n.textContent + TICK
      case 'A': { const t = inline(n).trim(); const h = n.getAttribute('href'); return h && t ? '[' + t + '](' + h + ')' : t }
      case 'IMG': return n.getAttribute('alt') ? '![' + n.getAttribute('alt') + '](' + n.src + ')' : ''
      default: return inline(n)
    }
  }
  const lastResponse = () => { const all = document.querySelectorAll('model-response'); return all[all.length - 1] || null }
  window.__joltyGemini = {
    markdown: (el) => walk(el).replace(/\n{3,}/g, '\n\n').trim(),
    state() {
      const r = lastResponse()
      const body = r && r.querySelector('message-content .markdown')
      const send = document.querySelector('.send-button')
      return {
        responses: document.querySelectorAll('model-response').length,
        busy: body ? body.getAttribute('aria-busy') === 'true' : false,
        stop: Boolean(send && send.classList.contains('stop')) || Boolean(document.querySelector('.send-button button[aria-label*="top"], .send-button .stop-icon, .send-button mat-icon[fonticon="stop"]')),
        markdown: body ? window.__joltyGemini.markdown(body) : '',
        composer: Boolean(document.querySelector('rich-textarea .ql-editor')),
        url: location.href
      }
    }
  }
  return true
})()`

/**
 * Puts text into the message box (Quill) as typed text, one editing command for the whole message so the line breaks
 * become paragraphs and Enter is never pressed (it would send). Typing line by line loses everything after the first
 * break, because the editor redraws itself in between; a synthetic paste event is not taken by the page any more.
 * It answers ok only when the text is really in the box.
 */
export const typeScript = (text: string): string => `(async () => {
  const ed = document.querySelector('rich-textarea .ql-editor')
  if (!ed) return { ok: false, why: 'no message box' }
  ed.focus()
  getSelection().selectAllChildren(ed)
  document.execCommand('delete')
  const t = ${JSON.stringify(text.replace(/\r\n?/g, '\n'))}
  document.execCommand('insertText', false, t)
  const flat = (s) => s.replace(/\\s+/g, '')
  for (let i = 0; i < 20 && flat(ed.innerText).length < flat(t).length; i++) await new Promise((r) => setTimeout(r, 50))
  const got = flat(ed.innerText).length
  return { ok: got >= flat(t).length, why: 'the message box took ' + got + ' of ' + flat(t).length + ' characters', length: got }
})()`

/** The send button, once the box has text. */
export const SEND_SCRIPT = `(() => {
  const b = document.querySelector('.send-button button')
  if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return { ok: false }
  b.click()
  return { ok: true }
})()`

/** The stop button while Gemini answers. */
export const STOP_SCRIPT = `(() => {
  const b = document.querySelector('.send-button button')
  if (!b) return false
  b.click()
  return true
})()`

/** Opens the model menu and reads it: the models, the thinking levels and which row is checked. Leaves the menu open. */
export const MENU_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const btn = document.querySelector('[data-test-id=bard-mode-menu-button]')
  if (!btn) return { ok: false }
  if (!document.querySelector('[data-test-id^=bard-mode-option-]')) { btn.click(); for (let i = 0; i < 20 && !document.querySelector('[data-test-id^=bard-mode-option-]'); i++) await sleep(100) }
  const rows = [...document.querySelectorAll('gem-menu-item')]
  const info = (e) => { const lines = e.innerText.split('\\n').map((s) => s.trim()).filter(Boolean); return { title: lines[0] || '', note: lines.slice(1).join(' ') } }
  const models = rows.filter((e) => /^bard-mode-option-/.test(e.getAttribute('data-test-id') || '')).map((e) => ({ id: e.getAttribute('data-test-id'), locked: /upsell/.test(e.getAttribute('data-test-id')), selected: e.classList.contains('selected'), ...info(e) }))
  const plain = rows.filter((e) => !e.getAttribute('data-test-id'))
  // the first row without an id is the heading of the thinking levels, the ones after it are the levels
  const levels = plain.slice(1).map((e) => ({ selected: e.classList.contains('selected'), ...info(e) }))
  return { ok: true, models, levels, current: (btn.innerText || '').trim() }
})()`

/** Clicks a model (by the data-test-id read from the menu) or a thinking level (by position). */
export const pickScript = (kind: 'model' | 'level', key: string | number): string => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const rows = [...document.querySelectorAll('gem-menu-item')]
  const row = ${kind === 'model'
    ? `rows.find((e) => e.getAttribute('data-test-id') === ${JSON.stringify(key)})`
    : `rows.filter((e) => !e.getAttribute('data-test-id')).slice(1)[${Number(key)}]`}
  if (!row) return false
  row.click()
  await sleep(300)
  return true
})()`

/** Closes the model menu if it is still open. */
export const CLOSE_MENU_SCRIPT = `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })); document.body.click(); return true })()`

/** Signed in? The composer is there; and the account's address when the page shows it. */
export const ACCOUNT_SCRIPT = `(() => {
  const composer = Boolean(document.querySelector('rich-textarea .ql-editor'))
  const el = document.querySelector('a[aria-label*="@"], button[aria-label*="@"]')
  const m = el && /[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}/i.exec(el.getAttribute('aria-label') || '')
  return { composer, signIn: /accounts\\.google\\.com/.test(location.host) || Boolean(document.querySelector('a[href*="ServiceLogin"], a[href*="accounts.google.com/signin"]')), email: m ? m[0] : '' }
})()`

/** Opens the add menu and presses "upload files": the browser then reports a file chooser, which the caller fills. */
export const UPLOAD_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const plus = document.querySelector('.menu-button button')
  if (!plus) return false
  plus.click()
  for (let i = 0; i < 20; i++) {
    const up = document.querySelector('[data-test-id=local-images-files-uploader-button]')
    if (up) { up.click(); return true }
    await sleep(100)
  }
  return false
})()`

/** The files sitting in the message box, and how many of them are still being read by the page. */
export const ATTACHED_SCRIPT = `(() => {
  const p = [...document.querySelectorAll('uploader-file-preview')]
  return { count: p.length, loading: p.filter((e) => e.querySelector('mat-progress-spinner, mat-spinner, [role=progressbar], .uploading, .loading')).length }
})()`
