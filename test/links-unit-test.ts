import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canHelpSetup, setupHelperBrief } from '../src/shared/setup'
import { bugReportUrl, CONTACT, openableUrl, reportCheck, REPORTS_PER_HOUR } from '../src/shared/links'

test('the bug report mail goes to contact@joltarise.com and carries the text and the facts', () => {
  const u = new URL(bugReportUrl('Nu pornește chatul & se blochează', 'Jolty 0.9.0 | Windows NT 10.0'))
  assert.equal(u.protocol, 'mailto:')
  assert.equal(decodeURIComponent(u.pathname), 'contact@joltarise.com')
  assert.equal(CONTACT, 'contact@joltarise.com')
  assert.equal(u.searchParams.get('subject'), 'Jolty: bug report')
  const body = u.searchParams.get('body') || ''
  assert.match(body, /Nu pornește chatul & se blochează/)
  assert.match(body, /Jolty 0\.9\.0/)
})

test('a long report is cut so the mail URL stays under the Windows limit', () => {
  assert.ok(bugReportUrl('x'.repeat(5000), 'f').length < 2000)
})

test('the app opens web pages and mail to Jolty only', () => {
  assert.ok(openableUrl('https://ko-fi.com/joltarise'))
  assert.ok(openableUrl(bugReportUrl('ceva s-a stricat aici', 'f')))
  for (const bad of ['mailto:someone@else.com', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'mailto:x@y.com?to=contact@joltarise.com', '', 5, undefined]) assert.equal(openableUrl(bad), false, String(bad))
})

test('the report brake: too short, link lists, and a few per hour', () => {
  const now = 1e12
  assert.equal(reportCheck('prea scurt', [], now), 'short')
  assert.equal(reportCheck('uite https://a.ro https://b.ro https://c.ro', [], now), 'links')
  assert.equal(reportCheck('chatul se blochează la pornire', [], now), 'ok')
  const recent = Array(REPORTS_PER_HOUR).fill(now - 60_000)
  assert.equal(reportCheck('chatul se blochează la pornire', recent, now), 'wait')
  assert.equal(reportCheck('chatul se blochează la pornire', recent, now + 36e5), 'ok')
})

test('the setup helper runs only on Claude and OpenCode, and is told its limits and the language', () => {
  assert.deepEqual((['claude', 'codex', 'opencode', 'hermes'] as const).filter(canHelpSetup), ['claude', 'opencode'])
  const brief = setupHelperBrief('Română')
  assert.match(brief, /Answer in Română/)
  assert.match(brief, /do not delete or move files/)
  assert.doesNotMatch(brief, /[–—]/)
})

test('an account picture is only fetched over https and never throws', async () => {
  const { fetchPicture } = await import('../src/main/backup/types')
  assert.equal(await fetchPicture('http://example.com/a.png'), undefined)
  assert.equal(await fetchPicture('file:///C:/a.png'), undefined)
  assert.equal(await fetchPicture(undefined), undefined)
})
test('Gemini models have intelligence scores', async () => {
  const { modelScore } = await import('../src/shared/scores')
  const p = { id: 'g', name: 'Gemini', engine: 'gemini', auth: 'existing', isDefaultDir: true, color: '#fff' } as never
  for (const [name, iq] of [['3.5 Flash-Lite', 22], ['3.6 Flash', 34], ['3.1 Pro', 30], ['4 Argon', 53]] as const) assert.equal(modelScore(p, { id: name, label: name })?.iq, iq, name)
})
