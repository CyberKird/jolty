import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { drop, rewind, snapshot } from '../src/main/checkpoints'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-cp-'))
const data = path.join(tmp, 'data')
const proj = path.join(tmp, 'proj')
fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
fs.mkdirSync(path.join(proj, 'node_modules'), { recursive: true })
const w = (f: string, t: string): void => fs.writeFileSync(path.join(proj, f), t)
const r = (f: string): string => fs.readFileSync(path.join(proj, f), 'utf8')

test('undo brings back edited and deleted files and removes new ones, per message', async () => {
  w('a.txt', 'one\ntwo\n')
  w('src/b.txt', 'keep\n')
  w('node_modules/x.js', 'skipped\n')
  await snapshot(data, 's1', proj, 'm1')
  // the first message's turn changes things
  w('a.txt', 'one\nTWO\nthree\n')
  fs.rmSync(path.join(proj, 'src', 'b.txt'))
  w('new.txt', 'made by the model\n')
  w('node_modules/x.js', 'changed, never tracked\n')
  await snapshot(data, 's1', proj, 'm2')
  w('a.txt', 'second turn\n')

  const toM2 = await rewind(data, 's1', proj, 'm2', false)
  assert.deepEqual(toM2.files, ['a.txt'])
  assert.equal(r('a.txt'), 'second turn\n')

  const preview = await rewind(data, 's1', proj, 'm1', false)
  assert.deepEqual([...preview.files].sort(), ['a.txt', 'new.txt', 'src/b.txt'])
  assert.equal(r('a.txt'), 'second turn\n', 'a preview changes nothing')

  const done = await rewind(data, 's1', proj, 'm1', true)
  assert.equal(done.files.length, 3)
  assert.equal(r('a.txt'), 'one\ntwo\n')
  assert.equal(r('src/b.txt'), 'keep\n')
  assert.equal(fs.existsSync(path.join(proj, 'new.txt')), false)
  assert.equal(r('node_modules/x.js'), 'changed, never tracked\n')
  assert.equal((await rewind(data, 's1', proj, 'm1', false)).files.length, 0)
})

test('a message without a copy and a chat without copies say so', async () => {
  await assert.rejects(rewind(data, 's1', proj, 'nope', false))
  await assert.rejects(rewind(data, 'other', proj, 'm1', false))
})

test('the home folder and a drive root are not copied', async () => {
  await snapshot(data, 'wide', os.homedir(), 'm1')
  assert.equal(fs.existsSync(path.join(data, 'checkpoints', 'wide.git')), false)
})

test('dropping a chat removes its copies', () => {
  drop(data, 's1')
  assert.equal(fs.existsSync(path.join(data, 'checkpoints', 's1.git')), false)
  fs.rmSync(tmp, { recursive: true, force: true })
})
