import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { describeWithGemini, geminiPrompt, parseGeminiAnswer, writeTempImages } from '../src/main/gemini-vision'
import type { Attachment } from '../src/shared/types'

const png = (name: string): Attachment => ({ id: name, name, mime: 'image/png', data: Buffer.from(name).toString('base64') })

test('the agent answer is read as login needed, failure, text or nothing', () => {
  assert.deepEqual(parseGeminiAnswer('  NEED_LOGIN\n'), { ok: false, needLogin: true, reason: 'not signed in to Google' })
  assert.deepEqual(parseGeminiAnswer('FAILED: no upload button'), { ok: false, needLogin: false, reason: 'no upload button' })
  assert.deepEqual(parseGeminiAnswer('FAILED:'), { ok: false, needLogin: false, reason: 'unknown' })
  assert.deepEqual(parseGeminiAnswer('A red button saying NEED_LOGIN in the middle'), { ok: true, text: 'A red button saying NEED_LOGIN in the middle' })
  assert.deepEqual(parseGeminiAnswer(' \n '), { ok: false, needLogin: false, reason: 'empty answer' })
})

test('the prompt names every file, the describe request and the two markers', () => {
  const p = geminiPrompt(['C:\t\image-1.png', 'C:\t\image-2.jpg'], 'Describe it "fully".')
  assert.match(p, /gemini\.google\.com\/app/)
  assert.ok(p.includes(JSON.stringify('C:\t\image-1.png')) && p.includes(JSON.stringify('C:\t\image-2.jpg')))
  assert.ok(p.includes(JSON.stringify('Describe it "fully".')))
  assert.match(p, /NEED_LOGIN/)
  assert.match(p, /FAILED: <short reason>/)
})

test('images go to plain file names in a temp folder', () => {
  const { dir, files } = writeTempImages([png('a b.png'), { ...png('c'), mime: 'image/jpeg' }])
  try {
    assert.deepEqual(files.map((f) => f.slice(dir.length + 1)), ['image-1.png', 'image-2.jpg'])
    assert.equal(fs.readFileSync(files[0], 'utf8'), 'a b.png')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the temp folder is deleted and the browser session released, on success and on failure', async () => {
  for (const [run, ok] of [[async () => 'The description', true], [async (): Promise<string> => { throw new Error('boom') }, false]] as const) {
    let seen: string[] = []
    let sid = ''
    const released: string[] = []
    const r = await describeWithGemini([png('x')], 'describe', async (prompt, s) => {
      sid = s
      seen = [...prompt.matchAll(/"([^"]*image-1\.png)"/g)].map((m) => JSON.parse(`"${m[1]}"`))
      assert.ok(fs.existsSync(seen[0]), 'file exists while the agent runs')
      return run()
    }, async (s) => { released.push(s) })
    assert.equal(r.ok, ok)
    assert.ok(!fs.existsSync(seen[0]) && !fs.existsSync(seen[0].replace(/[\/]image-1\.png$/, '')))
    assert.deepEqual(released, [sid])
    assert.match(sid, /^gemini-vision-/)
  }
})
