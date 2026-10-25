import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanImproved, clipForContext, improvePrompt, improveQuestion, IMPROVE_MAX } from '../src/shared/improve-prompt'

const original = 'fa butonul din src/App.tsx sa fie albastru si verifica @src/theme.ts'

test('improve prompt: the reply is cleaned of quotes, fences and lead-ins', () => {
  const good = 'Schimbă culoarea butonului din src/App.tsx în albastru și verifică @src/theme.ts.'
  assert.equal(cleanImproved(original, good), good)
  assert.equal(cleanImproved(original, `"${good}"`), good)
  assert.equal(cleanImproved(original, `„${good}”`), good)
  assert.equal(cleanImproved(original, '```\n' + good + '\n```'), good)
  assert.equal(cleanImproved(original, `Here is the improved prompt:\n\n${good}`), good)
  assert.equal(cleanImproved(original, `  ${good}\n`), good)
})

test('improve prompt: quotes the user wrote themselves stay', () => {
  const quoted = '"hello world, this is the whole message"'
  assert.equal(cleanImproved(quoted, quoted), quoted)
})

test('improve prompt: an empty or much shorter reply is refused', () => {
  assert.equal(cleanImproved(original, ''), undefined)
  assert.equal(cleanImproved(original, '  \n '), undefined)
  assert.equal(cleanImproved(original, '""'), undefined)
  assert.equal(cleanImproved(original, 'Ok.'), undefined)
  // a short message may legitimately stay short
  assert.equal(cleanImproved('fix bug', 'Fix the bug.'), 'Fix the bug.')
})

test('improve prompt: the instruction carries the text, capped', () => {
  assert.ok(improvePrompt(original).endsWith(original))
  assert.ok(improvePrompt('x'.repeat(IMPROVE_MAX + 500)).length < IMPROVE_MAX + 2500)
})

test('improve prompt: no kind of project is assumed, the context comes only from what is given', () => {
  const bare = improvePrompt('scrie un email catre furnizor')
  assert.ok(!/web ?site|landing|folder/i.test(bare))
  assert.ok(!bare.includes('Context'))
  const ctx = improvePrompt('continua', { recent: ['facem raportul lunar de vanzari'], titles: ['Raport vanzari octombrie'] })
  assert.ok(ctx.includes('- facem raportul lunar de vanzari') && ctx.includes('- Raport vanzari octombrie'))
  assert.ok(ctx.indexOf('Context') < ctx.indexOf('Message:'))
})

test('improve prompt: the context is clipped to what identifies the subject', () => {
  assert.equal(clipForContext('a  b\n c'), 'a b c')
  assert.equal(clipForContext('x'.repeat(500)).length, 301)
})

test('improve prompt: a question from the model is told apart from a rewrite', () => {
  assert.equal(improveQuestion('QUESTION: Despre ce proiect e vorba?'), 'Despre ce proiect e vorba?')
  assert.equal(improveQuestion('  QUESTION: Which file?\n'), 'Which file?')
  assert.equal(improveQuestion('Fix the bug in src/a.ts.\nQUESTION: not at the start'), undefined)
  assert.equal(improveQuestion('QUESTION: first\nthen a long rewrite'), undefined)
})
