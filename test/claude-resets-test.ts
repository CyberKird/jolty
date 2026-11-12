import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseResets } from '../src/shared/claude-resets'

// the shape claude.ai answered for a Pro account on 2026-11-12 (ids and wording as the account reported them)
const usage = {
  five_hour: { utilization: 22 },
  promo_credits: null,
  cedar_ember: {
    eligible: true,
    grants: [
      {
        id: 'launch-2610-fable-week',
        label: 'New model launch: one Fable reset for Pro and Team Standard, launch week only',
        resets_total: 1,
        resets_left: 1,
        starts_at: '2026-11-09T18:00:00+00:00',
        ends_at: '2026-11-17T07:59:00+00:00',
        clears: ['five_hour', 'seven_day_overage_included'],
        paused: false,
        usable_now: true,
        gives_back_weekly: true
      },
      {
        id: 'full-reset-2611',
        label: 'One full limit reset (November 2026)',
        resets_total: 1,
        resets_left: 1,
        starts_at: '2026-11-10T21:30:00+00:00',
        ends_at: '2026-12-10T22:00:00+00:00',
        clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
        paused: false,
        usable_now: true,
        gives_back_weekly: false
      }
    ]
  }
}
const NOW = Date.UTC(2026, 10, 12)

test('both resets of the account are read, the one that expires first on top', () => {
  const list = parseResets(usage, NOW)
  assert.deepEqual(list.map((g) => g.id), ['launch-2610-fable-week', 'full-reset-2611'])
  assert.equal(list[0].full, false, 'the Fable reset gives back the weekly use of one model, it does not reset the week')
  assert.equal(list[1].full, true, 'the full reset clears the weekly limit')
  assert.equal(list[1].endsAt, Date.UTC(2026, 11, 10, 22, 0, 0))
  assert.equal(list[1].left, 1)
  assert.equal(list[1].usableNow, true)
})

test('a spent, expired or paused grant is not offered as usable', () => {
  const g = (patch: object) => ({ cedar_ember: { grants: [{ ...usage.cedar_ember.grants[1], ...patch }] } })
  assert.equal(parseResets(g({ resets_left: 0 }), NOW).length, 0, 'spent')
  assert.equal(parseResets(g({ ends_at: '2026-11-01T00:00:00+00:00' }), NOW).length, 0, 'expired')
  assert.equal(parseResets(g({ paused: true }), NOW)[0].usableNow, false, 'paused is kept but not usable now')
})

test('an answer without grants, or in another shape, gives an empty list', () => {
  assert.deepEqual(parseResets(null), [])
  assert.deepEqual(parseResets({}), [])
  assert.deepEqual(parseResets({ cedar_ember: { eligible: false, ineligible_reason: 'surface', grants: [] } }), [])
  assert.deepEqual(parseResets({ cedar_ember: { grants: 'x' } }), [])
  assert.deepEqual(parseResets({ cedar_ember: { grants: [null, 5, { label: 'no id' }] } }), [])
})
