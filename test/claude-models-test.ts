import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeAccountModels, parseAccountModels } from '../src/shared/claude-models'

const eff = { low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } }
const account = parseAccountModels({
  data: [
    { id: 'claude-fable-5-2', display_name: 'Claude Fable 5.2', created_at: '2026-11-09T18:30:00Z', line: 'fable', capabilities: { effort: eff } },
    { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-10-07T18:00:00Z', line: 'haiku', capabilities: { effort: eff } },
    { id: 'claude-opus-4-1-20250805', display_name: 'Claude Opus 4.1', created_at: '2025-08-05T00:00:00Z', line: 'opus' },
    { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', line: 'opus', capabilities: { effort: eff } }
  ]
})
// what a Claude Code of an older release lists
const sdk = () => [
  { id: 'opus', label: 'Opus 5.5', description: 'Opus 5.5 - everyday', isDefault: true, efforts: ['low', 'high'] },
  { id: 'fable', label: 'Fable 5.1', description: 'Fable 5.1 - hardest tasks', efforts: ['low'] },
  { id: 'haiku', label: 'Haiku 5.5', description: 'Haiku 5.5 - fast' }
]
const NOW = Date.parse('2026-11-10T12:00:00Z')

test('a newer model of a line the account has replaces the old row, keeping its description and place', () => {
  const out = mergeAccountModels(sdk(), account, NOW)
  assert.deepEqual(out.map((m) => m.label), ['Opus 5.5', 'Fable 5.2', 'Haiku 5.5'])
  const fable = out[1]
  assert.equal(fable.id, 'claude-fable-5-2')
  // a chat started on the old alias still finds its row
  assert.equal(fable.alias, 'fable')
  assert.equal(fable.description, 'Fable 5.1 - hardest tasks')
  assert.deepEqual(fable.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('rows that are already the newest stay as they are, aliases included', () => {
  const out = mergeAccountModels(sdk(), account, NOW)
  assert.equal(out[0].id, 'opus')
  assert.equal(out[0].isDefault, true)
  assert.deepEqual(out[0].efforts, ['low', 'high'])
  assert.equal(out[2].id, 'haiku')
})

test('an account that lists nothing, or an older model than Claude Code knows, changes nothing', () => {
  assert.deepEqual(mergeAccountModels(sdk(), [], NOW), sdk())
  const older = parseAccountModels({ data: [{ id: 'claude-fable-5-0', display_name: 'Claude Fable 5.0', line: 'fable' }] })
  assert.deepEqual(mergeAccountModels(sdk(), older, NOW), sdk())
})

test('a line Claude Code does not know is added while it is new, never when it is old', () => {
  const nova = parseAccountModels({
    data: [{ id: 'claude-nova-1', display_name: 'Claude Nova 1', created_at: '2026-11-08T00:00:00Z', line: 'nova', capabilities: { effort: { low: {}, high: {} } } }]
  })
  const out = mergeAccountModels(sdk(), nova, NOW)
  assert.equal(out.at(-1)?.label, 'Nova 1')
  assert.deepEqual(out.at(-1)?.efforts, ['low', 'high'])
  const old = parseAccountModels({ data: [{ id: 'claude-nova-1', display_name: 'Claude Nova 1', created_at: '2026-01-01T00:00:00Z', line: 'nova' }] })
  assert.equal(mergeAccountModels(sdk(), old, NOW).length, 3)
})

test('garbage in the account answer is ignored', () => {
  assert.deepEqual(parseAccountModels(null), [])
  assert.deepEqual(parseAccountModels({ data: [null, { nope: 1 }] }), [])
})
