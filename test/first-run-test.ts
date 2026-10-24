import assert from 'node:assert/strict'
import test from 'node:test'
import type { Profile } from '../src/shared/types'
import { CONNECT_PROVIDERS, explainKeyFailure, keyTestRequest, wantsOwnKeyHint } from '../src/shared/setup'
import { withDetectedAgents } from '../src/main/first-run'

const claude: Profile = { id: 'claude-main', name: 'Claude', engine: 'claude', auth: 'subscription', isDefaultDir: true, color: '#d97757' }
const codex: Profile = { id: 'codex-main', name: 'Codex', engine: 'codex', auth: 'subscription', isDefaultDir: true, color: '#10a37f' }

test('a fresh install gets no Claude or Codex profile, whatever is installed', () => {
  assert.deepEqual(withDetectedAgents([], { hermes: false, opencode: false }), [])
  const both = withDetectedAgents([], { hermes: true, opencode: true })
  assert.deepEqual(both.map((p) => p.engine), ['hermes', 'opencode'])
  assert.notEqual(both[0].color, both[1].color)
})

test('an existing user keeps the profiles as they are, and agents are not added twice', () => {
  const saved = [claude, codex]
  assert.deepEqual(withDetectedAgents(saved, { hermes: false, opencode: false }), saved)
  const once = withDetectedAgents(saved, { hermes: false, opencode: true })
  assert.deepEqual(once.slice(0, 2), saved)
  assert.equal(withDetectedAgents(once, { hermes: false, opencode: true }).length, 3)
  assert.equal(saved.length, 2, 'the saved list is not changed in place')
})

test('the own-key suggestion needs a chat, only free models, and is gone once closed', () => {
  const free = [{ engine: 'opencode' as const }]
  assert.equal(wantsOwnKeyHint(free, 0), false)
  assert.equal(wantsOwnKeyHint(free, 1), true)
  assert.equal(wantsOwnKeyHint(free, 1, true), false)
  assert.equal(wantsOwnKeyHint([...free, { engine: 'claude' as const }], 5), false)
  assert.equal(wantsOwnKeyHint([], 5), false)
})

test('the key test is one small messages request with the key as a bearer token', () => {
  const p = CONNECT_PROVIDERS[0]
  const { url, init } = keyTestRequest(p.baseUrl + '/', p.model, 'sk-test')
  assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal((init.headers as Record<string, string>).authorization, 'Bearer sk-test')
  const body = JSON.parse(String(init.body))
  assert.equal(body.model, p.model)
  assert.ok(body.max_tokens <= 16)
  assert.ok(CONNECT_PROVIDERS.every((x) => x.baseUrl.startsWith('https://') && x.keyUrl.startsWith('https://')))
})

test('a failed key test says what is wrong', () => {
  assert.match(explainKeyFailure(401, '', 'm'), /cheia|key/i)
  assert.match(explainKeyFailure(402, '', 'm'), /sold|balance/i)
  assert.match(explainKeyFailure(404, 'nope', 'my-model'), /my-model/)
  assert.match(explainKeyFailure(500, 'boom', 'm'), /500/)
})
