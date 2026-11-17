// Real contrast on the phone, from pixels: the text is measured against what is actually drawn behind it, translucent panes, the
// aurora, blur and scrims included. The page is photographed once with every glyph and icon made transparent (that picture is the
// true background), then each line of text is checked against the pixels under it. Body text needs 4.5:1, large text and icons 3:1
// (WCAG 1.4.3 and 1.4.11; an idle node of the activity graph is an inactive control and exempt). The 10th percentile of the samples is used, so a single bright speck does not decide.

/** Runs in the page: the text lines and icons to check, with their colour and where they are. */
function collect(scope) {
  const W = innerWidth
  const H = innerHeight
  const root = document.querySelector(scope) || document.body
  const out = []
  const name = (e) => {
    const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
    return `${e.tagName.toLowerCase()}${cls ? '.' + cls : ''}`
  }
  const visible = (e) => {
    for (let p = e; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false
    }
    return true
  }
  const fade = (e) => {
    let a = 1
    for (let p = e; p && p !== document.documentElement; p = p.parentElement) a *= Number(getComputedStyle(p).opacity)
    return a
  }
  // the strip under the phone's status bar or notch: the system draws over it, so nothing there is read against the page
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top)'
  document.body.append(probe)
  const statusBar = parseFloat(getComputedStyle(probe).paddingTop) || 0
  probe.remove()
  // the points of a box where this element is really on top (not under a floating header, a menu or the drawer's edge)
  const points = (e, r) => {
    const out = []
    const step = Math.max(2, Math.min(6, r.width / 12))
    for (let y = r.top + r.height * 0.25; y < r.bottom - r.height * 0.2; y += Math.max(2, r.height / 4)) {
      for (let x = r.left + 1; x < r.right - 1; x += step) {
        const at = document.elementFromPoint(x, y)
        if (at && (e.contains(at) || at.contains(e))) out.push([x, y])
      }
    }
    return out
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n && out.length < 400; n = walker.nextNode()) {
    const text = n.textContent.trim()
    const e = n.parentElement
    if (text.length < 2 || !e || e.closest('pre, code, .hljs, canvas, video, .pcs-stage canvas, input, textarea, select, svg, [aria-hidden="true"], .sr-only, .mascot')) continue
    if (e.closest('button:disabled, [aria-disabled="true"]') || !visible(e)) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    const s = getComputedStyle(e)
    const size = parseFloat(s.fontSize)
    for (const r of range.getClientRects()) {
      // a line scrolled half out of view is read once it is scrolled in
      if (r.width < 4 || r.height < 4 || r.left < -1 || r.right > W + 1 || r.top < statusBar - 1 || r.bottom > H + 1) continue
      const pts = points(e, r)
      if (pts.length < 3) continue
      out.push({ what: `${name(e)} "${text.slice(0, 24)}"`, color: s.color, alpha: fade(e), pts, need: size >= 24 || (size >= 18.6 && Number(s.fontWeight) >= 700) ? 3 : 4.5 })
    }
  }
  // icons drawn in the text colour (lucide: stroke="currentColor") need 3:1 against what is behind them
  for (const svg of root.querySelectorAll('svg')) {
    if (out.length >= 480 || svg.closest('[aria-hidden="true"]:not(svg), .mascot, .pcs-stage, button:disabled, [aria-disabled="true"], .ag-node:not(.on)') || !visible(svg)) continue
    const r = svg.getBoundingClientRect()
    if (r.width < 8 || r.height < 8 || r.left < -1 || r.right > W + 1 || r.top < statusBar - 1 || r.bottom > H + 1) continue
    // only icons drawn in the text colour; a picture made of its own colours (the stars of the activity graph) is decoration
    if (svg.getAttribute('stroke') !== 'currentColor') continue
    const owner = svg.closest('button, a, [role="button"], .session-item, .nav-item') || svg.parentElement
    const pts = points(svg, r)
    if (pts.length < 3) continue
    out.push({ what: `icon in ${name(owner)}`, color: getComputedStyle(svg).color, alpha: fade(svg), pts, need: 3, icon: true })
  }
  return out
}

/** Runs in the page: reads the background picture and scores every item against the pixels under it. */
async function score({ png, items }) {
  const img = new Image()
  img.src = `data:image/png;base64,${png}`
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  const k = img.width / innerWidth
  const px = g.getImageData(0, 0, c.width, c.height).data
  const lin = (v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const lum = (r, gg, b) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b)
  const parse = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }
  }
  const bad = []
  for (const it of items) {
    const fg = parse(it.color)
    if (!fg) continue
    const a = fg.a * it.alpha
    const ratios = []
    for (const [cx, cy] of it.pts) {
      const x = Math.min(c.width - 1, Math.round(cx * k))
      const y = Math.min(c.height - 1, Math.round(cy * k))
      const i = (y * c.width + x) * 4
      const [br, bg, bb] = [px[i], px[i + 1], px[i + 2]]
      const L1 = lum(fg.r * a + br * (1 - a), fg.g * a + bg * (1 - a), fg.b * a + bb * (1 - a))
      const L2 = lum(br, bg, bb)
      ratios.push((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05))
    }
    if (!ratios.length) continue
    ratios.sort((p, q) => p - q)
    const low = ratios[Math.floor(ratios.length * 0.1)]
    if (low < it.need) bad.push(`${it.what} ${low.toFixed(2)} < ${it.need}`)
  }
  return [...new Set(bad)]
}

/** Every line of text and every icon in `scope` that does not reach its contrast on the pixels behind it. */
export async function realContrast(page, scope = 'body') {
  const items = await page.evaluate(collect, scope)
  if (!items.length) return []
  await page.evaluate(() => {
    const st = document.createElement('style')
    st.id = 'contrast-probe'
    st.textContent = '*, *::before, *::after, *::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; transition: none !important; text-decoration-color: transparent !important } svg, .mascot { visibility: hidden !important }'
    document.head.append(st)
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  const png = (await page.screenshot({ type: 'png' })).toString('base64')
  await page.evaluate(() => {
    document.getElementById('contrast-probe')?.remove()
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  return page.evaluate(score, { png, items })
}
