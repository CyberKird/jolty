// electron-builder finds the app's runtime libraries through npm. If node_modules is a junction to
// another checkout (common with worktrees) or was installed for a different version, it collects only
// part of them and the installer starts with "Cannot find module ...". Fail before building instead.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const nodeModules = path.join(root, 'node_modules')

const problem = (() => {
  if (!fs.existsSync(nodeModules)) return 'node_modules is missing'
  if (fs.lstatSync(nodeModules).isSymbolicLink()) return 'node_modules is a link to another checkout (worktree)'
  const hidden = path.join(nodeModules, '.package-lock.json')
  if (!fs.existsSync(hidden)) return 'node_modules has no .package-lock.json'
  const installed = JSON.parse(fs.readFileSync(hidden, 'utf8')).version
  if (installed !== version) return `node_modules was installed for ${installed || 'another version'}, not ${version}`
  return null
})()

if (problem) {
  console.error(`build: ${problem}. Run "npm ci" in ${root} before building, or the installer will miss runtime libraries.`)
  process.exit(1)
}
