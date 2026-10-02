// What the user sees in the browser while a model drives it: a volt glow around the page, a "Jolty"
// cursor that glides to the element before each click, and a bolt on the tab (favicon + title).
// The two functions below are not run by Jolty: their source is written to a file that Playwright MCP
// loads (`--init-page`) inside its own process, so they must not reference anything outside themselves.
import fs from 'fs'
import path from 'path'
import { dataDir } from './store'

/** Locator methods that act on an element: the cursor goes there first. The flag marks the ones that click. */
const POINTER: Record<string, number> = { click: 1, dblclick: 1, check: 1, uncheck: 1, dragTo: 1, hover: 0, fill: 0, pressSequentially: 0, selectOption: 0 }

/** Runs in the page (main frame only). `a` = [x, y, width, height, click] of the target, or null to just show the glow. */
export function drawOverlay(a: number[] | null): void {
  const w = window as any
  const d = document
  if (w !== w.top || !d.documentElement) return
  const mk = (tag: string, css: Record<string, string>, ns?: string): any => {
    const e: any = ns ? d.createElementNS(ns, tag) : d.createElement(tag)
    Object.assign(e.style, css)
    return e
  }
  let s = w.__jolty
  if (!s || !s.root.isConnected) {
    const SVG = 'http://www.w3.org/2000/svg'
    const root = mk('div', { all: 'initial', position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none', opacity: '0', transition: 'opacity .6s ease' })
    const glow = mk('div', {
      position: 'absolute',
      inset: '0',
      boxShadow: 'inset 0 0 0 2px rgba(212,255,0,.9), inset 0 0 70px 8px rgba(212,255,0,.28), inset 0 0 180px 24px rgba(212,255,0,.12)'
    })
    glow.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 1700, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' })
    const cursor = mk('div', { position: 'absolute', left: '0', top: '0', opacity: '0', transition: 'transform .4s cubic-bezier(.22,1,.36,1), opacity .3s', willChange: 'transform' })
    const svg = mk('svg', { display: 'block', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.45))' }, SVG)
    svg.setAttribute('width', '20')
    svg.setAttribute('height', '24')
    svg.setAttribute('viewBox', '0 0 13 20')
    const arrow = d.createElementNS(SVG, 'path')
    arrow.setAttribute('d', 'M1 1v15l4-3.6 2.8 6.3 2.4-1.1L7.4 11.4H13z')
    arrow.setAttribute('fill', '#d4ff00')
    arrow.setAttribute('stroke', '#0b0b0b')
    arrow.setAttribute('stroke-width', '1.2')
    arrow.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(arrow)
    const tag = mk('div', {
      position: 'absolute',
      left: '16px',
      top: '20px',
      padding: '2px 7px',
      borderRadius: '9px',
      background: '#d4ff00',
      color: '#0b0b0b',
      font: '700 11px/1.3 system-ui,sans-serif',
      letterSpacing: '.02em',
      whiteSpace: 'nowrap'
    })
    tag.textContent = 'Jolty'
    cursor.append(svg, tag)
    // a closed shadow root: the page's own CSS (svg { margin }, div { ... }) cannot reach the overlay
    const sh = root.attachShadow({ mode: 'closed' })
    sh.append(glow, cursor)
    d.documentElement.appendChild(root)
    s = w.__jolty = { root, sh, cursor, x: undefined, icon: undefined, fade: 0, unmark: 0 }
  }
  const unmark = (): void => {
    if (d.title.startsWith('⚡ ')) d.title = d.title.slice(2)
    if (s.icon) {
      for (const [l, href, type] of s.icon.links) {
        l.href = href
        l.type = type
      }
      s.icon.added?.remove()
      s.icon = undefined
    }
  }
  // the tab: bolt favicon and a bolt in front of the title
  if (!d.title.startsWith('⚡')) d.title = `⚡ ${d.title || 'Jolty'}`
  if (!s.icon) {
    const href = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='#d4ff00'/><path d='M18 3 7 18h7l-2 11 11-15h-7z' fill='#0b0b0b'/></svg>")}`
    const links: any[] = Array.from(d.querySelectorAll('link[rel~="icon" i]'))
    s.icon = { links: links.map((l) => [l, l.href, l.type]), added: undefined }
    for (const l of links) {
      l.href = href
      l.type = 'image/svg+xml'
    }
    if (!links.length && d.head) {
      const l = d.createElement('link')
      l.rel = 'icon'
      l.href = href
      d.head.appendChild(l)
      s.icon.added = l
    }
  }
  s.root.style.opacity = '1'
  if (a) {
    const tx = Math.min(Math.max(a[0] + a[2] / 2, 8), w.innerWidth - 8)
    const ty = Math.min(Math.max(a[1] + a[3] / 2, 8), w.innerHeight - 8)
    if (s.x === undefined) {
      // first appearance: from the corner, not from the top-left
      s.cursor.style.transition = 'none'
      s.cursor.style.transform = `translate(${w.innerWidth - 80}px,${w.innerHeight - 80}px)`
      void s.cursor.offsetWidth
      s.cursor.style.transition = ''
    }
    s.x = tx
    s.cursor.style.opacity = '1'
    s.cursor.style.transform = `translate(${tx}px,${ty}px)`
    if (a[4]) {
      setTimeout(() => {
        const ring = mk('div', { position: 'absolute', left: `${tx - 15}px`, top: `${ty - 15}px`, width: '30px', height: '30px', boxSizing: 'border-box', border: '2px solid #d4ff00', borderRadius: '50%' })
        s.sh.appendChild(ring)
        const an = ring.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.7)', opacity: 0 }], { duration: 520, easing: 'ease-out' })
        an.onfinish = () => ring.remove()
      }, 330)
    }
  }
  // quiet again soon after the model stops or leaves for another tab: the glow first, the tab marks right after
  clearTimeout(s.fade)
  s.fade = setTimeout(() => {
    s.root.style.opacity = '0'
    s.cursor.style.opacity = '0'
  }, 4000)
  clearTimeout(s.unmark)
  s.unmark = setTimeout(unmark, 5000)
}

/** Runs inside Playwright MCP, once per tab: keeps the glow on every page and moves the cursor before pointer actions. */
export function makeInitPage(draw: unknown, pointer: Record<string, number>): (ctx: { page: any }) => Promise<void> {
  return async ({ page }) => {
    try {
      const boot = `(function(){if(window!==window.top)return;var go=function(){(${draw})(null)};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go,{once:true});else go()})()`
      await page.addInitScript(boot).catch(() => {})
      await page.evaluate(boot).catch(() => {})
      const proto = Object.getPrototypeOf(page.locator('html'))
      // keys, screenshots and navigation count as activity too, so the marker lives exactly while the model works
      const touch = (): void => void page.evaluate(draw, null).catch(() => {})
      for (const [obj, names] of [[page.keyboard, ['press', 'type', 'insertText', 'down']], [page, ['screenshot', 'goBack', 'goForward', 'reload']]] as [any, string[]][]) {
        for (const n of names) {
          const orig = obj[n]?.bind(obj)
          if (orig) obj[n] = (...a: unknown[]) => (touch(), orig(...a))
        }
      }
      if (proto.__jolty) return
      proto.__jolty = true
      for (const name of Object.keys(pointer)) {
        const orig = proto[name]
        if (typeof orig !== 'function') continue
        proto[name] = async function (this: any, ...args: unknown[]) {
          try {
            await this.scrollIntoViewIfNeeded({ timeout: 1200 })
            const b = await this.boundingBox({ timeout: 800 })
            if (b) {
              await this.page().evaluate(draw, [b.x, b.y, b.width, b.height, pointer[name]])
              await new Promise((r) => setTimeout(r, 360))
            }
          } catch {
            // the overlay is decoration: the real action runs either way
          }
          return orig.apply(this, args)
        }
      }
    } catch {
      // never let the decoration break the tab
    }
  }
}

/** Writes the file Playwright MCP loads with `--init-page` and returns its path. */
export function overlayFile(): string {
  const file = path.join(dataDir(), 'browser-overlay.cjs')
  const src = `const draw = ${drawOverlay.toString()}\nconst make = ${makeInitPage.toString()}\nexports.default = make(draw, ${JSON.stringify(POINTER)})\n`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== src) fs.writeFileSync(file, src)
  return file
}
