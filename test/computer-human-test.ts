// The human models are pure: with a seeded RNG every run gives the same path and the same typing rhythm.
import assert from 'node:assert/strict'
import test from 'node:test'
import { clickOffset, fittsMs, makeRng, mousePath, neighbours, typeSteps, type Humanness } from '../src/main/computer/human'
import { appKey, classify, reachesPastApp, secretField } from '../src/main/computer/policy'
import { chordPlan, clickPlan, driftPlan, dragPlan, movePlan, parseCombo, planEnd, scrollPlan, simulateTyping, typePlan } from '../src/main/computer/plan'

const modes: Humanness[] = ['max', 'normal', 'fast']

test('a path starts and ends exactly on the points, in time order', () => {
  for (const mode of modes) {
    for (let seed = 1; seed <= 60; seed++) {
      const r = makeRng(seed)
      const from = { x: Math.round(r() * 3000), y: Math.round(r() * 1600) }
      const to = { x: Math.round(r() * 3000), y: Math.round(r() * 1600) }
      const p = mousePath(from, to, { mode, rng: makeRng(seed + 1000) })
      assert.deepEqual([p[0].x, p[0].y, p[0].t], [from.x, from.y, 0])
      if (from.x !== to.x || from.y !== to.y) assert.deepEqual([p[p.length - 1].x, p[p.length - 1].y], [to.x, to.y])
      for (let i = 1; i < p.length; i++) assert.ok(p[i].t > p[i - 1].t, `monotonic at ${i} (${mode}, seed ${seed})`)
    }
  }
})

test('a path is the same for the same seed and differs between seeds', () => {
  const a = mousePath({ x: 10, y: 10 }, { x: 900, y: 500 }, { mode: 'max', rng: makeRng(5) })
  const b = mousePath({ x: 10, y: 10 }, { x: 900, y: 500 }, { mode: 'max', rng: makeRng(5) })
  const c = mousePath({ x: 10, y: 10 }, { x: 900, y: 500 }, { mode: 'max', rng: makeRng(6) })
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c)
})

test('speed and acceleration stay bounded, and the move is not a straight line at constant speed', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const from = { x: 100, y: 100 }
    const to = { x: 1700, y: 900 }
    const d = Math.hypot(1600, 800)
    const p = mousePath(from, to, { mode: 'max', rng: makeRng(seed) })
    const total = p[p.length - 1].t
    // speeds over windows of 5 samples, so pixel rounding does not count as acceleration
    const v: number[] = []
    for (let i = 5; i < p.length; i += 5) v.push(Math.hypot(p[i].x - p[i - 5].x, p[i].y - p[i - 5].y) / (p[i].t - p[i - 5].t))
    assert.ok(Math.max(...v) < (3.2 * d) / total, `peak ${Math.max(...v)} vs ${(3.2 * d) / total}`)
    // the pointer starts and ends slowly and is fastest in between
    assert.ok(v[0] < Math.max(...v) * 0.4)
    assert.ok(v[v.length - 1] < Math.max(...v) * 0.4)
    for (let i = 1; i < v.length; i++) assert.ok(Math.abs(v[i] - v[i - 1]) < 3 * (d / total) * 0.6 + 0.3, 'bounded acceleration')
    // curved: some sample is more than 2 px off the straight line
    const off = Math.max(...p.map((q) => Math.abs((to.x - from.x) * (from.y - q.y) - (from.x - q.x) * (to.y - from.y)) / d))
    assert.ok(off > 2, `curved (${off})`)
  }
})

test('sampling is about 125 Hz and the time follows Fitts law', () => {
  const p = mousePath({ x: 0, y: 0 }, { x: 1200, y: 0 }, { mode: 'max', rng: makeRng(9) })
  const dts = p.slice(1).map((q, i) => q.t - p[i].t)
  const mean = dts.reduce((a, b) => a + b, 0) / dts.length
  assert.ok(mean > 6 && mean < 12, `mean sample gap ${mean}`)
  assert.ok(new Set(dts.map((x) => Math.round(x))).size > 2, 'variable sample timing')
  const far = fittsMs(1200, 24, 'max', makeRng(1))
  const near = fittsMs(60, 24, 'max', makeRng(1))
  const big = fittsMs(1200, 300, 'max', makeRng(1))
  assert.ok(far > near && far > big)
  assert.ok(fittsMs(500, 24, 'fast', makeRng(1)) < fittsMs(500, 24, 'max', makeRng(1)) / 3)
})

test('long moves sometimes overshoot and come back', () => {
  let over = 0
  for (let seed = 1; seed <= 80; seed++) {
    const p = mousePath({ x: 0, y: 500 }, { x: 1500, y: 500 }, { mode: 'max', rng: makeRng(seed) })
    if (p.some((q) => q.x > 1500)) over++
  }
  assert.ok(over > 5 && over < 50, `overshoots in 80 runs: ${over}`)
  for (let seed = 1; seed <= 40; seed++) assert.ok(!mousePath({ x: 0, y: 5 }, { x: 1500, y: 5 }, { mode: 'fast', rng: makeRng(seed) }).some((q) => q.x > 1500))
})

test('click offsets stay inside the target', () => {
  const r = makeRng(3)
  for (let i = 0; i < 500; i++) {
    const o = clickOffset(r, 'max', 40, 20)
    assert.ok(Math.abs(o.x) <= 6 && Math.abs(o.y) <= 6)
    const small = clickOffset(r, 'max')
    assert.ok(Math.abs(small.x) <= 2 && Math.abs(small.y) <= 2)
  }
  assert.deepEqual(clickOffset(r, 'fast', 40, 20), { x: 0, y: 0 })
})

test('click timings are within the human ranges', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const ev = clickPlan('left', 2, 'max', makeRng(seed))
    const [d1, u1, d2, u2] = ev.map((e) => e[1])
    assert.ok(d1 >= 40 && d1 <= 160, 'dwell')
    assert.ok(u1 - d1 >= 50 && u1 - d1 <= 110, 'hold')
    assert.ok(d2 - u1 >= 80 && d2 - u1 <= 140, 'double click gap')
    assert.ok(u2 > d2)
  }
})

test('typing keeps the text, with or without slips', () => {
  const text = 'Hello there, this is a longer sentence. It has two parts!\nAnd a second line with Unicode: ăîșțâ 日本語.'
  for (let seed = 1; seed <= 60; seed++) {
    for (const typos of [false, true]) {
      const plan = typePlan(text, 'max', makeRng(seed), typos)
      assert.equal(simulateTyping(plan), text, `seed ${seed} typos ${typos}`)
      for (let i = 1; i < plan.length; i++) assert.ok(plan[i][1] >= plan[i - 1][1], 'time never goes back')
    }
  }
})

test('slips happen in max mode only, and they are rare', () => {
  const text = 'the quick brown fox jumps over the lazy dog '.repeat(40)
  const slips = (mode: Humanness, typos: boolean): number => typeSteps(text, { mode, rng: makeRng(11), typos }).filter((s) => s.ch === '\b').length
  assert.equal(slips('max', false), 0)
  assert.equal(slips('normal', true), 0)
  const n = slips('max', true)
  assert.ok(n > 0 && n < text.length * 0.12, `backspaces ${n}`)
})

test('delays follow a lognormal rhythm inside bounds, with longer pauses at word and sentence ends', () => {
  const steps = typeSteps('abcdefghij klmnop. qrstuv wxyz, abc def ghi. jkl mno pqr stu vwx yz'.repeat(8), { mode: 'max', rng: makeRng(2) })
  for (const s of steps.slice(1)) assert.ok(s.delay >= 35 && s.delay <= 1400 && s.hold >= 30 && s.hold <= 140)
  const text = 'aaaa bbbb. cccc dddd, eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp qqqq rrrr ssss'
  let inWord = 0
  let nIn = 0
  let afterStop = 0
  let nStop = 0
  for (let seed = 1; seed <= 80; seed++) {
    const st = typeSteps(text, { mode: 'max', rng: makeRng(seed) })
    const chars = [...text]
    st.forEach((s, i) => {
      if (i === 0) return
      if (chars[i - 1] === ' ' && chars[i - 2] === '.') {
        afterStop += s.delay
        nStop++
      } else if (/[a-z]/.test(chars[i]) && /[a-z]/.test(chars[i - 1])) {
        inWord += s.delay
        nIn++
      }
    })
  }
  assert.ok(afterStop / nStop > (inWord / nIn) * 1.8, `sentence pause ${afterStop / nStop} vs ${inWord / nIn}`)
  const mean = (m: Humanness): number => typeSteps('abcdefgh'.repeat(60), { mode: m, rng: makeRng(4) }).reduce((a, s) => a + s.delay, 0) / 480
  assert.ok(mean('max') > mean('normal') && mean('normal') > mean('fast') * 3)
  assert.ok(mean('max') > 60 && mean('max') < 200, `max mean ${mean('max')}`)
})

test('the typing plan is deterministic for a seed', () => {
  assert.deepEqual(typePlan('same text twice', 'max', makeRng(8), true), typePlan('same text twice', 'max', makeRng(8), true))
})

test('key chords press modifiers in order and release them in reverse', () => {
  const ev = chordPlan(parseCombo('t+ctrl+shift'), 1, 'max', makeRng(1))
  const seq = ev.map((e) => `${e[2]}${e[3] ? 'v' : '^'}`)
  assert.deepEqual(seq, ['17v', '16v', '84v', '84^', '16^', '17^'])
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i][1] > ev[i - 1][1])
  assert.throws(() => parseCombo('ctrl+bogus'), /Unknown key/)
  assert.deepEqual(parseCombo('F5'), [0x74])
  assert.deepEqual(parseCombo('+'), [0xbb])
})

test('scroll notches slow down like a flick, and drags hold the button across the move', () => {
  const s = scrollPlan(10, false, 'max', makeRng(2))
  assert.equal(s.length, 10)
  assert.ok(s.every((e) => e[2] === -120))
  const gaps = s.slice(1).map((e, i) => e[1] - s[i][1])
  assert.ok(gaps[gaps.length - 1] > gaps[0])
  assert.ok(scrollPlan(-3, false, 'max', makeRng(2)).every((e) => e[2] === 120))
  const d = dragPlan({ x: 10, y: 10 }, { x: 400, y: 300 }, 'left', 'max', makeRng(3))
  assert.equal(d[0][0], 'b')
  assert.equal(d[d.length - 1][0], 'b')
  assert.ok(d[d.length - 1][1] > d[d.length - 2][1])
  const m = movePlan({ x: 5, y: 5 }, { x: 5, y: 5 }, 'max', makeRng(1))
  assert.equal(m.length, 1)
  assert.ok(planEnd(driftPlan({ x: 100, y: 100 }, 1500, makeRng(1))) <= 1500)
})

test('neighbour keys exist for letters', () => {
  assert.ok(neighbours('g').includes('h'))
  assert.deepEqual(neighbours('1'), [])
})

test('policy: security, password managers and banks are refused, system surfaces always ask, the rest asks per program', () => {
  assert.equal(classify({ exe: 'consent.exe', title: 'User Account Control' }).kind, 'blocked')
  assert.equal(classify({ exe: 'KeePassXC.exe', title: 'Vault' }).kind, 'blocked')
  assert.equal(classify({ exe: 'chrome.exe', title: 'Revolut - Payments' }).kind, 'blocked')
  assert.equal(classify({ exe: 'notepad.exe', title: 'a' }, true).kind, 'blocked')
  assert.equal(classify({ exe: 'explorer.exe', title: 'Downloads' }).kind, 'always')
  assert.equal(classify({ exe: 'powershell.exe', title: 'x' }).kind, 'app')
  assert.deepEqual(classify({ exe: 'Notepad.exe', title: 'a' }), { kind: 'app', key: 'notepad.exe', label: 'Notepad' })
  assert.equal(appKey({ exe: 'ApplicationFrameHost.exe', title: 'Calculator' }), 'applicationframehost.exe:calculator')
  assert.ok(reachesPastApp([0x5b, 0x52]) && !reachesPastApp([0x11, 0x43]))
  assert.ok(secretField({ password: true }) && secretField({ name: 'Card number' }) && !secretField({ name: 'Search' }) && !secretField(null))
})
