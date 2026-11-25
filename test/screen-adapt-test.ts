import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Adapt, LADDER, LoadWatch, START_LEVEL, stepFor } from '../src/main/remote-screen-adapt'

// The controller on a simulated link, on a virtual clock: same inputs, same answers, every run.
// The link: one queue drained at `kbps`, `rtt` round trip, and loss the way TCP shows it (a lost segment is sent again
// after a timeout and everything behind it waits). The encoder makes exactly the step's bitrate (worse than a real screen,
// which is mostly still), a whole picture every gopSec at 6 times a normal one, and one at once when asked.

interface Link {
  kbps: number
  rtt: number
  loss?: number
  /** the link is cut for `down` ms every `every` ms */
  flap?: { every: number; down: number }
}

interface Run {
  levels: Array<{ t: number; level: number }>
  /** capture to arrival on the phone, ms, with the time it arrived */
  g2g: Array<{ t: number; ms: number }>
  /** bytes queued in the link, sampled */
  queue: Array<{ t: number; bytes: number }>
  keys: number
  sentFrames: number
}

function simulate(phases: Array<{ ms: number; link: Link }>, seed = 1): Run {
  let rnd = seed
  const random = (): number => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const a = new Adapt(0)
  const run: Run = { levels: [], g2g: [], queue: [], keys: 0, sentFrames: 0 }
  // the link's queue: chunks waiting to go out, and those on the way
  const queue: Array<{ seq: number; bytes: number; left: number; born: number; holdUntil: number }> = []
  const flying: Array<{ seq: number; at: number; born: number }> = []
  const acks: Array<{ seq: number; at: number }> = []
  let seq = 0
  let needKey = true
  let keySince = 0
  let keyAsked = false
  let nextFrame = 0
  let lastKey = -1e9
  let lastAckSent = -1e9
  let pendingAck = -1
  let newest = -1
  const total = phases.reduce((n, p) => n + p.ms, 0)
  const dt = 2
  for (let t = 0, phase = 0, phaseEnd = phases[0].ms; t < total; t += dt) {
    if (t >= phaseEnd) phaseEnd += phases[++phase].ms
    const link = phases[phase].link
    const cut = link.flap ? t % link.flap.every < link.flap.down : false
    // the encoder
    const s = a.step
    if (t >= nextFrame) {
      nextFrame = t + 1000 / s.fps
      const avg = s.bps / 8 / s.fps
      const key = Boolean(s.keyOnly) || keyAsked || t - lastKey >= s.gopSec * 1000
      // a slideshow spends its whole budget on whole pictures; otherwise a whole picture is 6 normal ones
      const bytes = Math.round(key && !s.keyOnly ? avg * 6 : avg) + 14
      if (key) {
        lastKey = t
        keyAsked = false
        run.keys++
      }
      if (needKey && !key) {
        // waits for a whole picture, and asks again when allowed (as remote-screen.ts does); skipped pictures count once
        // this encoder (one that answers at its next picture) had time to send one
        a.skipped(t, t - keySince, 300)
        if (!s.keyOnly && a.askKey(t)) keyAsked = true
      } else if (!a.canSend(bytes, t)) {
        if (!needKey) keySince = t
        needKey = true
        if (!s.keyOnly && a.askKey(t)) keyAsked = true
      } else {
        needKey = false
        seq++
        a.sent(seq, bytes, t)
        queue.push({ seq, bytes, left: bytes, born: t, holdUntil: 0 })
        run.sentFrames++
      }
    }
    // the link drains its queue
    if (!cut) {
      let budget = (link.kbps * 1000 * dt) / 8 / 1000
      while (budget > 0 && queue.length) {
        const q = queue[0]
        if (q.holdUntil > t) break
        if (q.holdUntil === 0 && link.loss && random() < link.loss) {
          // lost: sent again (most often after duplicate acks, one round trip; sometimes after a timeout), and
          // everything behind waits (head of line)
          q.holdUntil = t + (random() < 0.8 ? link.rtt : Math.max(200, link.rtt * 1.5))
          break
        }
        const n = Math.min(budget, q.left)
        q.left -= n
        budget -= n
        if (q.left <= 0) {
          queue.shift()
          flying.push({ seq: q.seq, at: t + link.rtt / 2, born: q.born })
        }
      }
    }
    // arrivals on the phone, and its acks (at most every 40 ms, as screen-feedback.ts does)
    while (flying.length && flying[0].at <= t && !cut) {
      const f = flying.shift()!
      run.g2g.push({ t, ms: t - f.born })
      newest = f.seq
    }
    if (newest > pendingAck && t - lastAckSent >= 40) {
      pendingAck = newest
      lastAckSent = t
      acks.push({ seq: newest, at: t + link.rtt / 2 })
    }
    while (acks.length && acks[0].at <= t && !cut) a.acked(acks.shift()!.seq, t)
    if (t % 250 === 0) {
      const before = a.level
      if (a.tick(t)) run.levels.push({ t, level: a.level })
      if (process.env.SIM_TRACE && (t % 1000 === 0 || a.level !== before)) console.log(t, JSON.stringify(a.debug(t)), 'q', queue.length, a.level !== before ? 'CHANGE' : '')
      run.queue.push({ t, bytes: queue.reduce((n, q) => n + q.left, 0) })
    }
  }
  return run
}

const levelAt = (r: Run, t: number): number => [{ t: 0, level: START_LEVEL }, ...r.levels].filter((l) => l.t <= t).at(-1)!.level
const p95 = (xs: number[]): number => {
  const s = [...xs].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0
}
const g2gIn = (r: Run, from: number, to: number): number[] => r.g2g.filter((g) => g.t >= from && g.t < to).map((g) => g.ms)
const maxQueueIn = (r: Run, from: number, to: number): number => Math.max(0, ...r.queue.filter((q) => q.t >= from && q.t < to).map((q) => q.bytes))

const PROFILES: Record<string, Link> = {
  good: { kbps: 20_000, rtt: 20 },
  '4g': { kbps: 5000, rtt: 80 },
  weak: { kbps: 300, rtt: 400 },
  awful: { kbps: 100, rtt: 1200 },
  loss: { kbps: 5000, rtt: 80, loss: 0.05 }
}

const results: Record<string, unknown> = {}

for (const [name, link] of Object.entries(PROFILES).filter(([n]) => !process.env.SIM_ONLY || n === process.env.SIM_ONLY)) {
  test(`profile ${name}: reaches its step, latency bounded, no growing backlog`, () => {
    const r = simulate([{ ms: 40_000, link }])
    const end = levelAt(r, 40_000)
    const late = g2gIn(r, 25_000, 40_000)
    const mid = g2gIn(r, 10_000, 25_000)
    const fps = r.g2g.filter((g) => g.t >= 30_000).length / 10
    results[name] = { step: LADDER[end].name, fpsOnPhone: fps, g2gP95: p95(late), maxQueueKB: Math.round(maxQueueIn(r, 25_000, 40_000) / 1000), keys: r.keys }
    // bounds: what a well-behaved stream on that link can do (one way delay + a couple of pictures in the queue)
    const bound = { good: 120, '4g': 350, weak: 1600, awful: 3800, loss: 900 }[name]!
    assert.ok(p95(late) <= bound, `${name}: p95 capture to phone ${p95(late)} ms <= ${bound}`)
    // no backlog that grows: the late part is not worse than the middle part, and the queue stays small
    assert.ok(p95(late) <= p95(mid) * 1.5 + 150, `${name}: latency not growing (${p95(mid)} -> ${p95(late)})`)
    const queueSecs = maxQueueIn(r, 25_000, 40_000) / ((link.kbps * 1000) / 8)
    assert.ok(queueSecs <= 2.6, `${name}: queue at most ${queueSecs.toFixed(2)} s of link`)
    // 5 % loss: TCP itself carries about MSS / (RTT * sqrt(p)) = 0.66 Mbit/s there, so a 480p or 360p step is right
    const expect = { good: [0, 0], '4g': [1, 2], weak: [5, 6], awful: [6, 7], loss: [2, 6] }[name]!
    assert.ok(end >= expect[0] && end <= expect[1], `${name}: ended at ${LADDER[end].name} (level ${end}), expected ${expect.join('-')}`)
  })
}

test('recovery: an awful link that becomes good climbs back to 60 fps within 15 s, one step at a time', () => {
  const r = simulate([{ ms: 25_000, link: PROFILES.awful }, { ms: 25_000, link: PROFILES.good }])
  assert.ok(levelAt(r, 25_000) >= 6, 'down at the floor while awful')
  const back = r.levels.find((l) => l.t > 25_000 && l.level === 0)
  assert.ok(back && back.t - 25_000 <= 15_000, `back to 60 fps after ${back ? back.t - 25_000 : 'never'} ms`)
  const ups = r.levels.filter((l) => l.t > 25_000)
  for (let i = 1; i < ups.length; i++) assert.ok(ups[i - 1].level - ups[i].level <= 1, 'slow up: one step at a time')
  results.recovery = { secondsToTop: back ? (back.t - 25_000) / 1000 : undefined }
})

test('fast down: a link that drops from good to weak is followed within 3 s, in one jump when goodput says so', () => {
  const r = simulate([{ ms: 15_000, link: PROFILES.good }, { ms: 15_000, link: PROFILES.weak }])
  assert.equal(levelAt(r, 15_000), 0)
  const firstDown = r.levels.find((l) => l.t > 15_000 && l.level > 0)!
  assert.ok(firstDown.t - 15_000 <= 1500, `first step down after ${firstDown.t - 15_000} ms`)
  const settled = r.levels.find((l) => l.t > 15_000 && l.level >= 5)
  assert.ok(settled && settled.t - 15_000 <= 4000, `at a weak step after ${settled ? settled.t - 15_000 : 'never'} ms`)
  results.fastDown = { msToFirstStep: firstDown.t - 15_000, msToWeakStep: settled!.t - 15_000 }
})

test('flapping link (cut 1.5 s every 6 s on 4G): keeps streaming, latency recovers after each cut, no runaway', () => {
  const r = simulate([{ ms: 40_000, link: { kbps: 5000, rtt: 80, flap: { every: 6000, down: 1500 } } }])
  // outside the cuts (and a second after each), pictures arrive quickly
  const calm = r.g2g.filter((g) => g.t > 10_000 && g.t % 6000 > 2500).map((g) => g.ms)
  assert.ok(p95(calm) <= 600, `latency between cuts p95 ${p95(calm)} ms`)
  assert.ok(maxQueueIn(r, 10_000, 40_000) <= 400_000, 'the queue stays bounded through the cuts')
  assert.ok(r.g2g.filter((g) => g.t > 30_000).length > 40, 'still streaming at the end')
  results.flapping = { p95BetweenCuts: p95(calm), level: LADDER[levelAt(r, 40_000)].name }
})

test('a step up that fails waits longer before the next try (hysteresis)', () => {
  // 1.5 Mbit/s: 20/540p (1 Mbit/s) fits, 30/720p (2 Mbit/s) does not
  const r = simulate([{ ms: 60_000, link: { kbps: 1500, rtt: 60 } }])
  const ups = r.levels.filter((l, i) => i > 0 && l.level < r.levels[i - 1].level && l.t > 5000)
  const gaps = ups.slice(1).map((u, i) => u.t - ups[i].t)
  assert.ok(ups.length >= 1, 'it tries')
  assert.ok(gaps.every((g) => g >= 2900), `never two tries close together (${gaps.join(', ')} ms)`)
  assert.ok(ups.length <= 12, `few tries in a minute (${ups.length})`)
  // the hold itself, directly: a failed try doubles it
  const a = new Adapt(0, 3)
  for (let t = 0; t < 4000 && a.level === 3; t += 50) {
    a.sent(t, 100, t)
    a.acked(t, t + 30)
    a.tick(t + 30)
  }
  assert.equal(a.level, 2, 'calm: one step up')
  // the next calm spell would take it up again: the link changes before that
  const before = a.holdUp
  // the link cannot take more: from now on every picture is answered 600 ms after it left
  for (let t = 4000; t < 8000; t += 50) {
    a.sent(t, 100, t)
    if (t - 600 >= 4000) a.acked(t - 600, t)
    a.tick(t)
  }
  assert.ok(a.level >= 2, `back down (level ${a.level})`)
  assert.ok(a.holdUp >= before * 2, `and the next try waits longer (${before} -> ${a.holdUp} ms)`)
  const at = r.levels.filter((l) => l.t > 30_000).map((l) => l.level)
  assert.ok(at.every((l) => l >= 2), 'never above what the link carries for long')
})

test('the window: nothing in the air always sends, a slideshow waits for each picture, a dead link gets nothing', () => {
  const a = new Adapt(0)
  assert.equal(a.canSend(10_000_000, 0), true, 'an empty link takes even a big whole picture')
  a.sent(1, 1000, 0)
  assert.equal(a.canSend(1000, 10), false, 'before the first answer: one chunk at a time')
  a.acked(1, 40)
  a.sent(2, 1000, 50)
  assert.equal(a.canSend(1000, 60), true)
  assert.equal(a.canSend(10_000_000, 10), false, 'not past the window')
  assert.equal(a.canSend(1000, 3000), false, 'a link that stopped answering gets nothing more')
  a.acked(2, 3000)
  assert.equal(a.inFlight, 0)
  const s = new Adapt(0, LADDER.length - 1)
  s.sent(1, 100, 0)
  assert.equal(s.canSend(10, 1), false, 'slideshow: one picture at a time')
})

test('whole pictures are asked for at most once a second (more rarely on a long link)', () => {
  const a = new Adapt(0)
  assert.equal(a.askKey(0), true)
  assert.equal(a.askKey(500), false)
  assert.equal(a.askKey(1000), true)
  // a 900 ms round trip: once every 1.8 s
  a.sent(1, 10, 2000)
  a.acked(1, 2900)
  assert.equal(a.askKey(2900), true)
  assert.equal(a.askKey(3500), false)
  assert.equal(a.askKey(4000), false)
  assert.equal(a.askKey(2900 + 1800), true)
})

test('a phone that cannot decode in time makes the step go down even on a good link', () => {
  const a = new Adapt(0, 0)
  for (let t = 0; t < 2000; t += 100) {
    a.sent(t, 100, t)
    a.acked(t, t + 10)
  }
  a.report({ fps: 20, dec: 20, decMs: 40 })
  assert.equal(a.tick(2000), false, 'one slow second is not enough')
  a.report({ fps: 20, dec: 20, decMs: 40 })
  assert.equal(a.tick(2100), true)
  assert.equal(a.level, 1)
})

test('stepFor picks the highest step that fits, and the PC load caps 60 fps', () => {
  assert.equal(stepFor(100_000_000), 0)
  assert.equal(stepFor(4_000_000), 1)
  assert.equal(stepFor(300_000), 5)
  assert.equal(stepFor(10), LADDER.length - 1)
  const w = new LoadWatch()
  const cpu = (idle: number, busy: number) => [{ times: { idle, user: busy, nice: 0, sys: 0, irq: 0 } }]
  w.sample(cpu(0, 0))
  w.sample(cpu(10, 90))
  assert.equal(w.floor, 0, 'one busy sample is not enough')
  w.sample(cpu(20, 180))
  assert.equal(w.floor, 1, 'busy: no 60 fps')
  for (let i = 3; i < 9; i++) w.sample(cpu(20 + (i - 2) * 90, 180 + (i - 2) * 10))
  assert.equal(w.floor, 0, 'calm again: everything allowed')
  const a = new Adapt(0, 0)
  a.floor = 1
  a.tick(250)
  assert.equal(a.level, 1)
})

test('measured numbers', () => {
  console.log('SIM ' + JSON.stringify(results))
})

test('a whole picture bigger than the window still goes while a little is in the air (a sharp 4K one is large)', () => {
  const a = new Adapt(0, 0)
  a.sent(1, 2000, 0)
  a.acked(1, 20)
  a.sent(2, 2000, 30)
  const big = a.window(31) + 200_000
  assert.equal(a.canSend(big, 31), false, 'a change that big does not fit')
  assert.equal(a.canSend(big, 31, true), true, 'a whole picture gets room for itself')
})
