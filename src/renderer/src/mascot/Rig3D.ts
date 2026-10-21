import * as THREE from 'three'
import { loadJolty, lightStudio, SEARCH_ARM, type Joints } from './model'
import type { Eyes, Pose } from './places'

/** What the brain can ask of the body. */
export interface Puppet {
  set(pose: Pose, eyes: Eyes): void
  face(dir: 1 | -1): void
  /** where the cursor is, -1..1 on each axis around his head */
  look(x: number, y: number): void
  tilt(deg: number): void
  blink(): void
  zap(): void
  /** standing on the window's floor (true) or on an element's edge he can sit on */
  floor(on: boolean): void
  /** how fast he moves on screen (px/s): limbs lag, a throw spins him */
  motion(vx: number, vy: number): void
  destroy(): void
}

/** The visible box around him, in model units: the feet are at (0, 0), y goes up. */
export const VIEW = { left: -125, right: 125, top: 175, bottom: -30 }

type T = Record<string, number>
const TAU = Math.PI * 2
const REST: T = {
  rootX: 0, rootY: 0, rootSX: 1, rootSY: 1, rootRZ: 0, rootRY: 0, hangRZ: 0, torsoRX: 0, torsoSY: 1,
  headRX: 0, headRY: 0, headRZ: 0, boltRZ: 0, boltRX: 0, boltS: 1, eyesSY: 1,
  armLRX: 0, armLRZ: 0, armRRX: 0, armRRZ: 0, legLRX: 0, legRRX: 0,
  // how much the left arm follows the pose (its hand lives in the pocket), and where the eyes look on their own
  armLK: 0.35, eyeX: 0, eyeY: 0,
  // the upper spine, knees and elbows: a little bent at rest, never locked straight
  chestRX: 0, kneeL: 0.06, kneeR: 0.06, elbL: -0.14, elbR: -0.14
}
/** turning and settling into a seat are slower than limbs */
const EASE: T = { rootRY: 9, rootY: 16, headRY: 10 }
const QUIET = new Set<Pose>(['idle', 'sit', 'sleep'])
const SEATED = new Set<Pose>(['sit', 'sleep', 'type', 'read'])
/** poses with the laptop out of the hoodie pocket */
const LAPTOP = new Set<Pose>(['type', 'read'])
/** the laptop's way out: from the kangaroo pocket to his lap, then the lid opens (seconds) */
const DRAW = { reach: 0.3, fly: 0.75, open: 1.05 }
const POCKET = { y: 38, z: 18 }
const LAP = { y: 36, z: 25 }
const LID_OPEN = 0.28
const LID_SHUT = -1.45
const easeOutBack = (k: number): number => 1 + 2.4 * Math.pow(k - 1, 3) + 1.4 * Math.pow(k - 1, 2)
const clamp01 = (k: number): number => Math.max(0, Math.min(1, k))

/**
 * Renders Jolty with three.js on a small transparent canvas and animates his joints from the pose the brain
 * picked. Each frame computes where every joint should be for the pose and time, then eases toward it, so
 * changing pose blends instead of snapping. Standing still renders at 24 fps, moving at full rate.
 * The volt parts glow: each frame first draws only them (the body just hides what is behind it) into a
 * second, half-size canvas that CSS blurs and adds over him (.m-glow in mascot.css). A bloom pass would
 * cost more and lose the canvas's transparency.
 */
export class Rig3D implements Puppet {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.OrthographicCamera
  /** null until the model has loaded */
  private j: Joints | null = null
  private gone = false
  private pose: Pose = 'dash'
  private eyes: Eyes = 'open'
  private since = performance.now()
  private dir: 1 | -1 = 1
  private lookX = 0
  private lookY = 0
  private tiltDeg = 0
  private cur: T = { ...REST }
  private blinkUntil = 0
  private zapUntil = 0
  private raf = 0
  private last = performance.now()
  private drawn = 0
  /** when the laptop came out of the pocket, and when it went back in */
  private laptopSince = -1e9
  private laptopAway = -1e9
  private lookedAt = 0
  private onFloor = false
  /** on-screen velocity from the brain, and when it last said */
  private mv = { x: 0, y: 0, at: 0, px: 0, py: 0, speed: 0 }
  /** secondary motion, springs driven by how he speeds up: limbs swinging, a jolt up or down, the hood pendulum */
  private spr = { sw: 0, swv: 0, up: 0, upv: 0, hang: 0, hangv: 0 }
  /** tumbling through the air after a throw, and the side he lands on */
  private spin = 0
  private rot = 0
  private side: 1 | -1 = 1
  /** when he slid the stool out of the composer (floor seats) */
  private stoolSince = -1e9
  /** a face the pose wears for a moment (a glance at you, an idea), over the one the brain asked for */
  private moment: Eyes | undefined
  private glow: HTMLCanvasElement
  private glowCtx: CanvasRenderingContext2D
  /** every drawable with its own material and the one it wears in the glow pass */
  private swaps: { o: THREE.Mesh | THREE.Sprite; normal: THREE.Material; glow: THREE.Material }[] = []

  constructor(canvas: HTMLCanvasElement, pxPerUnit: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio))
    this.renderer.setSize((VIEW.right - VIEW.left) * pxPerUnit, (VIEW.top - VIEW.bottom) * pxPerUnit)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.38
    this.glow = document.createElement('canvas')
    this.glow.className = 'm-glow'
    this.glow.width = Math.ceil(canvas.width / 2)
    this.glow.height = Math.ceil(canvas.height / 2)
    // the halo's reach scales with him (3 px at the app's size)
    Object.assign(this.glow.style, { left: canvas.style.left, top: canvas.style.top, width: canvas.style.width, height: canvas.style.height, filter: `blur(${(pxPerUnit * 5).toFixed(1)}px) brightness(1.6)` })
    canvas.after(this.glow)
    this.glowCtx = this.glow.getContext('2d')!
    this.camera = new THREE.OrthographicCamera(VIEW.left, VIEW.right, VIEW.top, VIEW.bottom, -2000, 2000)
    // a little from above, like the render
    this.camera.position.set(0, Math.sin(0.16) * 600, Math.cos(0.16) * 600)
    this.camera.lookAt(0, 0, 0)
    lightStudio(this.scene, this.renderer)
    void loadJolty(this.scene).then((j) => {
      if (this.gone) return this.dispose()
      this.j = j
      this.prepareGlow()
      this.raf = requestAnimationFrame(this.tick)
    })
  }

  set(pose: Pose, eyes: Eyes): void {
    const now = performance.now()
    // the laptop comes out once for a run of laptop work, and goes back in when that ends
    if (LAPTOP.has(pose) && !LAPTOP.has(this.pose)) this.laptopSince = now
    if (!LAPTOP.has(pose) && LAPTOP.has(this.pose)) this.laptopAway = now
    if (pose === 'fall' && this.pose !== 'fall') {
      // thrown: spin with the throw (a drop from a jump barely turns)
      this.spin = Math.max(-14, Math.min(14, this.mv.x / (this.pose === 'held' ? 160 : 600)))
      this.rot = this.cur.rootRZ
    }
    if (this.pose === 'fall' && pose !== 'fall') {
      // landed: on the side he was turning to; the turns he made fold back into one
      const r = Math.atan2(Math.sin(this.rot), Math.cos(this.rot))
      this.side = (Math.abs(r) > 0.3 ? -Math.sign(r) : this.spin > 0 ? -1 : 1) as 1 | -1
      this.cur.rootRZ = r
    }
    if (SEATED.has(pose) && !SEATED.has(this.pose)) this.stoolSince = now
    if (pose !== this.pose) this.since = now
    this.pose = pose
    this.eyes = eyes
  }
  face(dir: 1 | -1): void {
    this.dir = dir
  }
  look(x: number, y: number): void {
    if (Math.abs(x - this.lookX) + Math.abs(y - this.lookY) > 0.02) this.lookedAt = performance.now()
    this.lookX = x
    this.lookY = y
  }
  tilt(deg: number): void {
    this.tiltDeg = deg
  }
  blink(): void {
    this.blinkUntil = performance.now() + 120
  }
  floor(on: boolean): void {
    this.onFloor = on
  }
  motion(vx: number, vy: number): void {
    Object.assign(this.mv, { x: vx, y: vy, at: performance.now() })
  }
  zap(): void {
    this.zapUntil = performance.now() + 260
  }

  destroy(): void {
    this.gone = true
    cancelAnimationFrame(this.raf)
    // still loading: the load disposes when it lands
    if (this.j) this.dispose()
  }

  private dispose(): void {
    this.glow.remove()
    for (const s of this.swaps) if (s.glow !== s.normal) s.glow.dispose()
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        o.geometry.dispose()
        const m = o.material as THREE.Material & { map?: THREE.Texture; emissiveMap?: THREE.Texture }
        m.map?.dispose()
        m.emissiveMap?.dispose()
        m.dispose()
      }
    })
    this.scene.environment?.dispose()
    this.renderer.dispose()
  }

  /** what each part shows in the glow pass: its volt, or nothing */
  private prepareGlow(): void {
    // writes depth only: the body hides the glow of what is behind it and draws nothing itself
    const cover = new THREE.MeshBasicMaterial({ colorWrite: false })
    const none = new THREE.MeshBasicMaterial({ visible: false })
    const noSprite = new THREE.SpriteMaterial({ visible: false })
    this.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh || o instanceof THREE.Sprite)) return
      const m = o.material as THREE.MeshStandardMaterial
      let glow: THREE.Material = cover
      // the soft eye halo and the floor shadow sit the pass out
      if (o instanceof THREE.Sprite) glow = noSprite
      else if (o === this.j!.shadow) glow = none
      else if (m instanceof THREE.MeshBasicMaterial) glow = m
      else if (m.emissiveMap) glow = new THREE.MeshBasicMaterial({ map: m.emissiveMap, toneMapped: false })
      else if (m.emissive?.getHex()) glow = new THREE.MeshBasicMaterial({ color: m.emissive, toneMapped: false })
      this.swaps.push({ o, normal: m, glow })
    })
  }

  private drawGlow(): void {
    for (const s of this.swaps) s.o.material = s.glow
    this.renderer.render(this.scene, this.camera)
    this.glowCtx.clearRect(0, 0, this.glow.width, this.glow.height)
    this.glowCtx.drawImage(this.renderer.domElement, 0, 0, this.glow.width, this.glow.height)
    for (const s of this.swaps) s.o.material = s.normal
  }

  /** where every joint should be right now */
  private target(now: number): T {
    const s = now / 1000
    const t = (now - this.since) / 1000
    const d = this.dir
    const o: T = { ...REST }
    this.moment = undefined
    const lx = this.lookX
    const ly = this.lookY
    const lookAt = (body: number, head: number): void => {
      // the eyes do most of the following now (apply); body and head only lean into it
      o.rootRY = lx * body * 0.4
      o.headRY = lx * head * 0.6
      o.headRX = -ly * 0.22
    }
    switch (this.pose) {
      case 'idle':
        o.torsoSY = 1 + 0.014 * Math.sin((s * TAU) / 3.2)
        o.chestRX = 0.02 * Math.sin((s * TAU) / 3.2)
        o.boltRZ = 0.09 * Math.sin((s * TAU) / 2.6)
        // weight shifting from one foot to the other: the loaded knee straightens, the other softens
        o.rootRZ = 0.018 * Math.sin((s * TAU) / 5)
        o.kneeL = 0.07 + 0.06 * Math.max(0, Math.sin((s * TAU) / 5))
        o.kneeR = 0.07 + 0.06 * Math.max(0, -Math.sin((s * TAU) / 5))
        lookAt(0.4, 0.45)
        o.rootRY += 0.18 * d
        break
      case 'walk':
      case 'run': {
        const run = this.pose === 'run'
        const c = (s * TAU) / (run ? 0.3 : 0.52)
        const leg = run ? 0.95 : 0.5
        const arm = run ? 1.1 : 0.55
        o.legLRX = leg * Math.sin(c)
        o.legRRX = -leg * Math.sin(c)
        o.armLRX = -arm * Math.sin(c)
        o.armRRX = arm * Math.sin(c)
        // the knee bends while its leg swings forward, lifting the foot; elbows bent, more when running
        const kb = run ? 1.25 : 0.65
        o.kneeL = 0.05 + kb * Math.max(0, -Math.cos(c))
        o.kneeR = 0.05 + kb * Math.max(0, Math.cos(c))
        o.elbL = o.elbR = run ? -1.25 : -0.4
        o.chestRX = run ? 0.1 : 0.03
        o.rootY = (run ? 5 : 3) * Math.abs(Math.sin(c))
        o.torsoRX = run ? 0.2 : 0.06
        o.boltRX = run ? -0.4 : 0
        o.rootRY = d * (run ? 1.2 : 1.05)
        break
      }
      case 'jump':
        Object.assign(o, { rootSX: 0.93, rootSY: 1.08, armLRZ: -2.1, armRRZ: 2.1, legLRX: -0.7, legRRX: -0.35, kneeL: 1.1, kneeR: 0.8, elbL: -0.4, elbR: -0.4, rootRY: d * 0.6 })
        break
      case 'fall':
        o.armLRZ = -1.8 - 0.35 * Math.sin(s * 28)
        o.armRRZ = 1.8 + 0.35 * Math.sin(s * 28 + 1)
        o.legLRX = 0.45 * Math.sin(s * 24)
        o.legRRX = -0.45 * Math.sin(s * 24)
        o.kneeL = 0.6 + 0.4 * Math.sin(s * 19)
        o.kneeR = 0.6 + 0.4 * Math.sin(s * 21 + 1)
        o.elbL = -0.5 + 0.4 * Math.sin(s * 17)
        o.elbR = -0.5 + 0.4 * Math.sin(s * 23 + 2)
        // the spin turns him about his middle (60 up), not his feet
        o.rootRZ = this.rot
        o.rootX = 60 * Math.sin(this.rot)
        o.rootY = 60 * (1 - Math.cos(this.rot))
        o.rootRY = d * 0.4
        break
      case 'land': {
        const k = Math.exp(-t * 9) * Math.cos(t * 18)
        o.rootSY = 1 - 0.14 * k
        o.rootSX = 1 + 0.12 * k
        // absorbed in the knees: thighs forward, shins back, the arms dip
        const bend = Math.max(0, k)
        Object.assign(o, { legLRX: -0.5 * bend, legRRX: -0.5 * bend, kneeL: 0.06 + 1 * bend, kneeR: 0.06 + 1 * bend, rootY: -5 * bend, elbL: -0.14 - 0.4 * bend, elbR: -0.14 - 0.4 * bend })
        lookAt(0.3, 0.3)
        break
      }
      case 'sit':
      case 'sleep': {
        const slow = this.pose === 'sleep' ? 3.4 : 1.7
        o.rootY = -24
        // thighs on the edge, shins hanging over it and swinging from the knee; turned well to the side, as
        // from the front level thighs point at us and the seat reads as standing
        o.legLRX = o.legRRX = -1.3
        o.kneeL = 1.2 + 0.3 * Math.sin((s * TAU) / slow)
        o.kneeR = 1.2 + 0.3 * Math.sin((s * TAU) / slow + Math.PI)
        Object.assign(o, { armLRZ: -0.45, armRRZ: 0.45, armLRX: -0.35, armRRX: -0.35, elbL: -0.5, elbR: -0.5, chestRX: 0.06 })
        if (this.pose === 'sleep') Object.assign(o, { headRX: 0.32, headRZ: 0.14, torsoSY: 1 + 0.025 * Math.sin((s * TAU) / 4) })
        else lookAt(0.3, 0.45)
        // lookAt set the body's turn: the side-on seat goes on top of it
        o.rootRY += 0.8 * d
        break
      }
      case 'type':
      case 'read': {
        o.rootY = -24
        o.armLK = 1
        Object.assign(o, { armLRZ: -0.1, armRRZ: 0.1, rootRY: 0.12 })
        // thighs on the edge he sits on, shins swinging off it; elbows bent to the laptop
        o.legLRX = o.legRRX = -1.3
        o.kneeL = 1.2 + 0.22 * Math.sin((s * TAU) / 1.3)
        o.kneeR = 1.2 + 0.22 * Math.sin((s * TAU) / 1.3 + 2.2)
        Object.assign(o, { elbL: -1.15, elbR: -1.15, chestRX: 0.1 })
        const k = (now - this.laptopSince) / 1000
        if (k < DRAW.fly) {
          // into the hoodie pocket, then out with the laptop
          o.armRRX = k < DRAW.reach ? -0.55 : -0.55 - 0.5 * clamp01((k - DRAW.reach) / (DRAW.fly - DRAW.reach))
          Object.assign(o, { armRRZ: -0.5, armLRX: -0.4, elbR: -0.7, headRX: 0.35, torsoRX: 0.12 })
          break
        }
        if (k < DRAW.open) {
          Object.assign(o, { armLRX: -0.45, armRRX: -0.45, headRX: 0.3 })
          break
        }
        if (this.pose === 'read') {
          // line by line: the head follows each line and steps down, the eyes run along it, a scroll now and then
          const line = (s / 1.4) % 1
          o.headRX = 0.24 + 0.025 * (Math.floor(s / 1.4) % 5)
          o.headRY = -0.12 + 0.24 * line
          o.eyeX = -0.8 + 1.6 * line
          o.armLRX = o.armRRX = -0.45
          o.elbR = s % 2.6 < 0.25 ? -1.45 : -1.15
          break
        }
        // typing with gusto: taps on a fast beat, the head bobbing to it, a hard Enter now and then, a glance at you
        const beat = (s * TAU) / 0.42
        // taps from the elbows, wrists low over the keys
        o.armLRX = o.armRRX = -0.45
        o.elbL = -1.15 + 0.18 * Math.max(0, Math.sin((s * TAU) / 0.17))
        o.elbR = -1.15 + 0.18 * Math.max(0, Math.sin((s * TAU) / 0.21 + 1))
        o.headRX = 0.26 + 0.05 * Math.sin(beat)
        o.headRZ = 0.06 * Math.sin(beat / 2)
        o.rootY = -24 + 1.4 * Math.abs(Math.sin(beat))
        o.torsoRX = 0.08 + 0.03 * Math.sin(beat)
        o.boltRZ = 0.12 * Math.sin(beat)
        const enter = s % 3.6
        if (enter > 3 && enter < 3.35) Object.assign(o, { armRRX: enter < 3.18 ? -1.2 : -0.4, elbR: enter < 3.18 ? -1.7 : -0.8, headRX: 0.1, boltS: 1.15 })
        const glance = s % 7.3
        if (glance > 6.2 && glance < 6.9) {
          Object.assign(o, { headRX: -0.08, rootRY: 0.4, chestRX: -0.04 })
          this.moment = 'happy'
        }
        break
      }
      case 'think': {
        // hand on the chin, head tilted, eyes wandering up while he works it out; now and then an idea, finger up
        const sway = Math.sin((s * TAU) / 3.4)
        const side = Math.floor(s / 2.4) % 2 ? 1 : -1
        Object.assign(o, { armRRX: -1.25, armRRZ: -0.35, elbR: -1.95, elbL: -0.5, armLRX: -0.5, armLRZ: -0.3, headRX: -0.1, headRZ: 0.16 + 0.05 * sway, rootRZ: 0.03 * sway, torsoRX: 0.04, chestRX: 0.04 })
        Object.assign(o, { eyeX: 0.6 * side, eyeY: -0.7, headRY: 0.18 * side })
        if (s % 6.5 > 5.8) {
          Object.assign(o, { boltS: 1.25, armRRX: -2.7, armRRZ: 0.15, elbR: -0.1, headRX: -0.18, eyeY: -0.3 })
          this.moment = 'happy'
        }
        break
      }
      case 'search': {
        // the magnifying glass up to his face, leaning in, sweeping slowly from side to side and shuffling along
        const sweep = Math.sin((s * TAU) / 3.2)
        Object.assign(o, { armRRX: SEARCH_ARM.x, armRRZ: SEARCH_ARM.z, elbR: 0, chestRX: 0.12, torsoRX: 0.08, headRX: 0.12, kneeL: 0.15, kneeR: 0.15 })
        Object.assign(o, { rootRY: 0.55 * sweep, headRY: 0.25 * sweep, eyeX: 0.5 * sweep })
        o.legLRX = 0.14 * Math.sin((s * TAU) / 0.8)
        o.legRRX = -o.legLRX
        break
      }
      case 'zap': {
        // a command running: he winds up, then throws the charge forward with both hands, crackling (brain adds sparks)
        o.armLK = 1
        if (t < 0.45) {
          const w = t / 0.45
          Object.assign(o, { rootSY: 1 - 0.08 * w, rootSX: 1 + 0.05 * w, armLRX: 0.35, armRRX: 0.35, torsoRX: -0.1 })
          break
        }
        const buzz = Math.sin(s * 140)
        Object.assign(o, { armLRX: -1.45 + 0.06 * buzz, armRRX: -1.45 - 0.06 * buzz, armLRZ: -0.15, armRRZ: 0.15, elbL: -0.2, elbR: -0.2, kneeL: 0.25, kneeR: 0.25, torsoRX: 0.12, headRX: 0.08 })
        o.boltS = 1 + 0.22 * Math.abs(Math.sin(s * 9))
        o.boltRZ = 0.1 * buzz
        o.rootX = 0.8 * Math.sin(s * 90)
        break
      }
      case 'scout': {
        // a hand shading his eyes, scanning the distance left and right, up on his toes now and then
        const turn = Math.sin((s * TAU) / 4)
        Object.assign(o, { armRRX: -1.9, armRRZ: -0.55, elbR: -1.3, headRX: -0.08 })
        Object.assign(o, { headRY: 0.5 * turn, rootRY: 0.25 * turn, eyeX: 0.7 * turn })
        const hop = s % 4
        o.rootY = hop < 0.3 ? 4 * Math.sin((hop / 0.3) * Math.PI) : 0
        break
      }
      case 'wave':
        o.armRRZ = 2.1
        // the forearm waves from the elbow
        o.elbR = -0.55 - 0.45 * Math.sin((s * TAU) / 0.62)
        o.headRZ = -0.1
        lookAt(0.5, 0.4)
        break
      case 'point': {
        const hop = (s % 1.2) / 1.2
        o.armRRZ = 0.85 + 0.25 * (0.5 + 0.5 * Math.sin((s * TAU) / 0.6))
        Object.assign(o, { armRRX: -0.7, armLRZ: -0.3, elbR: 0, headRX: 0.18, rootRY: d * 0.55 })
        o.rootY = hop > 0.7 && hop < 0.9 ? 7 * Math.sin(((hop - 0.7) / 0.2) * Math.PI) : 0
        break
      }
      case 'cheer': {
        const c = (s * TAU) / 0.55
        o.rootY = 22 * Math.max(0, Math.sin(c))
        o.armLRZ = -2.2 - 0.22 * Math.sin(2 * c)
        o.armRRZ = 2.2 + 0.22 * Math.sin(2 * c)
        // springing from bent knees at the bottom of each hop, arms up with soft elbows
        const crouch = Math.max(0, -Math.sin(c))
        Object.assign(o, { legLRX: 0.2 - 0.5 * crouch, legRRX: -0.2 - 0.5 * crouch, kneeL: 0.1 + 1 * crouch, kneeR: 0.1 + 1 * crouch, elbL: -0.3, elbR: -0.3 })
        break
      }
      case 'trip':
        // flat on his side after a bounce off the floor; limbs settle with the springs
        Object.assign(o, { rootRZ: 1.47 * this.side, rootX: 52 * this.side, rootY: 27 + 12 * Math.exp(-t * 5) * Math.abs(Math.cos(t * 11)), armLRZ: -1.1, legRRX: 0.6, kneeL: 0.7, kneeR: 0.35, elbL: -0.8, elbR: -0.5 })
        break
      case 'held':
        o.hangRZ = 0.05 * Math.sin((s * TAU) / 2.2)
        o.legLRX = 0.32 * Math.sin((s * TAU) / 1)
        o.legRRX = 0.32 * Math.sin((s * TAU) / 1 + Math.PI)
        // legs kicking from the knees while he dangles
        o.kneeL = 0.3 + 0.3 * Math.sin((s * TAU) / 1 + 1)
        o.kneeR = 0.3 + 0.3 * Math.sin((s * TAU) / 1 + 1 + Math.PI)
        Object.assign(o, { armLRZ: -0.5, armRRZ: 0.5, elbL: -0.45, elbR: -0.45 })
        lookAt(0.3, 0.3)
        break
    }
    // on the floor there is no edge to sit on: he slides a stool out of the composer and sits on it, feet on
    // the ground (on an edge he sits as before, legs dangling)
    if (this.onFloor && SEATED.has(this.pose)) {
      if ((now - this.stoolSince) / 1000 < 0.55) {
        // reaching into the composer beside him for it
        Object.assign(o, { rootY: 0, armLRX: -0.5, armLRZ: -0.9, armLK: 1, rootRY: -0.6, torsoRX: 0.1 })
      } else {
        // sat on the stool (seat at 15): thighs level, knees bent, feet on the floor, turned three-quarters
        o.rootY += 14
        o.rootRY = 0.8 * d
        o.legLRX = o.legRRX = -1.45
        o.kneeL = 1.45 + 0.08 * Math.sin((s * TAU) / 1.6)
        o.kneeR = 1.4 + 0.08 * Math.sin((s * TAU) / 1.6 + 2)
      }
    }
    if (now < this.blinkUntil && (this.eyes === 'open' || this.eyes === 'worried')) o.eyesSY = 0.12
    if (now < this.zapUntil) o.boltS = 1.3
    return o
  }

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick)
    const s = this.spr
    const springs = Math.abs(s.sw) + Math.abs(s.up) + Math.abs(s.hang) + Math.abs(s.swv) + Math.abs(s.upv) > 0.02
    const busy = springs || now - this.mv.at < 120 || !QUIET.has(this.pose) || now - this.since < 500 || now < this.blinkUntil + 60 || now < this.zapUntil + 200
    // at rest: 24 fps while his eyes follow something, 12 when nothing moves (breathing reads the same)
    if (!busy && now - this.drawn < 1000 / (now - this.lookedAt < 1500 ? 24 : 12)) return
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    this.drawn = now
    this.physics(dt, now)
    const goal = this.target(now)
    for (const k in goal) this.cur[k] += (goal[k] - this.cur[k]) * (1 - Math.exp(-dt * (EASE[k] ?? 22)))
    if (this.pose === 'land') Object.assign(this.cur, { rootSY: goal.rootSY, rootSX: goal.rootSX })
    // a tumble follows the spin exactly: eased, the fast turn would wobble
    if (this.pose === 'fall') Object.assign(this.cur, { rootRZ: goal.rootRZ, rootX: goal.rootX, rootY: goal.rootY })
    this.apply(now)
    this.drawGlow()
    this.renderer.render(this.scene, this.camera)
  }

  /** out of the pocket and open while there is laptop work, back into the pocket when it ends */
  private placeLaptop(now: number): void {
    const { laptop, lid } = this.j!
    const put = (k: number, open: number): void => {
      laptop.visible = true
      laptop.scale.setScalar(0.15 + 0.85 * k)
      laptop.position.set(0, POCKET.y + (LAP.y - POCKET.y) * k, POCKET.z + (LAP.z - POCKET.z) * k)
      lid.rotation.x = LID_SHUT + (LID_OPEN - LID_SHUT) * open
    }
    const out = (now - this.laptopSince) / 1000
    const away = (now - this.laptopAway) / 1000
    if (LAPTOP.has(this.pose)) {
      if (out < DRAW.reach) laptop.visible = false
      else put(easeOutBack(clamp01((out - DRAW.reach) / (DRAW.fly - DRAW.reach))), easeOutBack(clamp01((out - DRAW.fly) / (DRAW.open - DRAW.fly))))
    } else if (away < 0.3) put(1 - away / 0.3, 0)
    else laptop.visible = false
  }

  /** springs fed by how his on-screen speed changes; a throw's tumble turns on */
  private physics(dt: number, now: number): void {
    if (dt <= 0) return
    const live = now - this.mv.at < 90
    const vx = live ? this.mv.x : 0
    const vy = live ? this.mv.y : 0
    const ax = (vx - this.mv.px) / dt
    const ay = (vy - this.mv.py) / dt
    this.mv.px = vx
    this.mv.py = vy
    this.mv.speed = Math.hypot(vx, vy)
    const push = (v: number): number => Math.max(-400, Math.min(400, v))
    const step = (x: number, v: number, input: number, k: number, damp: number): [number, number] => {
      const nv = v + (-k * x - damp * v + input) * dt
      return [Math.max(-0.9, Math.min(0.9, x + nv * dt)), nv]
    }
    const s = this.spr
    ;[s.sw, s.swv] = step(s.sw, s.swv, push((-ax * this.dir) / 200), 60, 7)
    ;[s.up, s.upv] = step(s.up, s.upv, push(-ay / 200), 60, 7)
    // held by the hood: a pendulum, slower and looser
    ;[s.hang, s.hangv] = step(s.hang, s.hangv, push(-ax / 260), 22, 2.5)
    if (this.pose === 'fall') {
      this.rot += this.spin * dt
      this.spin *= Math.exp(-0.4 * dt)
    }
  }

  /** the stool he pulls out of the composer to sit on the floor */
  private placeStool(now: number): void {
    const stool = this.j!.stool
    const on = this.onFloor && SEATED.has(this.pose)
    stool.visible = on
    if (!on) return
    // slides out from the composer's side (his left on screen), then stays put
    const k = Math.min(1, (now - this.stoolSince) / 550)
    stool.position.x = -40 * Math.pow(1 - k, 3)
  }

  private apply(now: number): void {
    const c = this.cur
    const j = this.j!
    j.root.position.set(c.rootX, c.rootY, 0)
    j.root.scale.set(c.rootSX, c.rootSY, c.rootSX)
    j.root.rotation.set(0, c.rootRY, c.rootRZ)
    j.hang.rotation.z = c.hangRZ
    j.torso.rotation.x = c.torsoRX
    j.torso.scale.y = c.torsoSY
    j.head.rotation.set(c.headRX, c.headRY, c.headRZ)
    j.bolt.rotation.set(c.boltRX, 0, c.boltRZ)
    j.bolt.scale.setScalar(c.boltS)
    // his left hand lives in the hoodie pocket (as in the render): it only half follows the pose, unless at work
    // secondary motion over the pose: limbs lag the way he speeds up, a jolt throws the arms out, a fast
    // flight sets them flailing
    const { sw, up } = this.spr
    const flail = this.pose === 'fall' || this.pose === 'held' ? Math.min(1, this.mv.speed / 1200) : 0
    const t = now / 1000
    j.armL.rotation.set(c.armLRX * c.armLK + sw + 0.4 * flail * Math.sin(t * 19), 0, c.armLRZ * c.armLK - up * 0.8 - 0.3 * flail * Math.sin(t * 23))
    j.armR.rotation.set(c.armRRX + sw + 0.4 * flail * Math.sin(t * 17 + 1), 0, c.armRRZ + up * 0.8 + 0.3 * flail * Math.sin(t * 21 + 2))
    j.legL.rotation.x = c.legLRX - sw * 0.6 + 0.45 * flail * Math.sin(t * 15)
    j.legR.rotation.x = c.legRRX - sw * 0.6 - 0.45 * flail * Math.sin(t * 16 + 1)
    // knees give under a jolt, elbows flop with the swing; the left forearm follows its arm into the pocket
    const give = Math.max(0, up) * 0.9
    j.shinL.rotation.x = c.kneeL + give + 0.35 * flail * Math.sin(t * 13)
    j.shinR.rotation.x = c.kneeR + give + 0.35 * flail * Math.sin(t * 14 + 2)
    j.foreL.rotation.x = (c.elbL + sw * 0.5 - 0.3 * flail * Math.sin(t * 18)) * c.armLK
    j.foreR.rotation.x = c.elbR + sw * 0.5 - 0.3 * flail * Math.sin(t * 20 + 1)
    j.chest.rotation.x = c.chestRX + sw * 0.15
    j.head.rotation.x += sw * 0.35 + up * 0.5
    if (this.pose === 'held') j.hang.rotation.z = c.hangRZ + this.spr.hang
    this.placeStool(now)
    j.eyes.scale.y = c.eyesSY
    const eye = (v: number): number => Math.max(-1, Math.min(1, v))
    // across most of the visor: at ±2 the eyes barely moved and he seemed to turn instead of look
    j.eyes.position.x = eye(this.lookX + c.eyeX) * 6
    j.eyes.position.y = eye(this.lookY + c.eyeY) * -4.5
    const face = this.moment ?? this.eyes
    for (const [name, g] of Object.entries(j.faces)) g.visible = name === face
    this.placeLaptop(now)
    j.glass.visible = this.pose === 'search'
    const grounded = this.pose !== 'jump' && this.pose !== 'fall' && this.pose !== 'held' && this.pose !== 'dash'
    j.shadow.visible = grounded
    const m = j.shadow.material as THREE.MeshBasicMaterial
    m.opacity = this.pose === 'cheer' ? Math.max(0.25, 1 - c.rootY / 30) : 1
    j.sync()
  }
}
