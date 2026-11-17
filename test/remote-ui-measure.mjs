// Measures what a phone screen really draws: anything past the edges, a page that scrolls sideways, a label cut short,
// tap targets under 44 px, two tap targets on top of each other and an overlay you can see through. Runs inside the page
// (page.evaluate(measurePhone)); test/remote-ui-matrix.mjs runs it for every page x theme x screen size.

/** Runs in the page. Returns lists of short descriptions; an empty list is clean. */
export function measurePhone() {
  const W = window.innerWidth
  const H = window.innerHeight
  const name = (e) => {
    const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
    const txt = (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24)
    return `${e.tagName.toLowerCase()}${cls ? '.' + cls : ''}${txt ? ` "${txt}"` : ''}`
  }
  const shown = (e) => {
    const s = getComputedStyle(e)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  // a closed drawer, a hidden layer or anything with opacity 0 up the tree is not on the screen
  const onScreen = (e) => {
    for (let p = e; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false
    }
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < W && r.bottom > 0 && r.top < H
  }
  // inside something made to scroll sideways (a code block, a table, a chip row): it may be wider than the screen
  const sideScroller = (e) => {
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX
      if ((ox === 'auto' || ox === 'scroll') && !p.matches('.page, .messages, .sidebar, .main, .welcome, .app, .sheet-list, .offline-over')) return true
    }
    return false
  }
  const all = [...document.querySelectorAll('body *')].filter((e) => !e.closest('svg, #jolty-lens-defs, .mascot, .sr-only, [aria-hidden="true"]'))
  const out = { scroll: [], edge: [], clipped: [], small: [], overlap: [], zoom: [], unsafe: [] }

  // 1. the page (or any of its panes) scrolls sideways
  if (document.documentElement.scrollWidth > W + 1) out.scroll.push(`html ${document.documentElement.scrollWidth} > ${W}`)
  for (const e of document.querySelectorAll('body, #root, .app, .page, .messages, .sidebar, .main, .welcome, .composer-wrap, .chat-header, .titlebar, .pair, .pair-body, .sheet, .offline-over, .pcs')) {
    if (!shown(e)) continue
    if (e.scrollWidth > e.clientWidth + 1) out.scroll.push(`${name(e)} ${e.scrollWidth} > ${e.clientWidth}`)
  }
  // 2. drawn past the left or right edge of the screen
  for (const e of all) {
    if (!onScreen(e) || sideScroller(e)) continue
    if (getComputedStyle(e).position === 'fixed' && e.matches('.sidebar')) continue
    const r = e.getBoundingClientRect()
    if (r.right > W + 1 || r.left < -1) out.edge.push(`${name(e)} ${Math.round(r.left)}..${Math.round(r.right)}`)
  }
  // 3. a label cut off without an ellipsis (a clipped box hides the end of its own text)
  for (const e of all) {
    if (!onScreen(e) || sideScroller(e) || e.matches('input, textarea, select, pre, code, .messages, .page, .sidebar, .session-list, .picker-list, .sheet-list')) continue
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
    const s = getComputedStyle(e)
    const hides = (s.overflowX !== 'visible' && s.overflowX !== 'auto' && s.overflowX !== 'scroll')
    if (hides && e.scrollWidth > e.clientWidth + 2 && s.textOverflow !== 'ellipsis' && !s.webkitLineClamp?.match(/\d/)) out.clipped.push(`${name(e)} ${e.scrollWidth} > ${e.clientWidth}`)
    if (hides && e.scrollHeight > e.clientHeight + 3 && s.webkitLineClamp === 'none' && s.overflowY !== 'auto' && s.overflowY !== 'scroll' && s.textOverflow !== 'ellipsis') out.clipped.push(`${name(e)} h ${e.scrollHeight} > ${e.clientHeight}`)
  }
  // 4. tap targets: 44 px on both sides (a link inside running text is exempt, as WCAG 2.5.8 allows)
  const tappable = all.filter((e) => e.matches('button, a[href], [role="button"], [role="radio"], [role="tab"], [role="switch"], select, input:not([type="hidden"]), textarea, summary, .session-item, .nav-item, label.card') && onScreen(e) && !e.disabled && !e.closest('.md p, .md li, .md td, .md blockquote'))
  const hit = (e) => {
    const r = e.getBoundingClientRect()
    // a checkbox or radio inside its label is tapped through the label
    if (e.matches('input[type="checkbox"], input[type="radio"]')) {
      const l = e.closest('label') || (e.id && document.querySelector(`label[for="${e.id}"]`))
      if (l) return l.getBoundingClientRect()
    }
    return r
  }
  // under a drawer, a sheet or a menu: not reachable now, so neither its size nor its neighbours count
  const covered = (e) => {
    const r = e.getBoundingClientRect()
    const x = Math.min(Math.max(r.left + r.width / 2, 0), W - 1)
    const y = Math.min(Math.max(r.top + r.height / 2, 0), H - 1)
    const at = document.elementFromPoint(x, y)
    return Boolean(at) && !e.contains(at) && !at.contains(e) && !(e.matches('input, textarea') && at.closest('label') === e.closest('label'))
  }
  // a pseudo-element laid around a small control is part of where the finger lands (a 24 px icon with a 44 px hit area)
  const grow = (e, r) => {
    let { left, right, top, bottom } = r
    for (const pe of ['::before', '::after']) {
      const s = getComputedStyle(e, pe)
      if (s.content === 'none' || s.position !== 'absolute' || s.pointerEvents === 'none') continue
      const px = (v) => (v.endsWith('px') ? parseFloat(v) : 0)
      left = Math.min(left, r.left + Math.min(0, px(s.left)))
      right = Math.max(right, r.right - Math.min(0, px(s.right)))
      top = Math.min(top, r.top + Math.min(0, px(s.top)))
      bottom = Math.max(bottom, r.bottom - Math.min(0, px(s.bottom)))
    }
    return { left, right, top, bottom, width: right - left, height: bottom - top }
  }
  // how much of it is really shown: a scrolling list or a clipped box hides what lies outside it
  const shownPart = (e) => {
    const r = e.getBoundingClientRect()
    let [l, t, rr, b] = [Math.max(r.left, 0), Math.max(r.top, 0), Math.min(r.right, W), Math.min(r.bottom, H)]
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
      const q = p.getBoundingClientRect()
      ;[l, t, rr, b] = [Math.max(l, q.left), Math.max(t, q.top), Math.min(rr, q.right), Math.min(b, q.bottom)]
    }
    return rr > l && b > t ? ((rr - l) * (b - t)) / Math.max(1, r.width * r.height) : 0
  }
  const reach = tappable.filter((e) => !covered(e) && shownPart(e) > 0.5)
  for (const e of reach) {
    const r = grow(e, hit(e))
    if (r.height < 43.5 || r.width < 43.5) out.small.push(`${name(e)} ${Math.round(r.width)}x${Math.round(r.height)}`)
  }
  // 5. two tap targets over each other in the same layer (one inside the other is a row with its own button and is fine; a drawer
  // over the chat is a layer of its own)
  const layer = (e) => {
    for (let p = e; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.position === 'fixed' || (s.position === 'absolute' && s.zIndex !== 'auto') || p.matches('[role="dialog"], [role="menu"], .picker-pop')) return p
    }
    return document.body
  }
  // a row half scrolled under the edge of its own list is being scrolled, not covered
  const top = reach.filter((e) => !e.matches('label.card') && shownPart(e) > 0.99)
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const a = top[i]
      const b = top[j]
      if (a.contains(b) || b.contains(a) || layer(a) !== layer(b)) continue
      const p = a.getBoundingClientRect()
      const q = b.getBoundingClientRect()
      const x = Math.min(p.right, q.right) - Math.max(p.left, q.left)
      const y = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top)
      if (x > 2 && y > 2) {
        // only counts when both are really reachable there: the one on top wins the tap
        const cx = (Math.max(p.left, q.left) + Math.min(p.right, q.right)) / 2
        const cy = (Math.max(p.top, q.top) + Math.min(p.bottom, q.bottom)) / 2
        const at = document.elementFromPoint(cx, cy)
        if (at && (a.contains(at) || b.contains(at))) out.overlap.push(`${name(a)} x ${name(b)}`)
      }
    }
  }
  // 6. contrast is measured from pixels, in test/remote-ui-contrast.mjs
  const rgba = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }
  }
  // 6b. a layer over the page (the drawer, a sheet, a menu) must hide what is under it: solid enough, or blurring what is behind
  for (const e of document.querySelectorAll('.app:not(.no-sidebar) > .sidebar, .sheet, .picker-pop[data-state="open"], .pcs, .offline-over')) {
    if (!onScreen(e)) continue
    const s = getComputedStyle(e)
    const fill = rgba(s.backgroundColor)?.a || 0
    const stops = (s.backgroundImage.match(/rgba?\([^)]+\)/g) || []).map(rgba).filter(Boolean)
    const sheen = stops.length ? stops.reduce((t, c) => t + c.a, 0) / stops.length : 0
    const cover = 1 - (1 - fill) * (1 - sheen)
    if (cover < 0.8 && (s.backdropFilter === 'none' || !s.backdropFilter)) out.overlap.push(`${name(e)} see-through ${cover.toFixed(2)}`)
  }
  // 8. iOS zooms the page into a field whose text is under 16 px
  for (const e of document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]), textarea, select')) {
    if (onScreen(e) && parseFloat(getComputedStyle(e).fontSize) < 16) out.zoom.push(`${name(e)} ${getComputedStyle(e).fontSize}`)
  }
  // 9. nothing to tap under the notch, the status bar, the home bar or Android's gesture bar (the safe-area insets)
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
  document.body.append(probe)
  const ps = getComputedStyle(probe)
  const inset = { t: parseFloat(ps.paddingTop), r: parseFloat(ps.paddingRight), b: parseFloat(ps.paddingBottom), l: parseFloat(ps.paddingLeft) }
  probe.remove()
  // with the keyboard up (html.kb, remote/phone.ts) the home bar is under the keyboard: the page ends above both
  if (document.documentElement.classList.contains('kb')) inset.b = 0
  if (inset.t || inset.r || inset.b || inset.l) {
    // what scrolls passes under the bars, as it should: only what stays put has to keep clear of them
    const scrolls = (e) => {
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY
        if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return true
      }
      return false
    }
    for (const e of reach) {
      if (scrolls(e)) continue
      const r = e.getBoundingClientRect()
      if (r.top < inset.t - 1 || r.bottom > H - inset.b + 1 || r.left < inset.l - 1 || r.right > W - inset.r + 1) out.unsafe.push(`${name(e)} ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}`)
    }
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].slice(0, 12)
  return out
}
