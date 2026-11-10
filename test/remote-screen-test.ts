import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DisplayInfo } from '../src/main/computer/geometry'
import type { Ev } from '../src/main/computer/plan'
import { RemoteScreen, type ScreenClient, type ScreenSource } from '../src/main/remote-screen'

// the phone's screen: who may look, what is sent, how touches become input, and that everything lets go when it ends
const displays: DisplayInfo[] = [
  { index: 0, id: 1, x: 0, y: 0, w: 2560, h: 1440, primary: true, scaleFactor: 1 },
  { index: 1, id: 2, x: 2560, y: 0, w: 1920, h: 1080, primary: false, scaleFactor: 1 }
]
const source: ScreenSource = {
  displays: () => displays,
  cursor: () => ({ x: 1280, y: 720 }),
  frame: async (d, edge) => ({ jpeg: Buffer.from(`frame-${d.index}-${edge}`), width: 100, height: 50 })
}

type Phone = ScreenClient & { json: Array<Record<string, unknown>>; bin: Buffer[] }

function phone(id: string): Phone {
  const json: Array<Record<string, unknown>> = []
  const bin: Buffer[] = []
  return { id, json, bin, send: (m) => json.push(m as Record<string, unknown>), sendBinary: (b) => bin.push(b), backlog: () => 0 }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (f: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !f(); i++) await wait(20)
  assert.ok(f(), 'timed out')
}
const lastInfo = (p: Phone): { display: number } => p.json.filter((j) => j.op === 'info').at(-1) as { display: number }

function make(allowed = true) {
  const played: Ev[][] = []
  const state = { allowed, changes: 0 }
  const screen = new RemoteScreen(source, async () => ({ play: async (e) => void played.push(e) }), () => state.allowed, () => state.changes++)
  return { screen, played, state }
}

test('refused while the PC has not allowed it', () => {
  const { screen } = make(false)
  const p = phone('a')
  screen.handle(p, { t: 'screen', op: 'start' })
  assert.deepEqual(p.json[0], { t: 'screen', op: 'denied', reason: 'off' })
  assert.equal(screen.viewing(), 0)
})

test('start tells the displays, then sends frames with the cursor, and waits for the phone to take each', async () => {
  const { screen } = make()
  const p = phone('a')
  screen.handle(p, { t: 'screen', op: 'start' })
  const info = p.json[0] as { display: number; width: number; displays: unknown[] }
  assert.equal(info.display, 0)
  assert.equal(info.width, 2560)
  assert.equal(info.displays.length, 2)
  await until(() => p.bin.length === 1)
  assert.equal(p.bin[0].readUInt16LE(0), Math.round(0.5 * 65534), 'cursor x in the header')
  assert.match(p.bin[0].subarray(4).toString(), /^frame-0-/)
  await wait(150)
  assert.equal(p.bin.length, 1, 'no second picture before the phone answers, and it did not change anyway')
  screen.handle(p, { t: 'screen', op: 'ack' })
  screen.stopAll()
})

test('switching display sends that display, and a display that does not exist is ignored', async () => {
  const { screen } = make()
  const p = phone('a')
  screen.handle(p, { t: 'screen', op: 'start' })
  await until(() => p.bin.length === 1)
  screen.handle(p, { t: 'screen', op: 'display', index: 1 })
  assert.equal(lastInfo(p).display, 1)
  await until(() => p.bin.length === 2)
  assert.match(p.bin[1].subarray(4).toString(), /^frame-1-/)
  screen.handle(p, { t: 'screen', op: 'display', index: 9 })
  assert.equal(lastInfo(p).display, 1)
  screen.stopAll()
})

test('touches become input at the right place of the right display', async () => {
  const { screen, played } = make()
  const p = phone('a')
  screen.handle(p, { t: 'screen', op: 'start', display: 1 })
  screen.handle(p, { t: 'screen', op: 'click', x: 0.5, y: 0.5, button: 'l', count: 2 })
  await until(() => played.length === 1)
  assert.deepEqual(played[0][0], ['m', 0, 2560 + Math.round(0.5 * 1919), Math.round(0.5 * 1079)])
  assert.equal(played[0].filter((e) => e[0] === 'b').length, 4, 'two clicks, press and release each')
  screen.handle(p, { t: 'screen', op: 'wheel', notches: 3 })
  await until(() => played.length === 2)
  assert.equal(played[1].length, 3)
  assert.equal(played[1][0][2], -120, 'down on the phone is a wheel turn towards the user')
  screen.handle(p, { t: 'screen', op: 'text', text: 'ab\n' })
  await until(() => played.length === 3)
  assert.deepEqual(played[2].map((e) => e[0]), ['c', 'c', 'k', 'k'])
  screen.handle(p, { t: 'screen', op: 'key', combo: 'ctrl+shift+t' })
  await until(() => played.length === 4)
  assert.deepEqual(played[3].filter((e) => e[0] === 'k' && e[3] === 1).map((e) => e[2]), [0x11, 0x10, 0x54])
  screen.handle(p, { t: 'screen', op: 'key', combo: 'nonsense+key' })
  screen.handle(p, { t: 'screen', op: 'click', x: 5, y: -2 })
  await until(() => played.length === 5)
  assert.deepEqual(played[4][0], ['m', 0, 2560 + 1919, 0], 'coordinates are clamped to the display')
  screen.stopAll()
})

test('moves are merged while the helper is busy: only the newest runs', async () => {
  const played: Ev[][] = []
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  const screen = new RemoteScreen(source, async () => ({ play: async (e) => (played.push(e), played.length === 1 ? gate : undefined) }), () => true)
  const p = phone('a')
  screen.handle(p, { t: 'screen', op: 'start' })
  screen.handle(p, { t: 'screen', op: 'move', x: 0.1, y: 0.1 })
  await until(() => played.length === 1)
  for (let i = 2; i <= 9; i++) screen.handle(p, { t: 'screen', op: 'move', x: i / 10, y: 0.5 })
  release()
  await wait(100)
  assert.equal(played.length, 2, 'one move for the whole burst')
  assert.equal(played[1][0][2], Math.round(0.9 * 2559))
  screen.stopAll()
})

test('the last phone leaving lets go of buttons and modifiers; the kill key ends it for everyone', async () => {
  const { screen, played, state } = make()
  const a = phone('a')
  const b = phone('b')
  screen.handle(a, { t: 'screen', op: 'start' })
  screen.handle(b, { t: 'screen', op: 'start' })
  screen.handle(a, { t: 'screen', op: 'down', x: 0.2, y: 0.2 })
  await until(() => played.length === 1)
  screen.drop(a)
  assert.equal(screen.viewing(), 1)
  assert.equal(played.length, 1, 'still held for the other phone')
  screen.stopAll('stopped')
  assert.deepEqual(b.json.at(-1), { t: 'screen', op: 'ended', reason: 'stopped' })
  await until(() => played.length === 2)
  assert.ok(played[1].some((e) => e[0] === 'b' && e[2] === 'l' && e[3] === 0), 'the left button is let go')
  assert.ok(state.changes >= 3, 'the PC window is told each time')
  assert.equal(screen.viewing(), 0)
})

test('switching the setting off at the PC ends an open view at the next message', () => {
  const { screen, state } = make()
  const p = phone('a')
  screen.handle(p, { t: 'screen', op: 'start' })
  state.allowed = false
  screen.handle(p, { t: 'screen', op: 'click', x: 0.5, y: 0.5 })
  assert.deepEqual(p.json.at(-1), { t: 'screen', op: 'ended', reason: 'off' })
  assert.equal(screen.viewing(), 0)
})
