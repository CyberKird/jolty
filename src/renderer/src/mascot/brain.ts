import { useStore } from '../store'
import { sparks, streak } from './fx'
import { FLOORS, goal, spot, visible, WORK, type Eyes, type Goal, type Pose } from './places'
import type { Puppet } from './Rig3D'

type Mode = 'ground' | 'walk' | 'jump' | 'air' | 'held' | 'dash'

const W = 60
const H = 82
/** px from the top of the element to the feet: the stage's ground line (132) at its 60 % scale */
const FOOT = 132 * 0.6
/** px from the feet to the hood top, where a cursor holds him */
const GRIP = 71
const GRAVITY = 2600
const WALK = 95
const RUN = 270

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)
const calm = (): boolean => document.documentElement.classList.contains('reduce-motion')

/**
 * What Jolty does and where he goes. He stands on the top edge of real interface elements (the composer,
 * an approval card, user messages, settings cards, the window floor), walks or runs along one, jumps
 * between nearby ones and zips as a spark across far ones. The store says what is going on:
 * a running turn means typing on the composer, an approval means pointing at its card, the end of a turn
 * is a little victory jump, an error knocks him over. He can be picked up by the hood and thrown.
 * All drawing is CSS (data-pose / data-eyes on the element); this file only moves the feet point.
 */
export class Brain {
  private x = innerWidth - 80
  private y = innerHeight - 1
  private dir: 1 | -1 = -1
  private mode: Mode = 'ground'
  private anchor: Element | null = null
  private anchorDx = 0
  private pose: Pose = 'idle'
  private vx = 0
  private vy = 0
  private walkTo = 0
  private walkSpeed = WALK
  private jump?: { x0: number; y0: number; el: Element | null; tx: number; t0: number; ms: number; lift: number }
  private floors: { el: Element; r: DOMRect }[] = []
  private floorsAt = 0
  private busyUntil = 0
  /** dropped somewhere by the user: stays there a while unless there is work to do */
  private freeUntil = 0
  private lastActive = performance.now()
  private pointer = { x: -1, y: -1 }
  private press?: { x: number; y: number; t: number; dragged: boolean; vx: number; vy: number; lt: number }
  private raf = 0
  private last = performance.now()
  private timers = new Set<number>()
  private off: (() => void)[] = []
  private entered = false
  /** the floor he stands on changed size (the composer grows, a panel slides): re-read his position */
  private resize = new ResizeObserver(() => this.frame())

  constructor(private el: HTMLElement, private body: Puppet, private onMenu: (e: MouseEvent) => void) {
    this.watchStore()
    this.listen()
    this.frame()
    // jumps out of the bolt in the title bar once the page has laid out
    this.later(() => {
      const bolt = document.querySelector('.titlebar-brand .bolt')?.getBoundingClientRect()
      const home = spot(goal())
      this.entered = true
      if (!bolt || calm()) return this.decide()
      this.x = bolt.left + bolt.width / 2
      this.y = bolt.top + FOOT * 0.6
      this.face(1)
      this.leap(home.el, home.x)
    }, 600)
    this.blink()
    this.idleLoop()
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.resize.disconnect()
    for (const t of this.timers) clearTimeout(t)
    for (const f of this.off) f()
  }

  // -------------------------------------------------------------------------------------------
  // what should he be doing now

  private decide = (): void => {
    if (this.mode !== 'ground' || !this.entered) return
    const now = performance.now()
    if (now < this.busyUntil) return
    const g = goal()
    const work = WORK.has(g.pose)
    if (!work && now < this.freeUntil) return
    const to = spot(g)
    if (this.anchor === to.el && Math.abs(to.x - this.x) < 8) return this.settle(g)
    this.travel(to, g)
  }

  private settle(g: Goal): void {
    if (g.pose === 'idle' && (this.pose === 'sit' || this.pose === 'sleep')) return
    this.set(g.pose, g.eyes, g.bubble)
    if (g.pose === 'point') this.face(1)
  }

  private travel(to: { el: Element | null; x: number; y: number }, g: Goal): void {
    if (calm()) {
      this.place(to.el, to.x, to.y)
      return this.settle(g)
    }
    const dx = to.x - this.x
    const dist = Math.hypot(dx, to.y - this.y)
    if (to.el === this.anchor && Math.abs(to.y - this.y) < 4) {
      this.mode = 'walk'
      this.walkTo = to.x
      this.walkSpeed = Math.abs(dx) > 200 || g.pose !== 'idle' ? RUN : WALK
      this.face(dx < 0 ? -1 : 1)
      this.set(this.walkSpeed === RUN ? 'run' : 'walk', g.pose === 'idle' ? 'open' : g.eyes)
    } else if (dist < 560) {
      this.face(dx < 0 ? -1 : 1)
      this.leap(to.el, to.x)
    } else {
      this.dash(to.el, to.x, to.y)
    }
  }

  private leap(el: Element | null, tx: number): void {
    const ty = el ? (visible(el)?.top ?? innerHeight - 1) : innerHeight - 1
    const dist = Math.hypot(tx - this.x, ty - this.y)
    this.mode = 'jump'
    this.jump = { x0: this.x, y0: this.y, el, tx, t0: performance.now(), ms: clamp(380 + dist * 0.55, 420, 760), lift: 46 + Math.max(0, this.y - ty) * 0.6 }
    this.set('jump', 'happy')
  }

  private dash(el: Element | null, tx: number, ty: number): void {
    this.mode = 'dash'
    this.set('dash', 'open')
    streak(this.x, this.y - 40, tx, ty - 40)
    this.face(tx < this.x ? -1 : 1)
    this.later(() => {
      this.place(el, tx, el ? (visible(el)?.top ?? ty) : ty)
      this.landed(0)
    }, 170)
  }

  private fall(vx: number, vy: number): void {
    this.mode = 'air'
    this.anchor = null
    this.vx = vx
    this.vy = vy
    this.floorsAt = 0
    this.set('fall', 'worried')
  }

  private place(el: Element | null, x: number, y: number): void {
    this.anchor = el
    this.x = x
    this.y = y
    const r = el?.getBoundingClientRect()
    this.anchorDx = r ? x - r.left : 0
    this.mode = 'ground'
    this.resize.disconnect()
    if (el) this.resize.observe(el)
  }

  private landed(speed: number): void {
    this.mode = 'ground'
    if (speed > 1500) return this.react('trip', 'dizzy', 1600)
    this.react('land', 'open', 260)
  }

  /** a short reaction; the usual behaviour resumes when it ends */
  private react(pose: Pose, eyes: Eyes, ms: number, bubble?: string): void {
    if (this.mode !== 'ground') return
    this.set(pose, eyes, bubble)
    this.busyUntil = performance.now() + ms
    this.later(this.decide, ms + 10)
  }

  /** the frame loop: movement, physics, and staying on a floor that scrolls or resizes */
  private tick = (now: number): void => {
    this.raf = 0
    const dt = Math.min(0.05, Math.max(0, now - this.last) / 1000)
    this.last = now
    if (this.mode === 'ground') this.follow()
    else if (this.mode === 'walk') this.stepWalk(dt)
    else if (this.mode === 'jump') this.stepJump(now)
    else if (this.mode === 'air') this.stepAir(dt)
    this.look()
    this.apply()
    // standing still costs nothing: the loop only runs while he moves, events wake it for one frame
    if (this.mode === 'walk' || this.mode === 'jump' || this.mode === 'air') this.frame()
  }

  private frame(): void {
    if (this.raf) return
    if (this.mode !== 'walk' && this.mode !== 'jump' && this.mode !== 'air') this.last = performance.now()
    this.raf = requestAnimationFrame(this.tick)
  }

  private follow(): void {
    if (!this.anchor) {
      this.y = innerHeight - 1
      this.x = clamp(this.x, 30, innerWidth - 30)
      return
    }
    // the card was answered or the composer replaced: hop to where he is needed; scrolled away: fall off
    if (!this.anchor.isConnected) {
      const home = spot(goal())
      return calm() ? this.place(home.el, home.x, home.y) : this.leap(home.el, home.x)
    }
    const r = visible(this.anchor)
    if (!r) return this.fall(0, 0)
    this.y = r.top
    this.x = clamp(r.left + this.anchorDx, r.left + 14, r.right - 14)
  }

  private stepWalk(dt: number): void {
    this.follow()
    if (this.mode !== 'walk') return
    const step = this.walkSpeed * dt
    if (Math.abs(this.walkTo - this.x) <= step) {
      this.x = this.walkTo
      this.place(this.anchor, this.x, this.y)
      this.set('idle', 'open')
      return this.decide()
    }
    this.x += step * Math.sign(this.walkTo - this.x)
    const r = this.anchor?.getBoundingClientRect()
    this.anchorDx = r ? this.x - r.left : 0
  }

  private stepJump(now: number): void {
    const j = this.jump
    if (!j) return
    const t = Math.min(1, (now - j.t0) / j.ms)
    const ty = j.el ? (visible(j.el)?.top ?? innerHeight - 1) : innerHeight - 1
    this.x = j.x0 + (j.tx - j.x0) * t
    this.y = j.y0 + (ty - j.y0) * t - j.lift * 4 * t * (1 - t)
    if (t > 0.55 && this.pose === 'jump') this.set('fall', 'happy')
    if (t >= 1) {
      this.jump = undefined
      this.place(j.el && visible(j.el) ? j.el : null, this.x, ty)
      this.landed(0)
    }
  }

  private stepAir(dt: number): void {
    const py = this.y
    this.vy += GRAVITY * dt
    this.x += this.vx * dt
    this.y += this.vy * dt
    if (this.x < 30 || this.x > innerWidth - 30) {
      this.x = clamp(this.x, 30, innerWidth - 30)
      this.vx *= -0.5
    }
    if (this.y < H && this.vy < 0) {
      this.y = H
      this.vy *= -0.3
    }
    this.body.tilt(clamp(this.vx / 28, -40, 40))
    if (this.vy <= 0) return
    const now = performance.now()
    if (now - this.floorsAt > 150) {
      this.floorsAt = now
      this.floors = [...document.querySelectorAll(FLOORS)].flatMap((el) => {
        const r = visible(el)
        return r ? [{ el, r }] : []
      })
    }
    for (const f of this.floors) {
      if (py <= f.r.top + 1 && this.y >= f.r.top && this.x > f.r.left + 12 && this.x < f.r.right - 12) {
        this.place(f.el, this.x, f.r.top)
        return this.landed(this.vy)
      }
    }
    if (this.y >= innerHeight - 1) {
      this.place(null, this.x, innerHeight - 1)
      this.landed(this.vy)
    }
  }

  /** the eyes follow the cursor */
  private look(): void {
    if (this.pointer.x < 0) return
    const dx = this.pointer.x - this.x
    const dy = this.pointer.y - (this.y - 50)
    this.body.look(clamp(dx / 260, -1, 1), clamp(dy / 260, -1, 1))
  }

  private placed = ''
  private apply(): void {
    const t = `translate3d(${Math.round(this.x - W / 2)}px, ${Math.round(this.y - FOOT)}px, 0)`
    if (t !== this.placed) this.el.style.transform = this.placed = t
  }

  private set(pose: Pose, eyes: Eyes, bubble = ''): void {
    const was = this.pose
    this.pose = pose
    if (pose === 'zap' && was !== 'zap' && !calm()) this.later(this.crackle, 500)
    this.el.dataset.pose = pose
    this.el.dataset.eyes = eyes
    this.body.set(pose, eyes)
    const b = this.el.querySelector('.mascot-bubble')
    if (b && b.textContent !== bubble) b.textContent = bubble
    this.frame()
  }

  private face(dir: 1 | -1): void {
    this.dir = dir
    this.body.face(dir)
  }

  // -------------------------------------------------------------------------------------------
  // reacting to the app

  private watchStore(): void {
    let prev = useStore.getState()
    this.off.push(
      useStore.subscribe((s) => {
        const p = prev
        prev = s
        const id = s.activeId
        // the app's own moments, each with a reaction that fits it
        if (s.update?.state === 'ready' && p.update?.state !== 'ready') this.react('point', 'happy', 2600, '↑')
        if (s.power.armed && !p.power.armed) this.react('wave', 'sleepy', 1600, 'z')
        const toast = s.toasts.at(-1)
        if (toast && toast !== p.toasts.at(-1)) {
          if (toast.error) this.react('idle', 'worried', 1500)
          // a nod: "done" (copied, saved, removed)
          else this.react('land', 'happy', 300)
        }
        if (s.page === 'chat' && !id && p.activeId) this.react('wave', 'happy', 900)
        if (s.page !== p.page || id !== p.activeId) return void this.later(this.decide, 120)
        if (!id) return
        const was = p.status[id]
        const now = s.status[id]
        if (was === 'running' && now === 'idle') {
          this.react('cheer', 'happy', 1400)
          sparks(this.x, this.y - 70)
        } else if (now === 'error' && was !== 'error') this.react('trip', 'dizzy', 1800)
        else if (now !== was) this.later(this.decide, 120)
        if ((s.permissions[id]?.length ?? 0) !== (p.permissions[id]?.length ?? 0)) this.later(this.decide, 120)
        const list = s.transcripts[id]
        const before = p.transcripts[id]
        if (list && list !== before && list.length > (before?.length ?? 0)) {
          const item = list[list.length - 1]
          if (item.kind === 'notice' && item.level === 'error') this.react('trip', 'dizzy', 1800)
          else if (item.kind === 'tool') this.zap()
          // your message is off: a little hop, then he gets to work
          else if (item.kind === 'user') this.react('cheer', 'happy', 450)
        }
        // a step starts or ends, a file starts being written: he switches to what the model does now
        if (now === 'running' && (list !== before || s.drafts[id] !== p.drafts[id])) this.soon()
      })
    )
  }

  private zap(): void {
    this.body.zap()
  }

  private pending = false
  /** decide again shortly, once for a burst of store changes (a streaming step updates many times) */
  private soon(): void {
    if (this.pending) return
    this.pending = true
    this.later(() => {
      this.pending = false
      this.decide()
    }, 150)
  }

  /** a command running: the charge crackles off his bolt */
  private crackle = (): void => {
    if (this.pose !== 'zap' || this.mode !== 'ground') return
    this.body.zap()
    sparks(this.x, this.y - 70)
    this.later(this.crackle, rand(650, 1100))
  }

  /** what he does when nothing is happening */
  private idleLoop = (): void => {
    this.later(this.idleLoop, rand(5000, 11000))
    if (this.mode !== 'ground' || performance.now() < this.busyUntil || calm()) return
    if (goal().pose !== 'idle') return
    const now = performance.now()
    if (now - this.lastActive > 60000) return this.set('sleep', 'sleepy', 'z')
    if (this.pose === 'sleep') return
    const home = spot(goal())
    if (now > this.freeUntil && (home.el !== this.anchor || Math.abs(home.x - this.x) > 40)) return this.decide()
    if (this.pose === 'sit') return this.set('idle', 'open')
    const roll = Math.random()
    if (roll < 0.35) {
      const r = this.anchor?.getBoundingClientRect()
      const lo = r ? r.left + 30 : 40
      const hi = r ? r.right - 30 : innerWidth - 40
      const to = clamp(this.x + rand(60, 200) * (Math.random() < 0.5 ? -1 : 1), lo, hi)
      if (Math.abs(to - this.x) < 30) return
      this.mode = 'walk'
      this.walkTo = to
      this.walkSpeed = WALK
      this.face(to < this.x ? -1 : 1)
      this.freeUntil = performance.now() + 15000
      this.set('walk', 'open')
    } else if (roll < 0.6) {
      this.set('sit', 'open')
    } else if (roll < 0.75 && Math.hypot(this.pointer.x - this.x, this.pointer.y - this.y) < 320) {
      this.face(this.pointer.x < this.x ? -1 : 1)
      this.react('wave', 'happy', 1400)
    }
  }

  private blink = (): void => {
    this.later(this.blink, rand(2400, 6200))
    this.body.blink()
  }

  // -------------------------------------------------------------------------------------------
  // the cursor: eyes follow it, a click says hello, a drag picks him up by the hood

  private listen(): void {
    // what you do in the page: approving or refusing, typing, searching, dropping files
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void): void => {
      window.addEventListener(type, fn, true)
      this.off.push(() => window.removeEventListener(type, fn, true))
    }
    let typedAt = 0
    on('click', (e) => {
      const b = (e.target as Element | null)?.closest?.('.permission .btn')
      if (!b) return
      if (b.classList.contains('danger')) this.react('idle', 'worried', 1200)
      else this.react('cheer', 'happy', 800)
    })
    on('input', (e) => {
      const el = e.target as Element | null
      const now = performance.now()
      if (now - typedAt < 700 || !el?.closest) return
      typedAt = now
      // the search box: out comes the magnifying glass; the composer: he reads along as you type
      if (el.closest('.search')) this.react('search', 'focus', 1400)
      else if (el.closest('.composer') && this.mode === 'ground' && WORK.has(goal().pose) === false) this.react('idle', 'focus', 1100)
    })
    on('dragenter', (e) => {
      if (e.dataTransfer?.types.includes('Files')) this.react('point', 'happy', 1600, '+')
    })
    on('drop', (e) => {
      if (e.dataTransfer?.types.includes('Files')) this.react('cheer', 'happy', 800)
    })
    const hit = this.el.querySelector('.m-hit') as SVGElement | null
    const wake = (): void => {
      if (this.pose === 'sleep' && this.mode === 'ground') this.react('land', 'open', 300)
    }
    const move = (e: PointerEvent): void => {
      this.pointer = { x: e.clientX, y: e.clientY }
      this.frame()
      this.lastActive = performance.now()
      if (Math.hypot(e.clientX - this.x, e.clientY - this.y) < 200) wake()
      const p = this.press
      if (!p) return
      if (!p.dragged && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) {
        p.dragged = true
        this.mode = 'held'
        this.anchor = null
        this.jump = undefined
        this.set('held', 'worried')
      }
      if (!p.dragged) return
      const dt = Math.max(1, e.timeStamp - p.lt) / 1000
      p.vx = p.vx * 0.5 + ((e.clientX - this.x) / dt) * 0.5
      p.vy = p.vy * 0.5 + ((e.clientY + GRIP - this.y) / dt) * 0.5
      p.lt = e.timeStamp
      this.x = clamp(e.clientX, 30, innerWidth - 30)
      this.y = clamp(e.clientY + GRIP, H, innerHeight - 1)
    }
    const down = (e: PointerEvent): void => {
      if (e.button !== 0) return
      e.preventDefault()
      hit?.setPointerCapture(e.pointerId)
      this.press = { x: e.clientX, y: e.clientY, t: e.timeStamp, dragged: false, vx: 0, vy: 0, lt: e.timeStamp }
    }
    const up = (): void => {
      const p = this.press
      this.press = undefined
      if (!p) return
      if (!p.dragged) {
        if (this.mode !== 'ground') return
        this.face(this.pointer.x < this.x ? -1 : 1)
        this.react('wave', 'happy', 1300)
        return sparks(this.x, this.y - 70)
      }
      this.freeUntil = performance.now() + 9000
      if (calm()) {
        this.place(null, this.x, innerHeight - 1)
        return this.landed(0)
      }
      this.fall(clamp(p.vx, -1800, 1800), clamp(p.vy, -1800, 1800))
    }
    const menu = (e: MouseEvent): void => {
      e.stopPropagation()
      this.onMenu(e)
    }
    const vis = (): void => void this.el.classList.toggle('paused', document.hidden)
    const key = (): void => {
      this.lastActive = performance.now()
      wake()
    }
    const signal = new AbortController()
    const opts = { signal: signal.signal }
    hit?.addEventListener('pointerdown', down, opts)
    hit?.addEventListener('pointerup', up, opts)
    hit?.addEventListener('pointercancel', up, opts)
    hit?.addEventListener('contextmenu', menu, opts)
    window.addEventListener('pointermove', move, { ...opts, passive: true })
    window.addEventListener('keydown', key, { ...opts, passive: true })
    document.addEventListener('visibilitychange', vis, opts)
    const nudge = (): void => this.frame()
    window.addEventListener('scroll', nudge, { ...opts, capture: true, passive: true })
    window.addEventListener('resize', nudge, opts)
    const poll = window.setInterval(nudge, 1000)
    this.off.push(() => signal.abort(), () => clearInterval(poll))
  }

  private later(fn: () => void, ms: number): void {
    const t = window.setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    this.timers.add(t)
  }
}
