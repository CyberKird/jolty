import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { parseChangelog, splitLead } from '@shared/changelog'

test('releases with sections and plain lists', () => {
  const md = `# Changelog

## 0.5.7

### New

- Jolty in 3D. He walks
  along the composer.
- What's new: a window.

### Fixes

- No more freezes.

## 0.5.6

- Updates go straight to the newest version. Restart once.
`
  const r = parseChangelog(md)
  assert.deepEqual(r.map((x) => x.version), ['0.5.7', '0.5.6'])
  assert.deepEqual(r[0].groups.map((g) => [g.name, g.items.length]), [['New', 2], ['Fixes', 1]])
  assert.deepEqual(r[0].groups[0].items[0], { title: 'Jolty in 3D', body: 'He walks along the composer.' })
  assert.deepEqual(r[0].groups[0].items[1], { title: "What's new", body: 'A window.' })
  assert.deepEqual(r[1].groups, [{ name: '', items: [{ title: 'Updates go straight to the newest version', body: 'Restart once.' }] }])
})

test('a lead too long to be a title stays in the body', () => {
  const long = 'x'.repeat(160) + '. tail'
  assert.deepEqual(splitLead(long), { title: '', body: long })
  // version numbers and decimals are not sentence ends
  assert.equal(splitLead('Codex 0.163.0 is bundled').title, '')
})

test('the real changelog parses with the newest release first', () => {
  const r = parseChangelog(fs.readFileSync('CHANGELOG.md', 'utf8'))
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  assert.ok(r.length > 10)
  assert.ok(r.every((x) => x.groups.length && x.groups.every((g) => g.items.length)))
  assert.ok(r.some((x) => x.version === pkg.version), `CHANGELOG.md has no ${pkg.version}`)
})
