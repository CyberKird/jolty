// Conversation digest (what was asked, how it ended) and reading from the end of a chat.
import assert from 'node:assert/strict'
import test from 'node:test'
import { digestOf, pageOf, type Turn } from '../src/main/recall'

const u = (text: string): Turn => ({ role: 'user', text })
const a = (text: string): Turn => ({ role: 'assistant', text })

test('digest: first ask, and the last answer that says something', () => {
  const d = digestOf([u('Fă un site pentru **Kingtex**'), a('Încep.'), u('și mobilul'), a('## Gata\nAm terminat site-ul și mobilul, build verde, 14 teste trec. Rămâne deploy-ul, pe care îl face userul.'), u('mulțumesc'), a('Cu plăcere.')])
  assert.equal(d.ask, 'Fă un site pentru Kingtex')
  // "Cu plăcere." is too short to tell anything: the answer before it is the end
  assert.match(d.end, /^Gata Am terminat site-ul și mobilul, build verde/)
  assert.doesNotMatch(d.end, /\*\*|#/)
})

test('digest: long text is cut at a word with an ellipsis, never mid word', () => {
  const long = Array.from({ length: 200 }, (_, i) => `cuvânt${i}`).join(' ')
  const d = digestOf([u(long), a(long)])
  assert.ok(d.ask.length <= 223 && d.ask.endsWith('...'))
  assert.ok(d.end.length <= 423 && d.end.endsWith('...'))
  assert.doesNotMatch(d.ask, /cuvânt\d* \.\.\.$/)
  assert.match(d.ask.replace(/\.\.\.$/, ''), /cuvânt\d+$/)
})

test('digest: a chat that ends on the user, or has no answer at all, has no end', () => {
  assert.equal(digestOf([u('întrebare'), a('răspuns lung care spune destul de multe lucruri utile pentru cineva'), u('încă una')]).end, '')
  assert.deepEqual(digestOf([u('doar eu')]), { ask: 'doar eu', end: '' })
  assert.deepEqual(digestOf([]), { ask: '', end: '' })
})

test('digest: a plan-limit notice is not the ask and not the end', () => {
  const d = digestOf([u("You've hit your session limit · resets 8:20pm (Europe/Berlin) Continua."), u('Repară scroll-ul pe iPhone'), a('Am pus width și height pe imagini, iar scroll-ul nu mai sare la încărcare.'), a("You've hit your weekly limit · resets Sep 30, 8pm")])
  assert.equal(d.ask, 'Repară scroll-ul pe iPhone')
  assert.match(d.end, /^Am pus width și height/)
})

test('digest: when every answer is short, the last one is still the end', () => {
  assert.equal(digestOf([u('x'), a('Ok'), u('y'), a('Gata')]).end, 'Gata')
})

test('pageOf: negative offset reads from the end, positive still pages forward', () => {
  const turns = [u('a'.repeat(30000)), a('sfârșit: ' + 'b'.repeat(100))]
  const whole = pageOf(turns, 0)
  assert.equal(whole.next, 20000)
  const last = pageOf(turns, -2000)
  assert.equal(last.text.length, 2000)
  assert.ok(last.text.endsWith('b'.repeat(100)))
  assert.equal(last.next, undefined)
  // asking for more than exists from the end is the whole chat, from the start
  assert.equal(pageOf(turns, -999999).text.length, 20000)
  assert.equal(pageOf(turns, -999999).next, 20000)
  // forward paging from the previous `next` is unchanged
  assert.equal(pageOf(turns, whole.next).text.length, whole.total - 20000)
})
