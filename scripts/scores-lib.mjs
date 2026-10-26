// The pure part of update-scores.mjs: leaderboard page in, scores.json entries out.
const MAX_ENTRIES = 600
const EFFORT = /-(xhigh|high|medium|low|minimal|max)$/
export const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Every `{"slug": ...}` object of the page that carries an intelligence index, newest data winning per slug. */
export function parseModels(html) {
  const s = html.replaceAll('\\"', '"')
  const found = new Map()
  for (let at = s.indexOf('{"slug":"'); at !== -1; at = s.indexOf('{"slug":"', at + 1)) {
    let depth = 0
    let end = at
    for (let inStr = false; end < s.length; end++) {
      const c = s[end]
      if (inStr) {
        if (c === '\\') end++
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) break
    }
    let o
    try {
      o = JSON.parse(s.slice(at, end + 1))
    } catch {
      continue
    }
    if (typeof o.intelligenceIndex === 'number' && !o.deprecated) found.set(o.slug, o)
  }
  return [...found.values()]
}

const tpsOf = (m) => (m && m.medianOutputTokensPerSecond > 0 ? Math.round(m.medianOutputTokensPerSecond) : undefined)
const clean = (name) => name.replace(/\s*\([^)]*\)\s*$/, '').trim()

/** One entry per model family at effort "high" (the base row when there is no high row), the other efforts in the note. */
export function buildEntries(models) {
  const families = new Map()
  for (const m of models) {
    const fam = m.slug.replace(EFFORT, '')
    families.set(fam, [...(families.get(fam) || []), m])
  }
  const entries = []
  for (const [fam, rows] of families) {
    const by = (slug) => rows.find((r) => r.slug === slug)
    const head = by(fam + '-high') || by(fam) || rows[0]
    const others = rows
      .filter((r) => r !== head && EFFORT.test(r.slug))
      .map((r) => `${EFFORT.exec(r.slug)[1]} ${Math.round(r.intelligenceIndex)}`)
    const base = by(fam)
    if (base && base !== head) others.push(`max ${Math.round(base.intelligenceIndex)}`)
    const effort = EFFORT.test(head.slug) ? EFFORT.exec(head.slug)[1] : /\(([^,)]+)/.exec(head.name)?.[1]?.toLowerCase()
    const note = `${clean(head.name)}${effort ? ` · ${effort}` : ''}${others.length ? ` (${others.join(', ')})` : ''}`.slice(0, 190)
    entries.push({ match: [fam], iq: Math.round(head.intelligenceIndex), tps: tpsOf(head) ?? tpsOf(base), note, fam })
  }
  // short names the engines and endpoints use for the newest model of a line: "opus", "3.6 flash", ...
  const newest = (prefix) => entries.filter((e) => e.fam.startsWith(prefix)).sort((a, b) => b.fam.localeCompare(a.fam, 'en', { numeric: true }))[0]
  const aliases = []
  for (const name of ['fable', 'opus', 'sonnet', 'haiku']) {
    const e = newest(`claude-${name}-`)
    if (e) aliases.push({ ...e, match: [name] })
  }
  for (const e of entries) if (e.fam.startsWith('gemini-')) aliases.push({ ...e, match: [e.fam.slice(7).replace(/-(preview|beta|exp)$/, '')] })
  const ultra = entries.find((e) => e.fam === 'mimo-v2-6-pro')
  if (ultra) aliases.push({ ...ultra, match: ['mimo-v2-6-pro-ultraspeed'], tps: undefined, note: `${ultra.note}; the ultraspeed service is not measured` })
  // the longest name first, so "gpt-6-1-sol-mini" is tried before "gpt-6-1-sol"; the short aliases come last
  const all = [...entries, ...aliases].sort((a, b) => squash(b.match[0]).length - squash(a.match[0]).length)
  return all.slice(0, MAX_ENTRIES).map(({ fam, ...e }) => e)
}
