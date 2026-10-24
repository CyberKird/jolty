// A plan that stops halfway (stop button) must not leave a key held down: a stuck Windows key turns every
// key the user presses next into a Windows shortcut (show desktop, minimize all). Runs the real helper with F24,
// a key nothing listens to, and reads its state back from Windows.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { compileHelper } from '../src/main/computer/helper'

const F24 = 0x87
const STATE = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);' -Name K -Namespace W; [W.K]::GetAsyncKeyState(${F24}) -band 0x8000`
const isDown = (): boolean => Number(execFileSync('powershell', ['-NoProfile', '-Command', STATE], { encoding: 'utf8' }).trim()) !== 0

test('a stopped plan releases the keys it pressed', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-helper-'))
  const child = spawn(await compileHelper(dir), [], { stdio: ['pipe', 'pipe', 'ignore'] })
  const answers: string[] = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => answers.push(d))
  const send = (m: object): void => void child.stdin.write(JSON.stringify(m) + '\n')
  const answered = async (id: number): Promise<void> => {
    for (let i = 0; i < 100 && !answers.join('').includes(`"id":${id},`); i++) await new Promise((r) => setTimeout(r, 50))
  }
  try {
    send({ id: 1, cmd: 'hello' })
    await answered(1)
    // F24 goes down, would come up after 3 s, and the plan is stopped after 400 ms
    send({ id: 2, cmd: 'play', events: [['k', 0, F24, 1, 0], ['k', 3000, F24, 0, 0]], allowUser: true })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(isDown(), true, 'the key is held while the plan runs')
    send({ id: 3, cmd: 'abort' })
    await answered(2)
    assert.match(answers.join(''), /"reason":"abort"/)
    assert.equal(isDown(), false, 'the key is released when the plan stops early')
  } finally {
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.kill()
    })
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
