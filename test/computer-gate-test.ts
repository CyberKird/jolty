// The approval gate: the no-questions modes (full, project) never ask; blocked windows are refused, not asked about.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { PermissionMode } from '../src/shared/types'
import { ComputerService, UserError, type AskInput } from '../src/main/computer/service'
import type { WinInfo } from '../src/main/computer/helper'

const win = (exe: string, title = 'x'): WinInfo => ({ hwnd: 1, title, cls: '', pid: 4242, exe, path: `C:\apps\${exe}`, x: 0, y: 0, w: 100, h: 100, minimized: false, maximized: false, focused: true, z: 0 })

function rig(mode: PermissionMode) {
  const asked: AskInput[] = []
  const svc = new ComputerService({
    input: {} as never,
    capturer: {} as never,
    overlay: { active() {}, say() {}, pulse() {}, paused() {}, idle() {}, destroy() {} },
    host: {
      settings: () => ({ human: 'fast', paste: false, trusted: [] }),
      trust() {},
      mode: () => mode,
      enabled: () => true,
      ask: async (_sid, q) => (asked.push(q), 'allow'),
      notice() {},
      clipboard: { readText: async () => '', writeText: async () => {}, hasImage: async () => false },
      self: { pid: 1, exe: 'C:\jolty\Jolty.exe' }
    }
  })
  const st = { x: 0, y: 0, foreground: null, secure: false, idleMs: 0, virtual: { x: 0, y: 0, w: 1, h: 1 } }
  return { svc, asked, s: svc.session('a'), st }
}

test('full mode skips the question for an ordinary application and for open/clipboard', async () => {
  const { svc, asked, s, st } = rig('full')
  await svc.authorize(s, win('notepad.exe'), st, { title: 'Click' })
  await svc.confirmEach(s, { title: 'Open notepad' })
  assert.equal(asked.length, 0)
})

test('no-questions modes do not ask about Windows itself, terminals and Win-key shortcuts either', async () => {
  for (const mode of ['full', 'project'] as const) {
    const { svc, asked, s, st } = rig(mode)
    await svc.authorize(s, win('explorer.exe'), st, { title: 'Click' })
    await svc.authorize(s, win('notepad.exe'), st, { title: 'Type', always: true })
    await svc.confirmEach(s, { title: 'Win+R', always: true })
    assert.equal(asked.length, 0)
  }
})

test('full mode never opens a blocked window', async () => {
  const { svc, s, st } = rig('full')
  await assert.rejects(svc.authorize(s, win('KeePass.exe'), st, { title: 'Click' }), UserError)
})

test('auto mode asks once per application and then remembers', async () => {
  const { svc, asked, s, st } = rig('auto')
  await svc.authorize(s, win('notepad.exe'), st, { title: 'Click' })
  assert.equal(asked.length, 1)
  await svc.confirmEach(s, { title: 'Open notepad' })
  assert.equal(asked.length, 2)
})
