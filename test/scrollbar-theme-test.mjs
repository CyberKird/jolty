// The scrollbar belongs to the theme. Two ways it went wrong before: an element with scrollbar-width switched back to the native
// Windows scrollbar (arrow buttons, grey track), and a theme that never said how its scrollbar looks.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const dir = 'src/renderer/src'
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css'))
const css = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')]))
const rules = Object.entries(css).flatMap(([file, text]) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ file, selector: m[1].trim(), body: m[2] })))

const TOKENS = ['--scroll-w', '--scroll-radius', '--scroll-track', '--scroll-thumb', '--scroll-thumb-hover']
const themes = [...fs.readFileSync(path.join(dir, 'theme.ts'), 'utf8').matchAll(/THEMES: ThemeId\[\] = \[([^\]]*)\]/g)][0][1].match(/'(\w+)'/g).map((s) => s.slice(1, -1))

test('no element asks for a native scrollbar', () => {
  for (const r of rules) {
    assert.doesNotMatch(r.body, /scrollbar-color\s*:/, `${r.file}: ${r.selector} sets scrollbar-color`)
    assert.doesNotMatch(r.body, /scrollbar-width\s*:\s*(thin|auto)/, `${r.file}: ${r.selector} sets scrollbar-width, which brings back the native scrollbar`)
  }
})

test('the base look defines every scrollbar token, and the scrollbar is drawn from them', () => {
  const root = rules.filter((r) => r.file === 'styles.css' && r.selector.endsWith(':root'))
  for (const t of TOKENS) assert.ok(root.some((r) => r.body.includes(`${t}:`)), `${t} missing in :root of styles.css`)
  const thumb = rules.find((r) => r.selector === '::-webkit-scrollbar-thumb')
  assert.match(thumb.body, /var\(--scroll-thumb\)/)
  assert.ok(rules.some((r) => r.selector === '::-webkit-scrollbar-button' && /display:\s*none/.test(r.body)), 'no arrow buttons')
})

test('every theme but the base one says how its scrollbar looks', () => {
  assert.ok(themes.includes('glass') && themes.includes('frost'), `themes read from theme.ts: ${themes}`)
  for (const id of themes.filter((t) => t !== 'volt')) {
    const own = rules.filter((r) => r.selector.includes(`[data-theme='${id}']`) && !r.selector.includes('::'))
    for (const t of ['--scroll-track', '--scroll-thumb']) assert.ok(own.some((r) => r.body.includes(`${t}:`)), `theme ${id} does not set ${t}`)
  }
})
