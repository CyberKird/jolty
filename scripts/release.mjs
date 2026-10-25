// Publishes the version in package.json as a GitHub release: `GH_TOKEN` or a logged-in `gh` is enough.
//
// Why a script: electron-builder uploads the installer, its blockmap and latest.yml in parallel, and each upload looks for the
// release and creates it when it finds none. They race, so the run ended in a 422, a second release with only the blockmap and
// an installer without latest.yml (the updater then sees nothing). Here the draft release exists before electron-builder starts,
// the build only fills it, and it is published once every file is there and latest.yml matches the installer.
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { versionProblem } from './release-version.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' && cmd === 'npx', ...opts }).trim()
const fail = (msg) => {
  console.error('\nrelease: ' + msg)
  process.exit(1)
}

const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const tag = `v${version}`
const repo = 'CyberKird/jolty'
const token = process.env.GH_TOKEN || run('gh', ['auth', 'token'])
if (!token) fail('no GitHub token: set GH_TOKEN or run `gh auth login`')
const env = { ...process.env, GH_TOKEN: token }
const gh = (...args) => run('gh', args, { env })
const releasesOfTag = () => JSON.parse(gh('api', `repos/${repo}/releases?per_page=100`)).filter((r) => r.tag_name === tag)

const head = run('git', ['rev-parse', 'HEAD'])
if (!run('git', ['branch', '-r', '--contains', head]).includes('origin/main')) fail(`the commit ${head.slice(0, 7)} is not pushed to origin/main yet: push it first`)
if (run('git', ['status', '--porcelain'])) console.warn('release: warning, the working tree has uncommitted changes; the installer is built from them')

// the notes: the CHANGELOG section of this version
const log = fs.readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n')
const start = log.indexOf(`## ${version}\n`)
if (start < 0) fail(`CHANGELOG.md has no "## ${version}" section`)
const next = log.indexOf('\n## ', start + 1)
const notes = log.slice(start + `## ${version}\n`.length, next < 0 ? undefined : next).trim()

const previous = JSON.parse(gh('api', `repos/${repo}/releases/latest`)).tag_name.replace(/^v/, '')
const problem = versionProblem(previous, version, notes)
if (problem) fail(problem)

let existing = releasesOfTag()
if (existing.length > 1) fail(`there are already ${existing.length} releases for ${tag}: delete the extra ones first`)
if (existing.length === 1 && !existing[0].draft) fail(`${tag} is already published`)
if (!existing.length) {
  gh('release', 'create', tag, '--draft', '--title', tag, '--target', head, '--notes', notes)
  console.log(`release: draft ${tag} created`)
}

const built = spawnSync('npm', ['run', 'dist:build'], { stdio: 'inherit', shell: true, env: { ...env, EP_GH_IGNORE_TIME: 'true' } })
if (built.status !== 0) fail('the build or the upload failed; the draft stays, run again to continue')

// every file must be there, and latest.yml must describe this very installer
existing = releasesOfTag()
if (existing.length !== 1) fail(`expected one release for ${tag}, found ${existing.length}`)
const names = existing[0].assets.map((a) => a.name)
const exe = `Jolty-Setup-${version}.exe`
for (const n of [exe, `${exe}.blockmap`, 'latest.yml']) if (!names.includes(n)) fail(`${n} is missing from the release (has: ${names.join(', ') || 'nothing'})`)
const sha512 = crypto.createHash('sha512').update(fs.readFileSync(path.join('dist', exe))).digest('base64')
const latest = await (await fetch(existing[0].assets.find((a) => a.name === 'latest.yml').url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' } })).text()
if (!latest.includes(`version: ${version}`) || !latest.includes(sha512)) fail('latest.yml does not match the installer that was built')

gh('release', 'edit', tag, '--draft=false', '--latest', '--notes', notes)
const live = await (await fetch(`https://github.com/${repo}/releases/latest/download/latest.yml`)).text()
if (!live.includes(sha512)) fail('published, but releases/latest/download/latest.yml does not show this installer yet: check it')
console.log(`release: ${tag} published, latest.yml matches the installer`)
