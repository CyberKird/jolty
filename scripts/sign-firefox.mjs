// Signs browser-extension-firefox with Mozilla (unlisted channel: free, no review queue for the user) and puts the
// result where the app packages it. Bump "version" in browser-extension-firefox/manifest.json first: AMO refuses a
// version it has already signed. Keys come from C:\Users\<you>\.jolty-amo.env (outside the repo):
//   AMO_JWT_ISSUER=user:12345:678
//   AMO_JWT_SECRET=...
// Run: node scripts/sign-firefox.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const envFile = path.join(os.homedir(), '.jolty-amo.env')
const env = Object.fromEntries(
  (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '')
    .split(/\r?\n/)
    .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')])
)
if (!env.AMO_JWT_ISSUER || !env.AMO_JWT_SECRET) {
  console.error(`Missing AMO_JWT_ISSUER / AMO_JWT_SECRET in ${envFile}. Create them at https://addons.mozilla.org/developers/addon/api/key/`)
  process.exit(1)
}
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-sign-'))
execFileSync(
  'npx',
  ['--yes', 'web-ext', 'sign', '--channel=unlisted', '--source-dir', 'browser-extension-firefox', '--artifacts-dir', out, '--api-key', env.AMO_JWT_ISSUER, '--api-secret', env.AMO_JWT_SECRET],
  { stdio: 'inherit', shell: true }
)
const xpi = fs.readdirSync(out).find((f) => f.endsWith('.xpi'))
if (!xpi) throw new Error('web-ext produced no .xpi')
fs.mkdirSync('browser-extension-firefox-signed', { recursive: true })
fs.copyFileSync(path.join(out, xpi), path.join('browser-extension-firefox-signed', 'jolty.xpi'))
fs.rmSync(out, { recursive: true, force: true })
console.log('signed: browser-extension-firefox-signed/jolty.xpi')
