// Content script of the Jolty extension for Firefox. Firefox has no DevTools protocol for extensions, so
// the page side of "Input.*" lives here: mouse, keyboard and text input are played into the page as DOM
// events, and the page's console and dialogs are reported to the background script.
// It stays idle until Jolty works in this tab (armed by the background script).
'use strict'
;(() => {
  if (window.__joltyF) return
  const F = (window.__joltyF = { armed: false })
  const send = (m) => {
    try {
      browser.runtime.sendMessage(m).catch(() => {})
    } catch {
      // the extension was reloaded under this page
    }
  }

  // ------------------------------------------------------------------ what the page says
  const show = (a) => {
    if (typeof a === 'string') return a
    try {
      return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)
    } catch {
      return String(a)
    }
  }

  // The page may log before Jolty has answered whether it works in this tab, so the console and errors are
  // kept for a moment (a few hundred entries at most) and handed over when it does.
  const kept = []
  const report = (m) => {
    if (F.armed) send(m)
    else if (kept.push(m) > 300) kept.shift()
  }

  if (window === window.top) {
    const w = window.wrappedJSObject
    for (const [name, type] of [['log', 'log'], ['info', 'info'], ['warn', 'warning'], ['error', 'error'], ['debug', 'debug']]) {
      const orig = w.console[name]
      w.console[name] = exportFunction(function () {
        const args = Array.from(arguments)
        // the page's own console call must never fail because of this
        try {
          report({ t: 'console', type, text: args.map(show).join(' ') })
        } catch {
          // nothing to report
        }
        return orig.apply(this, cloneInto(args, w, { wrapReflectors: true }))
      }, w.console)
    }
    window.addEventListener('error', (e) => report({ t: 'exception', text: e.message, url: e.filename, line: e.lineno }))
  }

  F.arm = () => {
    if (F.armed) return
    F.armed = true
    for (const m of kept.splice(0)) send(m)
    if (window !== window.top) return
    const w = window.wrappedJSObject
    // a native dialog would freeze the page and every command with it: they are reported and answered at once
    w.alert = exportFunction((m) => send({ t: 'dialog', type: 'alert', message: String(m ?? '') }), w)
    w.confirm = exportFunction((m) => {
      send({ t: 'dialog', type: 'confirm', message: String(m ?? '') })
      return true
    }, w)
    w.prompt = exportFunction((m, d) => {
      send({ t: 'dialog', type: 'prompt', message: String(m ?? ''), defaultPrompt: d == null ? '' : String(d) })
      return d == null ? '' : String(d)
    }, w)
  }
  if (window === window.top) browser.runtime.sendMessage({ t: 'armed?' }).then((on) => on && F.arm(), () => {})

  // ------------------------------------------------------------------ finding things
  /** The element at a point, looking into open shadow roots and same-origin frames. */
  const deep = (x, y) => {
    let doc = document
    let el = doc.elementFromPoint(x, y)
    for (let i = 0; el && i < 12; i++) {
      if (el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x, y)
        if (inner && inner !== el) {
          el = inner
          continue
        }
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let d
        try {
          d = el.contentDocument
        } catch {
          d = null
        }
        if (!d) break
        const r = el.getBoundingClientRect()
        x -= r.left + el.clientLeft
        y -= r.top + el.clientTop
        const inner = d.elementFromPoint(x, y)
        if (!inner) break
        doc = d
        el = inner
        continue
      }
      break
    }
    return el ? { el, x, y } : null
  }

  const deepActive = () => {
    let el = document.activeElement
    for (let i = 0; el && i < 12; i++) {
      if (el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
      else if ((el.tagName === 'IFRAME' || el.tagName === 'FRAME') && el.contentDocument && el.contentDocument.activeElement) el = el.contentDocument.activeElement
      else break
    }
    return el
  }

  const FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex],[contenteditable=""],[contenteditable="true"]'
  const tabbable = () =>
    [...document.querySelectorAll(FOCUSABLE)].filter((e) => !e.disabled && e.tabIndex >= 0 && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
  const isEditable = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|file|image|color|range)$/i.test(el.type)))
  const isButtonLike = (el) => !!el && (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY' || (el.tagName === 'INPUT' && /^(button|submit|reset|checkbox|radio|image)$/i.test(el.type)))

  // ------------------------------------------------------------------ mouse
  const MOD = (m) => ({ altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8) })
  const BUTTON = { left: 0, middle: 1, right: 2, none: -1 }
  const BUTTONS = { left: 1, right: 2, middle: 4, none: 0 }
  let hover = null
  let down = null

  const fire = (el, type, init) => {
    const Ctor = type.startsWith('pointer') ? PointerEvent : type === 'wheel' ? WheelEvent : MouseEvent
    return el.dispatchEvent(new Ctor(type, init))
  }

  const scrollFrom = (el, dx, dy) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e)
      const y = dy && /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight
      const x = dx && /(auto|scroll)/.test(s.overflowX) && e.scrollWidth > e.clientWidth
      if (x || y) return e.scrollBy({ left: x ? dx : 0, top: y ? dy : 0, behavior: 'instant' })
    }
    window.scrollBy({ left: dx, top: dy, behavior: 'instant' })
  }

  F.mouse = (type, x, y, o = {}) => {
    const hit = deep(x, y)
    if (!hit) return
    const el = hit.el
    const name = o.button || 'none'
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: hit.x, clientY: hit.y, screenX: x, screenY: y,
      button: type === 'mouseMoved' ? 0 : BUTTON[name] ?? 0,
      buttons: o.buttons ?? (type === 'mousePressed' ? BUTTONS[name] : 0),
      detail: o.clickCount || 0,
      ...MOD(o.modifiers || 0)
    }
    const ptr = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }
    if (type === 'mouseMoved') {
      if (hover !== el) {
        if (hover && hover.isConnected) {
          fire(hover, 'pointerout', ptr)
          fire(hover, 'mouseout', init)
        }
        fire(el, 'pointerover', ptr)
        fire(el, 'mouseover', init)
        hover = el
      }
      fire(el, 'pointermove', ptr)
      fire(el, 'mousemove', init)
    } else if (type === 'mousePressed') {
      down = { el, button: name }
      fire(el, 'pointerdown', ptr)
      if (fire(el, 'mousedown', init) && name === 'left') {
        const f = el.closest(FOCUSABLE)
        if (f) f.focus({ preventScroll: true })
        else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
      }
    } else if (type === 'mouseReleased') {
      fire(el, 'pointerup', { ...ptr, buttons: 0 })
      fire(el, 'mouseup', { ...init, buttons: 0 })
      if (down && (down.el === el || down.el.contains(el) || el.contains(down.el))) {
        if (name === 'left') {
          fire(el, 'click', { ...init, buttons: 0 })
          if ((o.clickCount || 1) === 2) fire(el, 'dblclick', { ...init, buttons: 0 })
        } else if (name === 'right') fire(el, 'contextmenu', { ...init, buttons: 0 })
        else fire(el, 'auxclick', { ...init, buttons: 0 })
      }
      down = null
    } else if (type === 'mouseWheel') {
      const dx = o.deltaX || 0
      const dy = o.deltaY || 0
      if (fire(el, 'wheel', { ...init, deltaX: dx, deltaY: dy, deltaMode: 0 })) scrollFrom(el, dx, dy)
    }
  }

  // ------------------------------------------------------------------ text and keys
  F.insertText = (text) => {
    const el = deepActive()
    if (document.execCommand('insertText', false, text)) return
    if (el && typeof el.setRangeText === 'function' && el.selectionStart != null) {
      el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end')
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    }
  }

  const caret = (el, key) => {
    if (el.selectionStart == null) {
      const dir = key === 'ArrowLeft' || key === 'Home' ? 'backward' : 'forward'
      return window.getSelection().modify('move', dir, key === 'Home' || key === 'End' ? 'lineboundary' : 'character')
    }
    const n = el.value.length
    const at = key === 'Home' ? 0 : key === 'End' ? n : Math.max(0, Math.min(n, (key === 'ArrowLeft' ? el.selectionStart : el.selectionEnd) + (key === 'ArrowLeft' ? -1 : 1)))
    el.setSelectionRange(at, at)
  }

  const enter = (el) => {
    if (el.isContentEditable) return document.execCommand('insertParagraph')
    if (el.tagName === 'TEXTAREA') return F.insertText('\n')
    if (isButtonLike(el) || el.tagName === 'A') return el.click()
    const form = el.form
    if (!form) return
    const submit = form.querySelector('button[type=submit],input[type=submit],button:not([type])')
    if (submit) submit.click()
    else if (form.querySelectorAll('input:not([type=hidden])').length === 1) form.requestSubmit()
  }

  F.key = (e) => {
    const el = deepActive() || document.body
    const m = e.modifiers || 0
    const init = { key: e.key, code: e.code || '', keyCode: e.windowsVirtualKeyCode || 0, which: e.windowsVirtualKeyCode || 0, bubbles: true, cancelable: true, composed: true, view: window, ...MOD(m) }
    if (e.type === 'keyUp') {
      if (el.dispatchEvent(new KeyboardEvent('keyup', init)) && e.key === ' ' && isButtonLike(el)) el.click()
      return
    }
    if (!el.dispatchEvent(new KeyboardEvent('keydown', init))) return
    const k = e.key
    if (m & (2 | 4)) {
      const c = k.toLowerCase()
      if (c === 'a') return el.select ? el.select() : document.execCommand('selectAll')
      if (c === 'c' || c === 'x') return document.execCommand(c === 'c' ? 'copy' : 'cut')
      if (c === 'z') return document.execCommand(m & 8 ? 'redo' : 'undo')
      if (c === 'y') return document.execCommand('redo')
      return
    }
    if (typeof e.text === 'string' && e.text && !(m & 1)) {
      if (!el.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: e.text.charCodeAt(0) }))) return
      if (k === 'Enter') return enter(el)
      if (isEditable(el)) return F.insertText(e.text)
      if (k === ' ' && !isButtonLike(el)) window.scrollBy({ top: (m & 8 ? -1 : 1) * innerHeight * 0.9, behavior: 'instant' })
      return
    }
    const edit = isEditable(el)
    if (k === 'Backspace' && edit) document.execCommand('delete')
    else if (k === 'Delete' && edit) document.execCommand('forwardDelete')
    else if (k === 'Tab') {
      const list = tabbable()
      const at = list.indexOf(el)
      const next = list[(at + (m & 8 ? -1 : 1) + list.length) % list.length]
      if (next) next.focus()
    } else if (edit && /^(ArrowLeft|ArrowRight|Home|End)$/.test(k)) caret(el, k)
    else if (k === 'F5') location.reload()
    else if (!edit) {
      const page = innerHeight * 0.9
      const by = { ArrowDown: [0, 40], ArrowUp: [0, -40], PageDown: [0, page], PageUp: [0, -page], ArrowRight: [40, 0], ArrowLeft: [-40, 0] }[k]
      if (by) scrollFrom(el, by[0], by[1])
      else if (k === 'Home') window.scrollTo({ top: 0, behavior: 'instant' })
      else if (k === 'End') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
    }
  }
})()
