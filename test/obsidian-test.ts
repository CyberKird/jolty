// The vault export: one zip per day, notes in, Obsidian's scratch out, only the newest 14 kept.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { backup } from '../src/main/obsidian'

test('backup zips the notes without scratch files and prunes old days', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-obsidian-'))
  const vault = path.join(tmp, 'hub')
  const out = path.join(tmp, 'out')
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true })
  fs.mkdirSync(path.join(vault, '.trash'))
  fs.writeFileSync(path.join(vault, 'note.md'), 'hello')
  fs.writeFileSync(path.join(vault, '.obsidian', 'workspace.json'), '{}')
  fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), '{}')
  fs.writeFileSync(path.join(vault, '.trash', 'gone.md'), 'x')
  for (let d = 1; d <= 16; d++) await backup(vault, out, `2026-10-${String(d).padStart(2, '0')}`)
  const zips = fs.readdirSync(out).sort()
  assert.equal(zips.length, 14)
  assert.equal(zips[0], 'hub-2026-10-03.zip')
  const list = execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-tf', path.join(out, zips[13])]).toString()
  assert.match(list, /note\.md/)
  assert.match(list, /app\.json/)
  assert.doesNotMatch(list, /workspace\.json|gone\.md/)
  assert.equal(await backup(path.join(tmp, 'missing'), out), undefined)
  fs.rmSync(tmp, { recursive: true, force: true })
})
