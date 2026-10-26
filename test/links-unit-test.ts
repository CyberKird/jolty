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

test('the leaderboard page becomes score entries that match ids however they are spelled', async () => {
  const { parseModels, buildEntries } = await import('../scripts/scores-lib.mjs')
  const { modelScore, parseRemoteScores, setRemoteScores } = await import('../src/shared/scores')
  const row = (slug: string, name: string, iq: number, tps: number, extra = '') => `{\\"slug\\":\\"${slug}\\",\\"name\\":\\"${name}\\",\\"deprecated\\":false${extra},\\"intelligenceIndex\\":${iq},\\"medianOutputTokensPerSecond\\":${tps}}`
  const html = [
    row('gpt-6-1-sol', 'GPT-6.1 Sol (Max)', 52.4, 63), row('gpt-6-1-sol-high', 'GPT-6.1 Sol (High)', 50.1, 57), row('gpt-6-1-sol-low', 'GPT-6.1 Sol (Low)', 42, 50),
    row('gemini-3-6-flash', 'Gemini 3.6 Flash (High)', 34.2, 194), row('claude-opus-5-5', 'Claude Opus 5.5 (Max)', 58, 97),
    row('claude-opus-4-1', 'Claude Opus 4.1', 30, 40), row('old-model', 'Old', 10, 10).replace('false', 'true'),
    '{\\"slug\\":\\"gpt-6-1-sol\\",\\"name\\":\\"no index here\\"}'
  ].join(',')
  const models = parseModels(html)
  assert.deepEqual(models.map((m: { slug: string }) => m.slug).sort(), ['claude-opus-4-1', 'claude-opus-5-5', 'gemini-3-6-flash', 'gpt-6-1-sol', 'gpt-6-1-sol-high', 'gpt-6-1-sol-low'])
  const entries = buildEntries(models)
  const sol = entries.find((e: { match: string[] }) => e.match[0] === 'gpt-6-1-sol')
  assert.equal(sol.iq, 50, 'the high row is the headline')
  assert.match(sol.note, /low 42/)
  assert.ok(entries.length < 600 && JSON.stringify(entries).length < 100_000)
  const parsed = parseRemoteScores({ entries })
  assert.equal(parsed?.length, entries.length, 'the app accepts every entry')
  setRemoteScores(parsed ?? [])
  try {
    const p = { id: 'x', name: 'x', engine: 'codex', auth: 'existing', isDefaultDir: true, color: '#fff' } as never
    assert.equal(modelScore(p, { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' })?.iq, 50, 'dots, dashes and spaces are the same name')
    assert.equal(modelScore(p, { id: '3.6 Flash', label: '3.6 Flash' })?.iq, 34, 'a Gemini menu label without the brand')
    assert.equal(modelScore(p, { id: 'opus', label: 'Opus' })?.iq, 58, 'the short name is the newest of its line')
  } finally {
    setRemoteScores([])
  }
})

test('the committed scores.json is a table the app accepts whole', async () => {
  const { parseRemoteScores } = await import('../src/shared/scores')
  const { readFileSync } = await import('node:fs')
  const raw = JSON.parse(readFileSync('scores.json', 'utf8'))
  assert.equal(parseRemoteScores(raw)?.length, raw.entries.length)
})
