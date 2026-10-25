import assert from 'node:assert/strict'
import test from 'node:test'
import { versionProblem } from '../scripts/release-version.mjs'

const fix = '### Fixed\n\n- a bug'
const feat = '### New\n\n- a thing\n\n### Fixed\n\n- a bug'

test('fixes only: the next patch', () => {
  assert.equal(versionProblem('0.7.27', '0.7.28', fix), undefined)
  assert.match(versionProblem('0.7.27', '0.8.0', fix), /0\.7\.28/)
  assert.match(versionProblem('0.7.27', '0.7.29', fix), /0\.7\.28/)
  assert.ok(versionProblem('0.7.27', '0.7.27', fix))
})

test('a new feature: the next minor, patch back to 0', () => {
  assert.equal(versionProblem('0.7.27', '0.8.0', feat), undefined)
  assert.match(versionProblem('0.7.27', '0.7.28', feat), /0\.8\.0/)
  assert.match(versionProblem('0.7.27', '0.8.1', feat), /0\.8\.0/)
  assert.match(versionProblem('0.7.27', '0.9.0', feat), /0\.8\.0/)
})

test('a new major is allowed, junk is refused', () => {
  assert.equal(versionProblem('0.9.4', '1.0.0', fix), undefined)
  assert.ok(versionProblem('0.7.x', '0.7.28', fix))
})
