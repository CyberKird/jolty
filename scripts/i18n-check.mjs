// Keeps the translations complete: every tr('...') text in src must have an entry in every
// dictionary, with the same {placeholders}. `--dump file.json` writes the list of texts instead.
// Texts built at runtime (limit window labels) are listed in DYNAMIC.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DYNAMIC = ['5 ore', '7 zile', '7 zile (Opus)', '7 zile (Sonnet)', '7 zile (aplicații)', '7 zile (cu extra)', 'Extra']

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'locales' ? [] : sources(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })
}

const keys = new Map()
// tr("text") as the codemod writes it, or tr('text') by hand
const CALL = /\btr\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g
for (const file of sources(path.join(root, 'src'))) {
  const src = fs.readFileSync(file, 'utf8')
  for (const m of src.matchAll(CALL)) {
    const lit = m[1]
    const text = lit.startsWith('"') ? JSON.parse(lit) : lit.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    if (!keys.has(text)) keys.set(text, path.relative(root, file))
  }
}
for (const k of DYNAMIC) if (!keys.has(k)) keys.set(k, 'dynamic')

const dumpAt = process.argv.indexOf('--dump')
if (dumpAt > 0) {
  fs.writeFileSync(process.argv[dumpAt + 1], JSON.stringify([...keys.keys()], null, 1))
  console.log(`${keys.size} texts written`)
  process.exit(0)
}

const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
const dir = path.join(root, 'src/shared/locales')
let bad = 0
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const dict = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
  const missing = [...keys.keys()].filter((k) => typeof dict[k] !== 'string' || !dict[k].trim())
  const broken = [...keys.keys()].filter((k) => typeof dict[k] === 'string' && holes(dict[k]) !== holes(k))
  const unused = Object.keys(dict).filter((k) => !keys.has(k))
  if (missing.length || broken.length) bad++
  console.log(`${file}: ${missing.length} missing, ${broken.length} with wrong {placeholders}, ${unused.length} unused`)
  for (const k of [...missing, ...broken].slice(0, 15)) console.log(`  ${JSON.stringify(k)}  (${keys.get(k)})`)
}
console.log(`${keys.size} texts`)
process.exit(bad ? 1 : 0)
