// Before the real mouse and keyboard move for the first time in a turn, the user is told on screen and gets 3 seconds.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ComputerService } from '../src/main/computer/service'

function rig() {
  const said: string[] = []
  const slept: number[] = []
  const played: number[] = []
  const display = { id: 1, x: 0, y: 0, w: 100, h: 100, scale: 1, primary: true }
  const svc = new ComputerService({
    input: { idleMs: async () => 99999, play: async () => (played.push(Date.now()), { reason: 'done', done: 1, total: 1 }) } as never,
    capturer: { displays: () => [display] } as never,
    overlay: { active() {}, say: (t: string) => said.push(t), pulse() {}, paused() {}, idle() {}, destroy() {} },
    host: {} as never,
    sleep: async (ms: number) => void slept.push(ms)
  })
  return { svc, said, slept, played, s: svc.session('a') }
}

test('the first action of a turn announces itself and waits, the next ones do not', async () => {
  const { svc, said, slept, played, s } = rig()
  await svc.perform(s, [])
  assert.equal(said.length, 1)
  assert.ok(slept.includes(3000))
  assert.equal(played.length, 1)
  await svc.perform(s, [])
  assert.equal(said.length, 1, 'once per turn')
  assert.equal(slept.filter((ms) => ms === 3000).length, 1)
})

test('a new message from the user warns again', async () => {
  const { svc, said, s } = rig()
  await svc.perform(s, [])
  svc.newTurn('a')
  await svc.perform(s, [])
  assert.equal(said.length, 2)
})
