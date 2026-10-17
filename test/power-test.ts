import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatEvent } from '../src/shared/types'
import { PowerGuard } from '../src/main/power'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function make(grace = 40) {
  const events: ChatEvent[] = []
  const calls = { shutdown: 0, cancelled: 0, notified: 0, awake: false }
  let busy = 0
  const guard = new PowerGuard(
    {
      emit: (e) => events.push(e),
      busy: () => busy,
      notify: () => void calls.notified++,
      keepAwake: (on) => void (calls.awake = on),
      shutdown: () => {
        calls.shutdown++
        return () => void calls.cancelled++
      }
    },
    grace,
    60
  )
  return { guard, events, calls, setBusy: (n: number) => (busy = n) }
}

test('nothing happens until work has been seen', async () => {
  const t = make()
  t.guard.arm(true)
  t.guard.onStatus('idle')
  await sleep(120)
  assert.equal(t.calls.shutdown, 0)
})

test('work, then quiet for the grace time: the shutdown starts once, as "done"', async () => {
  const t = make()
  t.guard.arm(true)
  t.setBusy(1)
  t.guard.onStatus('running')
  t.setBusy(0)
  t.guard.onStatus('idle')
  await sleep(120)
  assert.equal(t.calls.shutdown, 1)
  assert.equal(t.calls.notified, 1)
  assert.deepEqual(t.guard.state(), { armed: true, seconds: 60, reason: 'done' })
  t.guard.cancel()
  assert.equal(t.calls.cancelled, 1)
  assert.equal(t.guard.state().armed, false)
})

test('a follow-up turn inside the grace time keeps the PC on', async () => {
  const t = make(80)
  t.guard.arm(true)
  t.setBusy(1)
  t.guard.onStatus('running')
  t.setBusy(0)
  t.guard.onStatus('idle')
  await sleep(30)
  t.setBusy(1)
  t.guard.onStatus('running')
  await sleep(150)
  assert.equal(t.calls.shutdown, 0)
  t.setBusy(0)
  t.guard.onStatus('idle')
  await sleep(150)
  assert.equal(t.calls.shutdown, 1)
})

test('another chat still working holds the shutdown back', async () => {
  const t = make()
  t.guard.arm(true)
  t.setBusy(2)
  t.guard.onStatus('running')
  t.setBusy(1)
  t.guard.onStatus('idle')
  await sleep(120)
  assert.equal(t.calls.shutdown, 0)
})

test('a usage error or a full limit window says "usage"', async () => {
  const a = make()
  a.guard.arm(true)
  a.setBusy(1)
  a.guard.onStatus('running')
  a.setBusy(0)
  a.guard.onStatus('error', 'Claude AI usage limit reached|1760000000')
  await sleep(120)
  assert.equal(a.guard.state().reason, 'usage')
  a.guard.cancel()

  const b = make()
  b.guard.arm(true)
  b.setBusy(1)
  b.guard.onStatus('running')
  b.setBusy(0)
  b.guard.onStatus('idle')
  b.guard.onLimits({ profileId: 'p', windows: [{ label: '5 ore', usedPercent: 100 }], updatedAt: 1 })
  await sleep(120)
  assert.equal(b.guard.state().reason, 'usage')
  b.guard.cancel()
})

test('any other error ends the same way, with its own reason', async () => {
  const t = make()
  t.guard.arm(true)
  t.setBusy(1)
  t.guard.onStatus('running')
  t.setBusy(0)
  t.guard.onStatus('error', 'engine crashed')
  await sleep(120)
  assert.equal(t.guard.state().reason, 'error')
  t.guard.cancel()
})

test('work starting during the countdown cancels the shutdown and disarms', async () => {
  const t = make()
  t.guard.arm(true)
  t.setBusy(1)
  t.guard.onStatus('running')
  t.setBusy(0)
  t.guard.onStatus('idle')
  await sleep(120)
  assert.equal(t.calls.shutdown, 1)
  t.guard.onStatus('running')
  assert.equal(t.calls.cancelled, 1)
  assert.equal(t.guard.state().armed, false)
})

test('armed keeps the PC awake, disarmed lets it sleep again', () => {
  const t = make()
  t.guard.arm(true)
  assert.equal(t.calls.awake, true)
  t.guard.cancel()
  assert.equal(t.calls.awake, false)
})

test('disarmed means nothing ever happens', async () => {
  const t = make()
  t.setBusy(1)
  t.guard.onStatus('running')
  t.setBusy(0)
  t.guard.onStatus('idle')
  await sleep(120)
  assert.equal(t.calls.shutdown, 0)
})
