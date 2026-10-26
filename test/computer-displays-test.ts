// Several monitors: picture pixels map to the right place of the virtual desktop (negative origins, mixed scaling and
// sizes, stacked screens), the tools name the display, and a stale picture is refused after the layout changes.
import assert from 'node:assert/strict'
import test from 'node:test'
import { displayAt, displayLine, displayOfRect, placement, stillThere, toPhysical, toPicture, viewOf, type DisplayInfo } from '../src/main/computer/geometry'
import type { HelperState, WinInfo } from '../src/main/computer/helper'
import { ComputerService } from '../src/main/computer/service'

const d = (index: number, x: number, y: number, w: number, h: number, scaleFactor: number, primary = false): DisplayInfo => ({ index, id: 100 + index, x, y, w, h, scaleFactor, primary, name: `Mon${index}` })

const layouts: Record<string, DisplayInfo[]> = {
  // this PC: 4K at 150 % with a 1080p screen to its right
  'right of a 150 % primary': [d(0, 0, 0, 3840, 2160, 1.5, true), d(1, 3840, 0, 1920, 1080, 1)],
  // a screen left of the primary has a negative origin
  'left of a 125 % primary': [d(0, 0, 0, 2560, 1440, 1.25, true), d(1, -1920, 0, 1920, 1080, 1)],
  'vertical stack, one above and one below': [d(0, 0, 0, 1920, 1080, 1, true), d(1, 0, -1080, 1920, 1080, 1), d(2, 0, 1080, 2560, 1440, 1.5)],
  'mixed sizes and a portrait screen, offset': [d(0, 0, 0, 1920, 1080, 1, true), d(1, -1080, -420, 1080, 1920, 1.25), d(2, 1920, 300, 1280, 1024, 1)]
}

for (const [name, displays] of Object.entries(layouts)) {
  test(`${name}: every corner of a picture lands on its own display, and back`, () => {
    for (const disp of displays) {
      const v = viewOf(disp)
      assert.ok(v.width <= 1568 && v.height <= 1568)
      assert.ok(Math.abs(v.width / v.height - disp.w / disp.h) < 0.01, 'same shape as the display')
      assert.deepEqual(toPhysical(v, 0, 0), { x: disp.x, y: disp.y })
      for (const [px, py] of [[0, 0], [v.width - 1, 0], [0, v.height - 1], [v.width - 1, v.height - 1], [Math.floor(v.width / 2), Math.floor(v.height / 2)]]) {
        const p = toPhysical(v, px, py)
        assert.equal(displayAt(displays, p.x, p.y)?.id, disp.id, `(${px},${py}) of display ${disp.index} stays on it`)
        const back = toPicture(v, p.x, p.y)
        assert.ok(Math.abs(back.x - px) <= 1 && Math.abs(back.y - py) <= 1)
      }
    }
  })
}

test('a point left of or above the primary maps to negative desktop coordinates', () => {
  const left = viewOf(layouts['left of a 125 % primary'][1])
  assert.deepEqual(toPhysical(left, 0, 0), { x: -1920, y: 0 })
  assert.deepEqual(toPicture(left, -1920, 0), { x: 0, y: 0 })
  const above = viewOf(layouts['vertical stack, one above and one below'][1])
  assert.deepEqual(toPhysical(above, 0, 0), { x: 0, y: -1080 })
  const p = toPhysical(above, 100, 50)
  assert.ok(p.y < 0 && p.y >= -1080)
})

test('a 4K picture is shrunk by the view scale, so a click divides it back out', () => {
  const v = viewOf(layouts['right of a 150 % primary'][0])
  assert.ok(v.scale < 0.5)
  const p = toPhysical(v, 392, 220)
  assert.equal(p.x, Math.round(392 / v.scale))
  assert.equal(p.y, Math.round(220 / v.scale))
})

test('the display of a window is the one that holds most of it', () => {
  const [a, b] = layouts['left of a 125 % primary']
  assert.equal(displayOfRect([a, b], { x: -1500, y: 100, w: 1000, h: 500 })?.id, b.id)
  assert.equal(displayOfRect([a, b], { x: -300, y: 100, w: 1000, h: 500 })?.id, a.id, 'straddling: the larger part wins')
  assert.equal(displayOfRect([a, b], { x: 9000, y: 0, w: 100, h: 100 }), undefined)
})

test('placement and the display lines say where each screen is', () => {
  const l = layouts['vertical stack, one above and one below']
  assert.equal(placement(l[0], l), 'primary')
  assert.equal(placement(l[1], l), 'above the primary')
  assert.equal(placement(l[2], l), 'below the primary')
  const r = layouts['left of a 125 % primary']
  assert.equal(placement(r[1], r), 'left of the primary')
  assert.equal(displayLine(r[1], r), 'display 1 "Mon1" (left of the primary): 1920x1080 physical px at (-1920, 0), scaling 100%')
  assert.match(displayLine(r[0], r), /scaling 125%/)
})

// ---------------------------------------------------------------- the service and the tools
function rig(displays: DisplayInfo[], wins: WinInfo[] = []) {
  const shots: number[] = []
  const state = (): HelperState => ({ x: 10, y: 10, foreground: wins[0] ?? null, secure: false, idleMs: 99999, virtual: { x: -1920, y: 0, w: 4480, h: 1440 } }) as never
  const svc = new ComputerService({
    input: { state: async () => state(), windows: async () => wins } as never,
    capturer: {
      displays: () => displays,
      grab: async (disp: DisplayInfo) => (shots.push(disp.index), { jpeg: Buffer.from('x'), view: viewOf(disp) })
    },
    overlay: { active() {}, say() {}, pulse() {}, paused() {}, idle() {}, destroy() {} },
    host: { enabled: () => true, mode: () => 'auto', settings: () => ({ human: 'fast', paste: false, trusted: [] }) } as never
  })
  return { svc, shots, displays }
}
const win = (hwnd: number, x: number, y: number, w: number, h: number): WinInfo => ({ hwnd, title: `W${hwnd}`, cls: '', pid: 5, exe: 'app.exe', path: 'C:\\app.exe', x, y, w, h, minimized: false, maximized: false, focused: hwnd === 1, z: hwnd })
const say = (r: { content: { type: string; text?: string }[] }): string => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

test('computer_displays lists every monitor with its place, size, origin and scaling', async () => {
  const { svc } = rig(layouts['left of a 125 % primary'])
  const out = say(await svc.call('a', 'computer_displays', {}))
  assert.match(out, /2 displays/)
  assert.match(out, /display 0 "Mon0" \(primary\).*2560x1440.*scaling 125%.*pointer here/)
  assert.match(out, /display 1 "Mon1" \(left of the primary\).*at \(-1920, 0\)/)
})

test('a screenshot defaults to the primary display, takes display=N, and rejects one that does not exist', async () => {
  const { svc, shots } = rig(layouts['left of a 125 % primary'])
  await svc.call('a', 'computer_screenshot', {})
  await svc.call('a', 'computer_screenshot', { display: 1 })
  assert.deepEqual(shots, [0, 1])
  const bad = await svc.call('a', 'computer_screenshot', { display: 2 })
  assert.equal(bad.isError, true)
  assert.deepEqual(shots, [0, 1])
})

test('after a screenshot of the left display, picture pixels go to negative desktop coordinates', async () => {
  const { svc } = rig(layouts['left of a 125 % primary'])
  const s = svc.session('a')
  await svc.call('a', 'computer_screenshot', { display: 1 })
  assert.deepEqual(svc.physical(s, 0, 0), { x: -1920, y: 0 })
  const v = svc.needView(s)
  assert.deepEqual(svc.physical(s, v.width - 1, v.height - 1), toPhysical(v, v.width - 1, v.height - 1))
  assert.throws(() => svc.physical(s, v.width, 0), /outside the latest screenshot/)
})

test('computer_windows names the display of each window and positions only the one in the screenshot', async () => {
  const { svc } = rig(layouts['left of a 125 % primary'], [win(1, 100, 100, 800, 600), win(2, -1800, 50, 900, 700)])
  await svc.call('a', 'computer_screenshot', {})
  const out = say(await svc.call('a', 'computer_windows', {}))
  assert.match(out, /id 1: .*display 0, at \(/)
  assert.match(out, /id 2: .*display 1, not in the latest screenshot/)
})

test('a picture of a display that was unplugged or moved is refused', async () => {
  const { svc, displays } = rig(layouts['left of a 125 % primary'].slice())
  const s = svc.session('a')
  await svc.call('a', 'computer_screenshot', { display: 1 })
  assert.ok(svc.needView(s))
  assert.equal(stillThere(displays, displays[1]), true)
  displays.splice(1, 1)
  assert.throws(() => svc.needView(s), /monitor layout changed/)
  assert.throws(() => svc.physical(s, 5, 5), /monitor layout changed/)
  const click = await svc.call('a', 'computer_click', { x: 5, y: 5 })
  assert.equal(click.isError, true)
})
