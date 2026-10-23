import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidates, pickAuto } from '../src/main/auto-model'
import { FLAG_DAYS, flagOf, observe, parseOllamaTags, parseProviderList, withBadges } from '../src/main/model-watch-core'
import { modelScore, parseRemoteScores, setRemoteScores } from '../src/shared/scores'
import type { ModelOption, Profile } from '../src/shared/types'

const DAY = 864e5
const T0 = Date.UTC(2026, 9, 1)

test('the first listing of a source is only recorded, nothing is flagged', () => {
  const r = observe(undefined, [{ id: 'opus', label: 'Opus 5.5' }], T0)
  assert.equal(r.fresh.length, 0)
  assert.equal(r.changed.length, 0)
  assert.equal(r.next[0].flag, undefined)
  assert.equal(r.next[0].first, T0)
})

test('an id never seen is new, for 7 days', () => {
  const base = observe(undefined, [{ id: 'opus', label: 'Opus 5.5' }], T0).next
  const r = observe(base, [{ id: 'opus', label: 'Opus 5.5' }, { id: 'fable', label: 'Fable 5.1' }], T0 + DAY)
  assert.deepEqual(r.fresh.map((m) => m.id), ['fable'])
  const rec = r.next.find((m) => m.id === 'fable')
  assert.equal(flagOf(rec, T0 + DAY), 'new')
  assert.equal(flagOf(rec, T0 + DAY + (FLAG_DAYS - 1) * DAY), 'new')
  assert.equal(flagOf(rec, T0 + DAY + FLAG_DAYS * DAY), undefined)
  assert.equal(flagOf(r.next.find((m) => m.id === 'opus'), T0 + DAY), undefined)
  // seen again later: still the same record, not announced twice
  const again = observe(r.next, [{ id: 'fable', label: 'Fable 5.1' }], T0 + 2 * DAY)
  assert.equal(again.fresh.length, 0)
  assert.equal(again.next.find((m) => m.id === 'fable')?.first, T0 + DAY)
})

test('the same alias with another label or version is updated', () => {
  const base = observe(undefined, [{ id: 'opus', label: 'Opus 5.5', version: 'a' }, { id: 'sonnet', label: 'Sonnet 5.5', version: 'b' }], T0).next
  const r = observe(base, [{ id: 'opus', label: 'Opus 6', version: 'a' }, { id: 'sonnet', label: 'Sonnet 5.5', version: 'c' }], T0 + DAY)
  assert.deepEqual(r.changed.map((m) => m.id), ['opus', 'sonnet'])
  assert.equal(r.fresh.length, 0)
  const opus = r.next.find((m) => m.id === 'opus')
  assert.equal(opus?.label, 'Opus 6')
  assert.equal(flagOf(opus, T0 + DAY), 'updated')
  assert.equal(flagOf(opus, T0 + DAY + 8 * DAY), undefined)
  assert.equal(base[0].label, 'Opus 5.5', 'the recorded list is not edited in place')
})

test('quiet listings change nothing: unchanged, empty, missing version, a model that left and came back', () => {
  const base = observe(undefined, [{ id: 'a', label: 'A', version: 'v1' }, { id: 'b', label: 'B' }], T0).next
  const same = observe(base, [{ id: 'a', label: 'A', version: 'v1' }, { id: 'b', label: 'B' }], T0 + DAY)
  assert.equal(same.fresh.length + same.changed.length, 0)
  assert.equal(observe(base, [], T0 + DAY).next, base)
  assert.equal(observe(undefined, [], T0).next.length, 0)
  const noVersion = observe(base, [{ id: 'a', label: 'A' }], T0 + DAY)
  assert.equal(noVersion.changed.length, 0)
  const away = observe(base, [{ id: 'b', label: 'B' }], T0 + DAY)
  const back = observe(away.next, [{ id: 'a', label: 'A', version: 'v1' }, { id: 'b', label: 'B' }], T0 + 2 * DAY)
  assert.equal(back.fresh.length, 0)
})

test('odd ids: duplicates once, prototype names are plain ids, empty ids dropped', () => {
  const base = observe(undefined, [{ id: 'a', label: 'A' }], T0).next
  const r = observe(base, [{ id: 'x', label: 'X' }, { id: 'x', label: 'X' }, { id: '__proto__', label: 'P' }, { id: '', label: 'none' }], T0 + DAY)
  assert.deepEqual(r.fresh.map((m) => m.id), ['x', '__proto__'])
  assert.equal(({} as Record<string, unknown>).x, undefined)
})

test('badges go on the picker list, other models stay as they are', () => {
  const seen = observe(observe(undefined, [{ id: 'a', label: 'A' }], T0).next, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], T0 + DAY).next
  const list: ModelOption[] = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
  const out = withBadges(list, seen, T0 + 2 * DAY)
  assert.equal(out[0], list[0])
  assert.equal(out[1].badge, 'new')
  assert.equal(withBadges(list, undefined, T0), list)
})

test('provider and Ollama listings are parsed, anything else is an empty list', () => {
  assert.deepEqual(parseProviderList({ object: 'list', data: [{ id: 'deepseek-v4-pro' }, { id: 'x', name: 'X Model' }, { nope: 1 }, null] }), [
    { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
    { id: 'x', label: 'X Model' }
  ])
  assert.deepEqual(parseProviderList('<html>'), [])
  assert.deepEqual(parseProviderList({ data: 5 }), [])
  assert.deepEqual(parseOllamaTags({ models: [{ name: 'gemma4:27b', digest: 'abcdef0123456789ff' }, { name: 3 }] }), [{ id: 'gemma4:27b', label: 'gemma4:27b', version: 'abcdef012345' }])
  assert.deepEqual(parseOllamaTags(null), [])
})

const good = { match: ['Opus'], iq: 60, tps: 80, note: 'Opus 6' }

test('scores.json: a good file is accepted, matches are lowercased', () => {
  const r = parseRemoteScores({ updated: 'x', entries: [good, { match: ['deepseek', 'pro'], iq: 40, note: 'DS' }] })
  assert.equal(r?.length, 2)
  assert.deepEqual(r?.[0].match, ['opus'])
  assert.equal(r?.[1].tps, undefined)
})

test('scores.json: hostile or broken entries are dropped, a hostile file is rejected', () => {
  const bad = [
    { ...good, iq: 9999 },
    { ...good, iq: -1 },
    { ...good, iq: '50' },
    { ...good, iq: null },
    { ...good, tps: 1e9 },
    { ...good, tps: 'fast' },
    { ...good, match: [] },
    { ...good, match: 'opus' },
    { ...good, match: ['a', 'b', 'c', 'd', 'e'] },
    { ...good, match: ['x'.repeat(65)] },
    { ...good, match: [''] },
    { ...good, match: [{ toString: 1 }] },
    { ...good, note: 'n'.repeat(201) },
    { ...good, note: 'a\u0000b' },
    { ...good, note: 5 },
    { ...good, note: '   ' },
    null,
    'text',
    JSON.parse('{"__proto__": {"iq": 1}, "match": ["a"], "note": "n"}')
  ]
  assert.equal(parseRemoteScores({ entries: bad }), undefined)
  const mixed = parseRemoteScores({ entries: [...bad, good] })
  assert.equal(mixed?.length, 1)
  assert.equal(parseRemoteScores({ entries: Array.from({ length: 201 }, () => good) }), undefined)
  assert.equal(parseRemoteScores({ entries: Array.from({ length: 200 }, () => good) })?.length, 200)
  for (const raw of [null, undefined, 3, 'x', [], { entries: 'x' }, { entries: {} }, { entries: [] }]) assert.equal(parseRemoteScores(raw), undefined)
  assert.equal(({} as Record<string, unknown>).iq, undefined, 'nothing leaked onto Object.prototype')
})

const cloud = { local: false } as Profile
const local = { local: true } as Profile

test('scores: substring matching, remote before the built-in table, no patterns from remote text', () => {
  setRemoteScores([])
  assert.equal(modelScore(cloud, { id: 'opus', label: 'Opus 5.5' })?.iq, 54, 'built-in table')
  assert.equal(modelScore(cloud, { id: 'zzz', label: 'Unknown' }), undefined)
  setRemoteScores(
    parseRemoteScores({
      entries: [
        { match: ['opus', '6'], iq: 61, tps: 120, note: 'Opus 6' },
        { match: ['.*'], iq: 99, note: 'pattern' },
        { match: ['new-model'], iq: 70, tps: 50, note: 'N' }
      ]
    })!
  )
  assert.equal(modelScore(cloud, { id: 'opus', label: 'Opus 6' })?.iq, 61)
  assert.equal(modelScore(cloud, { id: 'opus', label: 'Opus 6' })?.speed, 'rapid')
  assert.equal(modelScore(cloud, { id: 'opus', label: 'Opus 5.5' })?.iq, 54, 'every match text must appear: falls through to the built-in table')
  assert.equal(modelScore(cloud, { id: 'zzz', label: 'Unknown' }), undefined, '".*" is text, not a pattern')
  assert.equal(modelScore(cloud, { id: 'New-Model-1', label: 'x' })?.speed, 'lent')
  assert.equal(modelScore(local, { id: 'new-model', label: 'x' })?.tps, undefined, 'a local model has no measured speed')
  const attached = { iq: 1, note: 'from main' }
  assert.equal(modelScore(cloud, { id: 'opus', label: 'Opus 5.5', score: attached }), attached)
  setRemoteScores([])
})

test('auto choice: the strongest model for a hard job, the fastest good enough one for a simple job', () => {
  const sub = { id: 'a', name: 'A', engine: 'claude', auth: 'subscription' } as Profile
  const api = { id: 'b', name: 'B', engine: 'claude', auth: 'endpoint' } as Profile
  const all = [
    ...candidates(sub, [{ id: 'opus', label: 'Opus 5.5' }, { id: 'sonnet', label: 'Sonnet 5.5' }, { id: 'haiku', label: 'Haiku 4.5' }]),
    ...candidates(api, [{ id: 'deepseek-flash', label: 'deepseek-flash' }, { id: 'unknown-model', label: 'unknown-model' }])
  ]
  assert.equal(pickAuto('hard', all)?.model, 'opus')
  // Haiku is faster than Sonnet but too weak (17), DeepSeek Flash is the fastest above the bar
  assert.equal(pickAuto('simple', all)?.model, 'deepseek-flash')
  assert.equal(pickAuto('simple', all.filter((c) => c.profileId === 'a'))?.model, 'sonnet')
  assert.equal(pickAuto('hard', []), undefined)
})

