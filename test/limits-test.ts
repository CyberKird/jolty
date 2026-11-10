import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bucketFor, extraWindows, newExtras } from '../src/shared/limits'

// trimmed from a real answer of the account usage endpoint (Pro plan, Fable included for half of the weekly limit)
const answer = {
  five_hour: { utilization: 39, resets_at: '2026-11-10T15:10:00.282857+00:00' },
  limits: [
    { kind: 'session', percent: 39, resets_at: '2026-11-10T15:10:00.282857+00:00', scope: null },
    { kind: 'weekly_all', percent: 75, resets_at: '2026-11-11T18:00:00.282879+00:00', scope: null },
    { kind: 'weekly_scoped', percent: 12, resets_at: '2026-11-11T18:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } }
  ],
  weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 6, allowance_percent_of_weekly: 50 }]
}

test('a weekly_scoped row becomes a meter of its own with its share of the weekly limit', () => {
  const [w, ...rest] = extraWindows(answer)
  assert.equal(rest.length, 0)
  assert.equal(w.label, 'Fable')
  assert.equal(w.scope, 'Fable')
  assert.equal(w.usedPercent, 12)
  assert.equal(w.allowance, 50)
  assert.equal(w.resetsAt, Date.parse('2026-11-11T18:00:00Z'))
})

test('no scoped row, no shares or nonsense: nothing, never a crash', () => {
  assert.deepEqual(extraWindows(null), [])
  assert.deepEqual(extraWindows({}), [])
  assert.deepEqual(extraWindows({ limits: 'x' }), [])
  // a bucket without a model name still shows, under its kind, tied to no model
  const unnamed = extraWindows({ limits: [{ kind: 'weekly_scoped', percent: 5, scope: { model: {} } }] })
  assert.equal(unnamed[0].label, 'Weekly scoped')
  assert.equal(unnamed[0].scope, undefined)
  assert.deepEqual(extraWindows({ limits: [{ kind: 'weekly_scoped', percent: 500, scope: { model: { display_name: 'Fable' } } }] }), [])
  const noShare = extraWindows({ limits: [{ kind: 'weekly_scoped', percent: 5, scope: { model: { display_name: 'Fable' } } }] })
  assert.equal(noShare[0].allowance, undefined)
})

test('a model draws from the bucket whose name starts its label', () => {
  const windows = extraWindows(answer)
  assert.equal(bucketFor(windows, 'Fable 5.2')?.scope, 'Fable')
  assert.equal(bucketFor(windows, 'fable')?.scope, 'Fable')
  assert.equal(bucketFor(windows, 'Fableish 1'), undefined)
  assert.equal(bucketFor(windows, 'Opus 5.5'), undefined)
  assert.equal(bucketFor(undefined, 'Fable 5.2'), undefined)
  assert.equal(bucketFor([{ label: '5 ore', usedPercent: 3 }], 'Fable 5.2'), undefined)
})

test('nothing is tied to one model or offer: any bucket the account lists is a meter, an account without any gets none', () => {
  const plain = { five_hour: { utilization: 3 }, limits: [{ kind: 'session', percent: 3 }, { kind: 'weekly_all', percent: 9 }], weekly_scoped_shares: [] }
  assert.deepEqual(extraWindows(plain), [])
  const other = extraWindows({
    limits: [{ kind: 'weekly_scoped', percent: 40, resets_at: '2026-12-01T00:00:00Z', scope: { model: { display_name: 'Nova' } } }],
    weekly_scoped_shares: [{ limit_index: 0, allowance_percent_of_weekly: 30 }]
  })
  assert.equal(other[0].scope, 'Nova')
  assert.equal(other[0].allowance, 30)
  assert.equal(other[0].extra, true)
  assert.equal(bucketFor(other, 'Nova 2')?.label, 'Nova')
  // a kind never seen before still shows, under its own name; a promotional window beside the main ones too
  const odd = extraWindows({ limits: [{ kind: 'weekend_boost', percent: 10 }], omelette_promotional: { utilization: 25, resets_at: '2026-12-01T00:00:00Z' }, tangelo: null })
  assert.deepEqual(odd.map((w) => w.label), ['Weekend boost', 'Omelette promotional'])
  assert.ok(odd.every((w) => w.extra && !w.scope))
})

test('a bucket is announced once, when it first shows up; the main limits never are', () => {
  const main = { label: '5 ore', usedPercent: 3 }
  const fable = { label: 'Fable', usedPercent: 0, extra: true as const, scope: 'Fable' }
  assert.deepEqual(newExtras(undefined, [main, fable]).map((w) => w.label), ['Fable'])
  assert.deepEqual(newExtras([main], [main, fable]).map((w) => w.label), ['Fable'])
  assert.deepEqual(newExtras([main, fable], [main, { ...fable, usedPercent: 40 }]), [])
  assert.deepEqual(newExtras([main, fable], [main]), [])
  assert.deepEqual(newExtras(undefined, [main]), [])
})
