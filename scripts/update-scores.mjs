// Rebuilds scores.json (the intelligence and speed table the app fetches every hour) from the public leaderboard
// of Artificial Analysis. Run by .github/workflows/scores.yml every day, or by hand: node scripts/update-scores.mjs
// The page carries its data as JSON inside the page itself, so there is no key and no API to call. If the page ever
// changes shape, fewer than MIN models are found and nothing is written: the last good scores.json stays.
import { readFileSync, writeFileSync } from 'node:fs'
import { buildEntries, parseModels } from './scores-lib.mjs'

const PAGE = 'https://artificialanalysis.ai/leaderboards/models'
const MIN = 100

const r = await fetch(PAGE, { headers: { 'user-agent': 'Mozilla/5.0 (Jolty scores)' }, signal: AbortSignal.timeout(30_000) })
if (!r.ok) throw new Error(`leaderboard answered ${r.status}`)
const models = parseModels(await r.text())
if (models.length < MIN) throw new Error(`only ${models.length} models found: the page changed, scores.json left as it was`)
const entries = buildEntries(models)
const out = new URL('../scores.json', import.meta.url)
// the date only moves when the table does, so an unchanged table is no commit
const old = (() => { try { return JSON.parse(readFileSync(out, 'utf8')) } catch { return {} } })()
const same = JSON.stringify(old.entries) === JSON.stringify(entries)
const file = { updated: same && old.updated ? old.updated : new Date().toISOString().slice(0, 10), source: 'artificialanalysis.ai/leaderboards/models', entries }
writeFileSync(out, JSON.stringify(file, null, 1) + '\n')
console.log(`scores.json: ${file.entries.length} entries from ${models.length} models`)
