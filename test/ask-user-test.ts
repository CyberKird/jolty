import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askRule, cleanAnswers, DISMISSED, formatAnswers, parseQuestions } from '../src/main/ask-user'
import { bindJoltyTools, handleJoltyTools, type ToolHost } from '../src/main/jolty-tools'
import type { AskQuestion, SessionMeta } from '../src/shared/types'

const color = { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }] }

test('questions are cleaned: too few options, empty text and duplicates are dropped, limits are kept', () => {
  const qs = parseQuestions({
    questions: [color, { question: 'Only one?', options: [{ label: 'A' }] }, { question: '', options: ['a', 'b'] }, color, { question: 'Strings?', options: ['x', 'y'], multiSelect: true }]
  })
  assert.equal(qs?.length, 2)
  assert.deepEqual(qs?.[0], { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: undefined }], multiSelect: false })
  assert.deepEqual(qs?.[1].options.map((o) => o.label), ['x', 'y'])
  assert.equal(qs?.[1].multiSelect, true)
  assert.equal(parseQuestions({ questions: 'nope' }), undefined)
  assert.equal(parseQuestions({ questions: Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, options: ['a', 'b'] })) })?.length, 4)
})

test('answers keep only the questions that were asked, and the tool result reads well', () => {
  const qs = parseQuestions({ questions: [color] }) as AskQuestion[]
  assert.deepEqual(cleanAnswers(qs, { 'Which color?': ' Blue ', 'Injected?': 'x' }), { 'Which color?': 'Blue' })
  assert.equal(cleanAnswers(qs, { 'Which color?': '' }), undefined)
  assert.equal(cleanAnswers(qs, null), undefined)
  assert.equal(formatAnswers(qs, { 'Which color?': 'Blue' }), 'Which color?\nAnswer: Blue')
  assert.equal(formatAnswers(qs, undefined), DISMISSED)
  assert.match(askRule('ask_user'), /ask_user tool/)
})

test('ask_user is offered to Codex and the like, not to Claude or to sessions nobody watches', async () => {
  const metas: Record<string, Partial<SessionMeta>> = { codex: { engine: 'codex' }, claude: { engine: 'claude' }, job: { engine: 'codex', parentId: 'lead' }, cron: { engine: 'opencode', scheduled: true } }
  const asked: AskQuestion[][] = []
  bindJoltyTools({
    meta: (id: string) => metas[id] as SessionMeta,
    askUser: async (_sid: string, qs: AskQuestion[]) => (asked.push(qs), { [qs[0].question]: 'Red' })
  } as unknown as ToolHost)
  const names = async (sid: string): Promise<string[]> => {
    const r = (await handleJoltyTools(sid, { jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string }[] } }
    return r.result.tools.map((t) => t.name)
  }
  assert.ok((await names('codex')).includes('ask_user'))
  assert.ok(!(await names('claude')).includes('ask_user'))
  assert.ok(!(await names('job')).includes('ask_user'))
  assert.ok(!(await names('cron')).includes('ask_user'))
  const call = async (sid: string): Promise<{ content: { text: string }[]; isError?: boolean }> =>
    ((await handleJoltyTools(sid, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_user', arguments: { questions: [color] } } })) as { result: { content: { text: string }[]; isError?: boolean } }).result
  assert.equal((await call('codex')).content[0].text, 'Which color?\nAnswer: Red')
  assert.equal((await call('cron')).isError, true)
  assert.equal(asked.length, 1)
})
