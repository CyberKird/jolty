import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatEvent, PowerAction } from '../src/shared/types'
import { PowerGuard } from '../src/main/power'
import { DEFAULT_PLAN, dueAt, sanitizePlan } from '../src/shared/power'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function make(grace = 40) {
  const events: ChatEvent[] = []
  const calls = {
    shutdown: 0,
    cancelled: 0,
    notified: 0,
    awake: false,
    last: undefined as undefined | { seconds: number; action: PowerAction; force: boolean },
    fired: (_error?: string): void => undefined
  }
  let busy = 0
  const guard = new PowerGuard(
    {
      emit: (e) => events.push(e),
      busy: () => busy,
      notify: () => void calls.notified++,
      keepAwake: (on) => void (calls.awake = on),
      shutdown: (seconds, _message, action, force, fired) => {
        calls.shutdown++
        calls.last = { seconds, action, force }
        calls.fired = fired
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
  assert.deepEqual(t.guard.state(), { armed: true, plan: DEFAULT_PLAN, seconds: 60, reason: 'done' })
  assert.deepEqual(t.calls.last, { seconds: 60, action: 'shutdown', force: true })
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

test('armed while a chat is already working: its end still starts the shutdown', async () => {
  const t = make()
  // the chat started before the arm, so its "running" was never seen by the guard
  t.setBusy(1)
  t.guard.arm(true)
  t.setBusy(0)
  t.guard.onStatus('idle')
  await sleep(120)
  assert.equal(t.calls.shutdown, 1)
  assert.equal(t.guard.state().reason, 'done')
  t.guard.cancel()
})

test('the plan decides the action and the force flag; sleep gets the short warning', async () => {
  const t = make()
  t.guard.arm(true, { action: 'restart', when: { kind: 'done' }, force: false })
  t.setBusy(1)
  t.guard.onStatus('running')
  t.setBusy(0)
  t.guard.onStatus('idle')
  await sleep(120)
  assert.deepEqual(t.calls.last, { seconds: 60, action: 'restart', force: false })
  t.guard.cancel()
  // the last plan stays for the next arm
  assert.equal(t.guard.state().plan.action, 'restart')

  t.guard.arm(true, { action: 'sleep', when: { kind: 'done' }, force: true })
  t.setBusy(1)
  t.guard.onStatus('running')
  t.setBusy(0)
  t.guard.onStatus('idle')
  await sleep(120)
  assert.deepEqual(t.calls.last, { seconds: 15, action: 'sleep', force: true })
  // sleep is done by Jolty itself: once it ran the plan is spent and the PC may sleep again
  t.calls.fired()
  assert.equal(t.guard.state().armed, false)
  assert.equal(t.calls.awake, false)
})

test('a timer fires at its time, ignores the chats, and a failed action still disarms', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const t = make()
  t.guard.arm(true, { action: 'lock', when: { kind: 'in', minutes: 5 }, force: true })
  assert.equal(t.guard.state().due, Date.now() + 5 * 60_000)
  // work coming and going changes nothing for a timer
  t.setBusy(1)
  t.guard.onStatus('running')
  t.setBusy(0)
  t.guard.onStatus('idle')
  ctx.mock.timers.tick(5 * 60_000 - 1)
  assert.equal(t.calls.shutdown, 0)
  ctx.mock.timers.tick(1)
  assert.equal(t.calls.shutdown, 1)
  assert.deepEqual(t.calls.last, { seconds: 15, action: 'lock', force: true })
  assert.equal(t.guard.state().reason, 'timer')
  t.setBusy(1)
  t.guard.onStatus('running')
  assert.equal(t.calls.cancelled, 0)
  t.calls.fired('boom')
  assert.equal(t.guard.state().armed, false)
  assert.equal(t.calls.notified, 2)
})

test('cancelling a timer before its time means it never fires', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const t = make()
  t.guard.arm(true, { action: 'shutdown', when: { kind: 'in', minutes: 1 }, force: true })
  t.guard.cancel()
  ctx.mock.timers.tick(10 * 60_000)
  assert.equal(t.calls.shutdown, 0)
  assert.equal(t.guard.state().due, undefined)
})

test('plans from outside are checked: junk falls back, minutes and times are bounded', () => {
  assert.deepEqual(sanitizePlan(null), DEFAULT_PLAN)
  assert.deepEqual(sanitizePlan({ action: 'rm -rf', when: { kind: 'bogus' }, force: 'x' }), DEFAULT_PLAN)
  assert.deepEqual(sanitizePlan({ action: 'lock', when: { kind: 'in', minutes: 999999 }, force: false }), { action: 'lock', when: { kind: 'in', minutes: 1440 }, force: false })
  assert.deepEqual(sanitizePlan({ when: { kind: 'in', minutes: -3 } }).when, { kind: 'in', minutes: 1 })
  assert.deepEqual(sanitizePlan({ when: { kind: 'at', time: '25:99' } }).when, { kind: 'done' })
  assert.deepEqual(sanitizePlan({ when: { kind: 'at', time: '07:30' } }).when, { kind: 'at', time: '07:30' })
})

test('a time of day that has passed means tomorrow', () => {
  const now = new Date(2026, 0, 10, 12, 0, 0).getTime()
  assert.equal(dueAt({ kind: 'at', time: '13:30' }, now), new Date(2026, 0, 10, 13, 30).getTime())
  assert.equal(dueAt({ kind: 'at', time: '11:00' }, now), new Date(2026, 0, 11, 11, 0).getTime())
  assert.equal(dueAt({ kind: 'at', time: '12:00' }, now), new Date(2026, 0, 11, 12, 0).getTime())
})
