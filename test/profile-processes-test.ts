import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProfileProcesses } from '../src/main/engines/profile-processes'
import { removeProfileFiles } from '../src/main/profile-files'

test('stopping one profile waits for its processes and preserves another profile', async () => {
  const processes = new ProfileProcesses()
  const start = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  const removed = processes.track('removed', start())
  const kept = processes.track('kept', start())
  await Promise.all([once(removed, 'spawn'), once(kept, 'spawn')])
  try {
    await processes.stop('removed')
    assert.ok(removed.exitCode !== null || removed.signalCode !== null)
    assert.equal(kept.exitCode, null)
    assert.equal(kept.signalCode, null)
    await processes.stop('removed')
  } finally {
    await processes.stop('kept')
  }
})

test('a process that already exited does not block profile removal', async () => {
  const processes = new ProfileProcesses()
  const child = processes.track('finished', spawn(process.execPath, ['-e', ''], { windowsHide: true }))
  await once(child, 'close')
  await processes.stop('finished')
})

test('profile cleanup preserves shared targets, including nested and dangling links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-profile-files-'))
  const profile = path.join(root, 'profile')
  const shared = path.join(root, 'shared')
  fs.mkdirSync(path.join(profile, 'nested'), { recursive: true })
  fs.mkdirSync(shared)
  fs.writeFileSync(path.join(shared, 'keep.txt'), 'keep')
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  fs.symlinkSync(shared, path.join(profile, 'skills'), type)
  fs.symlinkSync(shared, path.join(profile, 'nested', 'plugins'), type)
  fs.symlinkSync(path.join(root, 'missing'), path.join(profile, 'missing'), type)
  try {
    removeProfileFiles(profile)
    assert.equal(fs.existsSync(profile), false)
    assert.equal(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf8'), 'keep')
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
