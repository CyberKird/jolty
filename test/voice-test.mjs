// Dictation end to end: Chromium's fake microphone plays a WAV, the composer's mic button records it, whisper
// transcribes it and the words land in the composer. Local only (needs the model and a GPU or patience):
//   VOICE_MODEL=path/to/ggml-large-v3-turbo-q5_0.bin VOICE_WAV=speech.wav VOICE_EXPECT=word node test/voice-test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const { VOICE_MODEL: model, VOICE_WAV: wav, VOICE_EXPECT: expect } = process.env
assert.ok(model && wav && expect, 'set VOICE_MODEL, VOICE_WAV and VOICE_EXPECT')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-voice-'))
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-voice-project-'))
fs.mkdirSync(path.join(data, 'models'))
fs.copyFileSync(model, path.join(data, 'models', 'ggml-large-v3-turbo-q5_0.bin'))
fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify([{ id: 'mock', name: 'Mock', engine: 'claude', auth: 'endpoint', isDefaultDir: true, baseUrl: 'http://127.0.0.1:8766', models: ['mock-model'], vision: false, color: '#e0a23b' }]))
fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ mock: { enc: false, value: 'sk-mock' } }))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ lastCwd: project, lastProfileId: 'mock', mascot: false }))

const app = await electron.launch({
  executablePath: path.resolve('node_modules/.bin/electron'),
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve(wav)}`, path.resolve('out/main/index.js')],
  env: { ...process.env, JOLTY_DATA_DIR: data, JOLTY_TEST: '1' }
})
try {
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 860 })
  const mic = win.locator('.composer .btn.voice')
  await mic.click()
  await win.waitForSelector('.composer .btn.voice.rec', { timeout: 10000 })
  const seconds = Number(process.env.VOICE_SECONDS || 6)
  await win.waitForTimeout(seconds * 1000)
  const t0 = Date.now()
  await mic.click()
  await win.waitForFunction(() => (document.querySelector('.composer textarea')?.value || '').length > 3, null, { timeout: 60000 })
  const text = await win.locator('.composer textarea').inputValue()
  console.log(`transcribed in ${Date.now() - t0} ms: ${text}`)
  assert.ok(text.toLowerCase().includes(expect.toLowerCase()), `expected "${expect}" in the text`)
  console.log('ok')
} finally {
  await app.close()
  fs.rmSync(data, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
}
