// The script Jolty runs inside every page it controls. It builds the page snapshot the model reads
// (roles, names and short refs like e12), resolves a ref back to its element for actions, and draws the
// glow / cursor / bolt overlay. Plain JavaScript in a string: it runs in the page, not in Jolty.
import { drawOverlay } from '../browser-overlay'

const VERSION = 7

const BODY = String.raw`
const P = { v: ${VERSION}, n: 0, refs: new Map(), ids: new WeakMap() }
const top = (() => { try { return window.top.__joltyP && window.top.__joltyP.v === ${VERSION} ? window.top.__joltyP : null } catch { return null } })()
// refs are shared across same-origin frames, so a ref means one element wherever it lives
const root = top || P
P.root = root

const ref = (el) => {
  let id = root.ids.get(el)
  if (!id) {
    id = 'e' + ++root.n
    root.ids.set(el, id)
    root.refs.set(id, new WeakRef(el))
  }
  return id
}
const get = (id) => {
  const w = root.refs.get(id)
  const el = w && w.deref()
  return el && el.isConnected ? el : null
}
P.get = get

const ROLE_TAGS = {
  A: (e) => (e.hasAttribute('href') ? 'link' : null),
  BUTTON: () => 'button',
  SUMMARY: () => 'button',
  TEXTAREA: () => 'textbox',
  SELECT: (e) => (e.multiple || e.size > 1 ? 'listbox' : 'combobox'),
  OPTION: () => 'option',
  IMG: (e) => (e.getAttribute('alt') === '' ? null : 'img'),
  H1: () => 'heading', H2: () => 'heading', H3: () => 'heading', H4: () => 'heading', H5: () => 'heading', H6: () => 'heading',
  NAV: () => 'navigation', MAIN: () => 'main', ASIDE: () => 'complementary', FOOTER: () => 'contentinfo', HEADER: () => 'banner',
  UL: () => 'list', OL: () => 'list', LI: () => 'listitem',
  TABLE: () => 'table', TR: () => 'row', TD: () => 'cell', TH: () => 'columnheader',
  DIALOG: () => 'dialog', FORM: (e) => (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('name') ? 'form' : null),
  PROGRESS: () => 'progressbar', METER: () => 'meter',
  INPUT: (e) => {
    const t = (e.getAttribute('type') || 'text').toLowerCase()
    if (t === 'hidden') return null
    if (t === 'checkbox') return 'checkbox'
    if (t === 'radio') return 'radio'
    if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button'
    if (t === 'range') return 'slider'
    if (t === 'number') return 'spinbutton'
    if (t === 'search') return 'searchbox'
    if (t === 'file') return 'filebutton'
    if (t === 'color' || t === 'date' || t === 'datetime-local' || t === 'month' || t === 'time' || t === 'week') return 'textbox'
    return 'textbox'
  }
}
const LEAF = new Set(['button', 'link', 'heading', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider', 'spinbutton', 'img', 'filebutton', 'progressbar', 'meter', 'treeitem'])
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider', 'spinbutton', 'filebutton', 'treeitem'])
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE', 'SVG', 'CANVAS', 'DATALIST', 'PATH'])

const roleOf = (el) => {
  const a = el.getAttribute('role')
  if (a) {
    const r = a.trim().split(/\s+/)[0].toLowerCase()
    if (r && r !== 'presentation' && r !== 'none' && r !== 'generic') return r
  }
  const f = ROLE_TAGS[el.tagName]
  return f ? f(el) : null
}

const clean = (s, max) => {
  s = (s || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

const styleOf = (el) => {
  try { return el.ownerDocument.defaultView.getComputedStyle(el) } catch { return null }
}

const hidden = (el) => {
  if (el.hasAttribute('hidden') && !el.hasAttribute('data-jolty-keep')) return true
  if (el.getAttribute('aria-hidden') === 'true') return true
  if (el.hasAttribute('inert')) return true
  const cs = styleOf(el)
  if (!cs) return false
  if (cs.display === 'none') return true
  if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'self'
  return false
}

const textOf = (el, max) => {
  let out = ''
  const walk = (n) => {
    if (out.length > max) return
    if (n.nodeType === 3) { out += n.nodeValue + ' '; return }
    if (n.nodeType !== 1 || SKIP.has(n.tagName) || hidden(n)) return
    if (n.shadowRoot) { for (const c of n.shadowRoot.childNodes) walk(c); return }
    for (const c of n.childNodes) walk(c)
  }
  walk(el)
  return clean(out, max)
}

const labelsOf = (el) => {
  const doc = el.ownerDocument
  const out = []
  if (el.id) for (const l of doc.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]')) out.push(textOf(l, 120))
  const wrap = el.closest && el.closest('label')
  if (wrap) out.push(textOf(wrap, 120))
  return out.filter(Boolean).join(' ')
}

const nameOf = (el, role) => {
  const doc = el.ownerDocument
  const by = el.getAttribute('aria-labelledby')
  if (by) {
    const t = by.split(/\s+/).map((id) => { const e = doc.getElementById(id); return e ? textOf(e, 120) : '' }).filter(Boolean).join(' ')
    if (t) return clean(t, 160)
  }
  const al = el.getAttribute('aria-label')
  if (al && al.trim()) return clean(al, 160)
  const tag = el.tagName
  if (tag === 'IMG') return clean(el.getAttribute('alt') || el.getAttribute('title') || '', 160)
  if (tag === 'INPUT') {
    const t = (el.getAttribute('type') || 'text').toLowerCase()
    if (t === 'button' || t === 'submit' || t === 'reset') return clean(el.value || el.getAttribute('title') || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : ''), 160)
    if (t === 'image') return clean(el.getAttribute('alt') || el.getAttribute('title') || 'Submit', 160)
    const l = labelsOf(el)
    return clean(l || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '', 160)
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') return clean(labelsOf(el) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '', 160)
  if (tag === 'OPTION') return clean(el.label || el.textContent, 120)
  if (LEAF.has(role) || role === 'columnheader') {
    const t = textOf(el, 160)
    if (t) return t
    // an icon link or button: its picture says what it is
    const inner = el.querySelector('img[alt]:not([alt=""]), [aria-label], svg title, [title]')
    if (inner) {
      const v = inner.getAttribute('alt') || inner.getAttribute('aria-label') || inner.getAttribute('title') || inner.textContent
      if (v && v.trim()) return clean(v, 160)
    }
  }
  return clean(el.getAttribute('title') || '', 160)
}

const pointerCursor = (el) => {
  const cs = styleOf(el)
  if (!cs || cs.cursor !== 'pointer') return false
  const p = el.parentElement
  const ps = p && styleOf(p)
  return !(ps && ps.cursor === 'pointer')
}

const states = (el, role) => {
  const s = []
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled')
  if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
    if (el.checked === true || el.getAttribute('aria-checked') === 'true') s.push('checked')
    else if (el.getAttribute('aria-checked') === 'mixed' || el.indeterminate) s.push('mixed')
  }
  const ex = el.getAttribute('aria-expanded')
  if (ex === 'true') s.push('expanded')
  else if (ex === 'false') s.push('collapsed')
  if (el.getAttribute('aria-selected') === 'true' || (el.tagName === 'OPTION' && el.selected)) s.push('selected')
  if (el.getAttribute('aria-pressed') === 'true') s.push('pressed')
  if (el.required || el.getAttribute('aria-required') === 'true') s.push('required')
  if (el.readOnly) s.push('readonly')
  if (el.getAttribute('aria-invalid') === 'true') s.push('invalid')
  if (el.ownerDocument.activeElement === el) s.push('focused')
  if (role === 'heading') s.push('level=' + (el.getAttribute('aria-level') || el.tagName.slice(1) || 2))
  return s
}

const q = (s) => JSON.stringify(s)

// A snapshot is a list of lines "indent|text". Budget keeps a huge page from flooding the model.
const snapshotOf = (start, budget) => {
  const lines = []
  let used = 0
  let dropped = 0
  const push = (depth, text) => {
    if (used > budget) { dropped++; return }
    lines.push('  '.repeat(depth) + text)
    used += text.length + depth * 2 + 1
  }
  const emitText = (depth, t, last) => {
    t = clean(t, 400)
    if (t) push(depth, '- text: ' + q(t))
  }
  // returns nothing; emits into lines. pending text merges adjacent text nodes of one parent.
  const visit = (node, depth, acc) => {
    if (node.nodeType === 3) {
      acc.text += node.nodeValue + ' '
      return
    }
    if (node.nodeType !== 1) return
    const el = node
    if (SKIP.has(el.tagName.toUpperCase())) return
    const h = hidden(el)
    if (h === true) return
    const flush = () => { if (acc.text.trim()) emitText(depth, acc.text); acc.text = '' }
    const doc = el.ownerDocument
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      flush()
      let inner = null
      try { inner = el.contentDocument } catch { inner = null }
      const id = ref(el)
      if (inner && inner.body) {
        push(depth, '- iframe' + (el.title ? ' ' + q(clean(el.title, 80)) : '') + ' [ref=' + id + ']:')
        const sub = { text: '' }
        for (const c of inner.body.childNodes) visit(c, depth + 1, sub)
        if (sub.text.trim()) emitText(depth + 1, sub.text)
      } else {
        push(depth, '- iframe' + (el.title ? ' ' + q(clean(el.title, 80)) : '') + ' [ref=' + id + '] [cross-origin: contents not readable]')
      }
      return
    }
    const role = roleOf(el)
    const clickable = !role && (el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.getAttribute('tabindex') !== null) || pointerCursor(el)) && textOf(el, 160)
    if (h === 'self' && !role) {
      // invisible itself but its children may show
      for (const c of el.childNodes) visit(c, depth, acc)
      return
    }
    if (!role && !clickable) {
      // transparent wrapper: its text and children flow into the parent
      if (el.shadowRoot) {
        for (const c of el.shadowRoot.childNodes) visit(c, depth, acc)
      } else if (el.tagName === 'SLOT') {
        const kids = el.assignedNodes({ flatten: true })
        for (const c of kids.length ? kids : el.childNodes) visit(c, depth, acc)
      } else {
        // block-level elements end a run of text
        const cs = styleOf(el)
        const block = cs && (cs.display === 'block' || cs.display === 'flex' || cs.display === 'grid' || cs.display === 'list-item' || cs.display === 'table')
        if (block) flush()
        for (const c of el.childNodes) visit(c, depth, acc)
        if (block) flush()
      }
      return
    }
    flush()
    const eff = role || 'generic'
    let name = nameOf(el, eff)
    const st = states(el, eff)
    const id = ref(el)
    let line = '- ' + eff
    if (name) line += ' ' + q(name)
    if (clickable && !role) line += ' [clickable]'
    for (const s of st) line += ' [' + s + ']'
    line += ' [ref=' + id + ']'
    let value = ''
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'password') value = el.value ? '••••••' : ''
      else if (t !== 'checkbox' && t !== 'radio' && t !== 'button' && t !== 'submit' && t !== 'reset' && t !== 'image' && t !== 'file') value = clean(el.value, 200)
      if (t === 'file') value = el.files && el.files.length ? Array.from(el.files).map((f) => f.name).join(', ') : ''
    } else if (el.tagName === 'SELECT') {
      value = Array.from(el.selectedOptions).map((o) => clean(o.label || o.textContent, 80)).join(', ')
    } else if (el.isContentEditable && (el.getAttribute('role') === 'textbox' || el.getAttribute('contenteditable') !== null)) {
      value = clean(el.textContent, 200)
    }
    if (value) line += ': ' + q(value)
    const kids = []
    if (eff === 'link' && el.href) {
      // same-site links are shortened to their path: the page already says where it is
      let shown = el.href
      try { const u = new URL(el.href); if (u.origin === location.origin) shown = u.pathname + u.search + u.hash } catch {}
      line += ' → ' + clean(shown, 200)
    }
    if (el.tagName === 'SELECT') {
      let n = 0
      for (const o of el.options) {
        if (n++ >= 40) { kids.push('- option … (' + (el.options.length - 40) + ' more)'); break }
        kids.push('- option ' + q(clean(o.label || o.textContent, 80)) + (o.selected ? ' [selected]' : '') + (o.disabled ? ' [disabled]' : ''))
      }
    }
    const leaf = LEAF.has(eff) || eff === 'generic'
    if (leaf && !kids.length) {
      push(depth, line)
      return
    }
    if (leaf) {
      push(depth, line + ':')
      for (const k of kids) push(depth + 1, k)
      return
    }
    // page chrome with dozens of links (menus, footers, sidebars) costs thousands of tokens and is rarely needed:
    // one line says what it is, and browser_snapshot with its ref opens it
    if ((eff === 'navigation' || eff === 'contentinfo' || eff === 'complementary') && el !== start) {
      const n = el.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=link], [role=menuitem]').length
      if (n > 12) {
        push(depth, line + ' (' + n + ' links and buttons; browser_snapshot with this ref opens it)')
        return
      }
    }
    // a container: its own line, then its children one level deeper
    const mark = lines.length
    push(depth, line + ':')
    const sub = { text: '' }
    const kidsOf = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes
    for (const c of kidsOf) visit(c, depth + 1, sub)
    if (sub.text.trim()) emitText(depth + 1, sub.text)
    if (lines.length === mark + 1) lines[mark] = lines[mark].replace(/:$/, '')
    if (lines.length === mark + 1 && !name && eff !== 'dialog' && eff !== 'main' && eff !== 'navigation') lines.pop()
  }
  const acc = { text: '' }
  visit(start, 0, acc)
  if (acc.text.trim()) emitText(0, acc.text)
  if (dropped) lines.push('- … ' + dropped + ' more lines left out (page is long): scroll, or use browser_find to look for something specific')
  return lines.join('\n')
}

P.snapshot = (opts) => {
  opts = opts || {}
  if (!opts.ref && !document.body) return { loading: true }
  const start = opts.ref ? get(opts.ref) : document.body
  if (!start) return { error: 'ref ' + opts.ref + ' is not on the page any more: take a new snapshot' }
  const doc = document.scrollingElement || document.documentElement
  return {
    url: location.href,
    title: document.title,
    text: snapshotOf(start, opts.budget || 45000),
    scroll: { y: Math.round(doc.scrollTop), height: doc.scrollHeight, view: window.innerHeight },
    focus: document.activeElement && document.activeElement !== document.body ? ref(document.activeElement) : null
  }
}

const words = (s) => s.toLowerCase().split(/\s+/).filter(Boolean)

P.find = (query, limit) => {
  const wanted = words(query)
  const out = []
  const scan = (rootNode) => {
    const all = rootNode.querySelectorAll('*')
    for (const el of all) {
      if (out.length >= limit) return
      if (SKIP.has(el.tagName.toUpperCase()) || hidden(el)) continue
      if (el.shadowRoot) scan(el.shadowRoot)
      if (el.tagName === 'IFRAME') { try { if (el.contentDocument) scan(el.contentDocument) } catch {} }
      const role = roleOf(el)
      const clickable = !role && pointerCursor(el)
      if (!role && !clickable) continue
      const name = nameOf(el, role || 'generic') || textOf(el, 120)
      const hay = (name + ' ' + (role || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('href') || '')).toLowerCase()
      if (wanted.every((w) => hay.includes(w))) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        out.push({ ref: ref(el), role: role || 'generic', name: clean(name, 100), inView: r.bottom > 0 && r.top < window.innerHeight })
      }
    }
  }
  scan(document)
  return out
}

// viewport coordinates of an element's center, after scrolling it into view and checking nothing covers it
P.target = (id, opts) => {
  opts = opts || {}
  const el = get(id)
  if (!el) return { error: 'ref ' + id + ' is not on the page any more: take a new snapshot' }
  if (el.disabled && !opts.force) return { error: 'the element is disabled' }
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch {}
  const rects = el.getClientRects()
  const r = rects.length ? el.getBoundingClientRect() : null
  if (!r || (r.width === 0 && r.height === 0)) return { error: 'the element has no size on screen (hidden or collapsed)' }
  let x = r.left + r.width / 2
  let y = r.top + r.height / 2
  const win = el.ownerDocument.defaultView
  // the point inside the element's own document, for the hit test
  const hit = el.ownerDocument.elementFromPoint(Math.min(Math.max(x, 1), win.innerWidth - 1), Math.min(Math.max(y, 1), win.innerHeight - 1))
  let ok = !hit || hit === el || el.contains(hit) || (hit.shadowRoot && hit.shadowRoot.contains(el)) || (hit.closest && hit.closest('label') && hit.closest('label').control === el)
  if (!ok && el.getRootNode() instanceof ShadowRoot) ok = el.getRootNode().host === hit || el.getRootNode().host.contains(hit)
  let blocker = ''
  if (!ok && hit) blocker = hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ' "' + clean(hit.textContent, 40) + '"'
  let w = win
  while (w !== w.top) {
    const fe = w.frameElement
    if (!fe) break
    const fr = fe.getBoundingClientRect()
    x += fr.left + fe.clientLeft
    y += fr.top + fe.clientTop
    w = w.parent
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height), ok, blocker, tag: el.tagName.toLowerCase() }
}

P.rectOf = (id) => {
  const el = get(id)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }
}

P.label = (id) => {
  const el = get(id)
  if (!el) return id
  const role = roleOf(el) || 'element'
  const name = nameOf(el, role) || textOf(el, 60)
  return role + (name ? ' "' + clean(name, 60) + '"' : '')
}

// focus an element for typing; returns whether it takes text
P.focusForTyping = (id, replace) => {
  const el = get(id)
  if (!el) return { error: 'ref ' + id + ' is not on the page any more: take a new snapshot' }
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch {}
  el.focus()
  const tag = el.tagName
  const editable = tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|color|range)$/i.test(el.getAttribute('type') || 'text')) || el.isContentEditable
  if (!editable) return { editable: false, tag: tag.toLowerCase() }
  if (replace) {
    if (el.isContentEditable) {
      const rg = el.ownerDocument.createRange()
      rg.selectNodeContents(el)
      const sel = el.ownerDocument.defaultView.getSelection()
      sel.removeAllRanges()
      sel.addRange(rg)
    } else {
      try { el.select() } catch {}
      try { el.setSelectionRange(0, (el.value || '').length) } catch {}
    }
  } else if (!el.isContentEditable) {
    try { const n = (el.value || '').length; el.setSelectionRange(n, n) } catch {}
  }
  return { editable: true, tag: tag.toLowerCase(), type: el.getAttribute('type') || '', empty: el.isContentEditable ? !el.textContent : !el.value }
}

// the element that has the keyboard now (through shadow roots and same-origin frames), and whether it takes text
P.active = () => {
  let el = document.activeElement
  for (let i = 0; i < 8 && el; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
    else if (el.tagName === 'IFRAME') { try { const d = el.contentDocument; if (d && d.activeElement) el = d.activeElement; else break } catch { break } }
    else break
  }
  if (!el) return { editable: false }
  const tag = el.tagName
  const editable = tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|color|range)$/i.test(el.getAttribute('type') || 'text')) || el.isContentEditable
  return { editable, tag: tag.toLowerCase(), type: el.getAttribute('type') || '', ref: ref(el) }
}

P.valueOf = (id) => {
  const el = get(id)
  if (!el) return null
  return el.isContentEditable ? el.textContent : 'value' in el ? el.value : null
}

// last resort for fields that ignore typed input (some masked or controlled inputs): the native setter plus events
P.setValue = (id, value) => {
  const el = get(id)
  if (!el) return false
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')
  if (!setter || !setter.set) return false
  setter.set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

P.checked = (id) => {
  const el = get(id)
  if (!el) return null
  return el.checked === true || el.getAttribute('aria-checked') === 'true'
}

P.selectOption = (id, wanted) => {
  const el = get(id)
  if (!el) return { error: 'ref ' + id + ' is not on the page any more: take a new snapshot' }
  if (el.tagName !== 'SELECT') return { error: 'this is not a <select>: click it and pick the option instead' }
  const chosen = []
  const list = Array.from(el.options)
  const pick = (w) => list.find((o) => o.value === w) || list.find((o) => (o.label || o.textContent).trim() === w) || list.find((o) => (o.label || o.textContent).trim().toLowerCase() === String(w).toLowerCase()) || list.find((o) => (o.label || o.textContent).toLowerCase().includes(String(w).toLowerCase()))
  const targets = wanted.map(pick)
  const missing = wanted.filter((_, i) => !targets[i])
  if (missing.length) return { error: 'no option matches ' + missing.map(q).join(', ') + '. Options: ' + list.slice(0, 30).map((o) => q(clean(o.label || o.textContent, 40))).join(', ') }
  for (const o of list) o.selected = el.multiple ? targets.includes(o) : false
  if (!el.multiple) targets[0].selected = true
  for (const o of targets) chosen.push(clean(o.label || o.textContent, 60))
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { chosen }
}

P.text = () => (document.body ? document.body.innerText : '')

P.fileInput = (id) => {
  const el = get(id)
  return el && el.tagName === 'INPUT' && el.type === 'file'
}

// drop synthetic data or files onto an element (for sites that read the DataTransfer themselves)
P.drop = (id, files, data) => {
  const el = get(id)
  if (!el) return { error: 'ref ' + id + ' is not on the page any more: take a new snapshot' }
  const dt = new DataTransfer()
  for (const f of files || []) {
    const bin = atob(f.base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    dt.items.add(new File([bytes], f.name, { type: f.type || 'application/octet-stream' }))
  }
  for (const k of Object.keys(data || {})) dt.setData(k, data[k])
  const r = el.getBoundingClientRect()
  const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
  for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, init))
  return { ok: true }
}

P.draw = (${drawOverlay.toString()})
window.__joltyP = P
`

/** The page script, ready to run with Runtime.evaluate (and to register for every new document). */
export const PAGE_SCRIPT = `(() => {
  if (window.__joltyP && window.__joltyP.v === ${VERSION}) return
  try {
${BODY}
  } catch (e) { window.__joltyError = String(e && e.stack || e) }
})()`

/** Registered for new documents: installs the script, then keeps the overlay alive on the top page. */
export const BOOT_SCRIPT = `${PAGE_SCRIPT};(() => {
  if (window !== window.top) return
  const go = () => { try { window.__joltyP && window.__joltyP.draw(null) } catch {} }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true })
  else go()
})()`

export const PAGE_SCRIPT_VERSION = VERSION
