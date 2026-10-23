import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clock, etaLabel, tick, timeLeft, turnStart } from '../src/shared/eta'
import { TaskBoard } from '../src/shared/tasks'
import { pickLang, setLang, tr } from '../src/shared/i18n'
import type { PlanStep } from '../src/shared/types'

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

const steps = (done: number, total: number): PlanStep[] =>
  Array.from({ length: total }, (_, i) => ({ text: `pas ${i}`, status: i < done ? 'done' : i === done ? 'active' : 'pending' }))

test('estimates from the pace of finished steps', () => {
  let c = tick({ turn: 0 }, undefined, steps(0, 4), 1000)
  assert.equal(timeLeft(c, steps(0, 4), 5000), undefined, 'no estimate before the first step is done')
  c = tick(c, steps(0, 4), steps(1, 4), 61_000) // one step took 60 s
  assert.equal(timeLeft(c, steps(1, 4), 61_000), 180_000)
  // 30 s into the next step: 30 s less
  assert.equal(timeLeft(c, steps(1, 4), 91_000), 150_000)
  // a step running long never drops the estimate under a tenth of a step per remaining work
  assert.equal(timeLeft(c, steps(1, 4), 999_000), 180_000 - 54_000)
})

test('a new task list after a finished one restarts the clock', () => {
  let c = tick(undefined, undefined, steps(0, 2), 1)
  c = tick(c, steps(0, 2), steps(2, 2), 100_000)
  c = tick(c, steps(2, 2), steps(0, 3), 200_000)
  assert.equal(c.plan, 200_000)
  assert.equal(timeLeft(c, steps(0, 3), 210_000), undefined)
})

test('a list that arrives with steps already done does not count them', () => {
  const c = tick(undefined, undefined, steps(2, 4), 1)
  assert.equal(timeLeft(c, steps(2, 4), 10_000), undefined)
})

test('a task list left over from an earlier turn is estimated in the next turn, without the idle time', () => {
  // turn 1 at t=0 made the list and finished 1 of 4; the user came back 10 minutes later
  let c = tick({ turn: 1000 }, undefined, steps(0, 4), 1000)
  c = tick(c, steps(0, 4), steps(1, 4), 61_000)
  const later = 600_000
  c = turnStart(c, steps(1, 4), later)
  assert.equal(c.turn, later)
  assert.equal(c.plan, later, 'the plan clock restarts with the turn, so the idle minutes are not pace')
  assert.equal(timeLeft(c, steps(1, 4), later + 30_000), undefined, 'no estimate until a step is done in this turn')
  c = tick(c, steps(1, 4), steps(2, 4), later + 120_000)
  assert.equal(timeLeft(c, steps(2, 4), later + 120_000), 240_000, 'pace 2 min per step, 2 steps left')
  // no list, or a finished one: only the turn clock moves
  assert.deepEqual(turnStart(undefined, undefined, 5), { turn: 5 })
  assert.deepEqual(turnStart({ plan: 1, turn: 2 }, steps(4, 4).map((x) => ({ ...x, status: 'done' as const })), 9), { plan: 1, turn: 9 })
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

test('labels', () => {
  assert.equal(etaLabel(undefined), 'se estimează')
  assert.equal(etaLabel(30_000), 'sub 1 min rămas')
  assert.equal(etaLabel(150_000), '~3 min rămase')
  assert.equal(clock(75_000), '1:15')
  assert.equal(clock(3_725_000), '1:02:05')
})
