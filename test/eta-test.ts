import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clock } from '../src/shared/eta'
import { TaskBoard } from '../src/shared/tasks'
import { pickLang, setLang, tr } from '../src/shared/i18n'

test('translations: the chosen language, the Romanian original, placeholders, system fallback', () => {
  setLang('de')
  assert.equal(tr('Setări'), 'Einstellungen')
  assert.equal(tr('Continuă în {name}', { name: 'Codex' }), 'Fortsetzen in Codex')
  assert.equal(tr('un text care nu e în dicționar'), 'un text care nu e în dicționar')
  assert.equal(pickLang(undefined, 'pt-BR'), 'pt-BR')
  assert.equal(pickLang(undefined, 'fr-CA'), 'fr')
  assert.equal(pickLang(undefined, 'sv-SE'), 'en')
  assert.equal(pickLang('ro', 'ja-JP'), 'ro')
  // the remaining tests read the Romanian labels
  setLang('ro')
})

test('the task list is rebuilt from a saved conversation, and goes on from there', () => {
  const tool = (name: string, input: unknown, output = '', status: 'done' | 'error' = 'done') => ({ kind: 'tool' as const, id: name + Math.random(), name, title: name, status, input, output })
  const saved = [
    tool('TaskCreate', { subject: 'Scriu testele' }, 'Task #1 created successfully: Scriu testele'),
    tool('TaskCreate', { subject: 'Rulez build-ul', activeForm: 'Rulez build-ul acum' }, 'Task #2 created successfully: Rulez build-ul'),
    tool('TaskCreate', { subject: 'esuat' }, 'boom', 'error'),
    tool('TaskUpdate', { taskId: '1', status: 'completed' }),
    tool('TaskUpdate', { taskId: '2', status: 'in_progress' })
  ]
  const board = new TaskBoard().replay(saved)
  assert.deepEqual(board.steps(), [{ text: 'Scriu testele', status: 'done' }, { text: 'Rulez build-ul acum', status: 'active' }])
  // a TaskUpdate of the resumed chat finds the tasks made before the restart
  board.updated({ taskId: '2', status: 'completed' })
  assert.deepEqual(board.steps().map((x) => x.status), ['done', 'done'])
  // the older TodoWrite carries the whole list each time: the last one wins
  const todos = new TaskBoard().replay([tool('TodoWrite', { todos: [{ content: 'A', status: 'completed' }] }), tool('TodoWrite', { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }] })])
  assert.equal(todos.steps().length, 2)
  assert.deepEqual(new TaskBoard().replay([]).steps(), [])
})

test('elapsed clock', () => {
  assert.equal(clock(75_000), '1:15')
  assert.equal(clock(3_725_000), '1:02:05')
})
