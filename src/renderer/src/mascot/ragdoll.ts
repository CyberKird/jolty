import * as planck from 'planck'

/**
 * Jolty's active ragdoll, in the style of Euphoria: a physical skeleton (Box2D through planck.js, side view in
 * the screen's plane) whose joints are driven by muscles, with reflexes on top. Held by the hood he hangs and
 * kicks, thrown he flails and then braces toward what he is about to hit, hits go through his limbs, and after
 * a landing he lies dazed, then pulls himself up. Rig3D only displays it (Puppet.physics): this file knows
 * nothing about the page except rectangles to stand on.
 *
 * The simulation always faces +x: for a character facing left the screen is mirrored (sx), so limits and
 * muscle targets are written once. y is up inside, down on the screen. Lengths are the model's units (132 tall
 * with the bolt), one unit is U metres, so he is about 1.6 m tall and gravity can be the app's own.
 */
export const HIP_Y = 23.3
const PXM = 40
/** metres per model unit: 40 px per metre, and the app's gravity, both grown with his size (size.ts) so a bigger
 *  Jolty falls, tumbles and gets up in the same beats as the small one */
let U = 0.6 / PXM
/** a hand's speed in px/s, as the simulation's: flights of the same px keep their shape (v grows with the root of g) */
let VS = 1
let GRAV = 2600 / PXM
export function scaleRagdoll(px: number): void {
  U = px / PXM
  GRAV = (2600 * px) / 0.6 / PXM
  VS = Math.sqrt(px / 0.6)
}
const STEP = 1 / 120
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const V = (x: number, y: number): planck.Vec2 => planck.Vec2(x, y)

type PartName = 'pelvis' | 'torso' | 'head' | 'thighL' | 'thighR' | 'shinL' | 'shinR' | 'upperL' | 'upperR' | 'foreL' | 'foreR'
type JointName = 'spine' | 'neck' | 'hipL' | 'hipR' | 'kneeL' | 'kneeR' | 'shL' | 'shR' | 'elL' | 'elR'

interface Part {
  parent?: PartName
  /** the joint on the parent, rest pose, model units */
  joint?: [number, number]
  /** body centre at rest */
  centre: [number, number]
  /** half width and half height, and density */
  box: [number, number]
  density: number
  /** extra box (the foot) */
  foot?: { c: [number, number]; box: [number, number] }
  limits?: [number, number]
}

const PARTS: Record<PartName, Part> = {
  pelvis: { centre: [0, 26], box: [9, 5], density: 90 },
  torso: { parent: 'pelvis', joint: [0, 29], centre: [0, 43], box: [10, 14], density: 90, limits: [-0.55, 0.45] },
  head: { parent: 'torso', joint: [0, 57], centre: [0, 79], box: [16, 22], density: 70, limits: [-0.8, 0.9] },
  thighL: { parent: 'pelvis', joint: [0, HIP_Y], centre: [0, 18.8], box: [3.5, 4.5], density: 90, limits: [-0.8, 2.2] },
  thighR: { parent: 'pelvis', joint: [0, HIP_Y], centre: [0, 18.8], box: [3.5, 4.5], density: 90, limits: [-0.8, 2.2] },
  shinL: { parent: 'thighL', joint: [0, 14.4], centre: [0, 7.2], box: [4, 7.2], density: 90, foot: { c: [5, 2.5], box: [9, 2.5] }, limits: [-2.5, 0.02] },
  shinR: { parent: 'thighR', joint: [0, 14.4], centre: [0, 7.2], box: [4, 7.2], density: 90, foot: { c: [5, 2.5], box: [9, 2.5] }, limits: [-2.5, 0.02] },
  upperL: { parent: 'torso', joint: [0, 49.5], centre: [0, 44.5], box: [3, 5], density: 70, limits: [-2.8, 3.1] },
  upperR: { parent: 'torso', joint: [0, 49.5], centre: [0, 44.5], box: [3, 5], density: 70, limits: [-2.8, 3.1] },
  foreL: { parent: 'upperL', joint: [0, 39.5], centre: [0, 33.7], box: [3, 5.8], density: 70, limits: [-0.05, 2.6] },
  foreR: { parent: 'upperR', joint: [0, 39.5], centre: [0, 33.7], box: [3, 5.8], density: 70, limits: [-0.05, 2.6] }
}
const JOINT_OF: Record<JointName, PartName> = { spine: 'torso', neck: 'head', hipL: 'thighL', hipR: 'thighR', kneeL: 'shinL', kneeR: 'shinR', shL: 'upperL', shR: 'upperR', elL: 'foreL', elR: 'foreR' }

/**
 * What collides with what. Everything stands on the world; beyond that only the pairs that could really meet
 * in his body: a leg with the trunk, the head and the pelvis (a knee into the chest), a leg with the arm of its
 * own side (a hand on a knee). The two sides of him are at different depths, and the arms hang outside the
 * trunk, so those never touch; joints already keep their neighbours apart.
 */
const C = { world: 1, pelvis: 2, torso: 4, head: 8, legL: 16, legR: 32, armL: 64, armR: 128 }
const CAT: Record<PartName, number> = { pelvis: C.pelvis, torso: C.torso, head: C.head, thighL: C.legL, shinL: C.legL, thighR: C.legR, shinR: C.legR, upperL: C.armL, foreL: C.armL, upperR: C.armR, foreR: C.armR }
const MASK: Record<number, number> = {
  [C.pelvis]: C.world | C.legL | C.legR,
  [C.torso]: C.world | C.legL | C.legR,
  [C.head]: C.world | C.legL | C.legR,
  [C.legL]: C.world | C.pelvis | C.torso | C.head | C.armL,
  [C.legR]: C.world | C.pelvis | C.torso | C.head | C.armR,
  [C.armL]: C.world | C.legL,
  [C.armR]: C.world | C.legR
}
const ALL_BODY = 0xfffe

/** muscle strength, N·m: what a joint can hold against his own weight */
const S = { limp: 30, soft: 200, firm: 900, strong: 2800 }

export type RagState = 'air' | 'lie' | 'stand'

/** a platform to stand on, in screen px: its top edge is what counts */
export interface Ledge {
  key: unknown
  left: number
  right: number
  top: number
}

export interface Joints {
  spine: number
  neck: number
  hipL: number
  hipR: number
  kneeL: number
  kneeR: number
  shL: number
  shR: number
  elL: number
  elR: number
}

export interface RagPose extends Joints {
  /** pelvis on the screen, px, and its tilt (counter-clockwise on screen, radians) */
  x: number
  y: number
  tilt: number
}

export interface RagHooks {
  /** a hit: how hard (0..1+) */
  /** a hit: how hard (0..1+) and where, on the screen (px) */
  impact(strength: number, x: number, y: number): void
}

export class Ragdoll {
  readonly world: planck.World
  private bodies = {} as Record<PartName, planck.Body>
  private joints = {} as Record<JointName, planck.RevoluteJoint>
  private ground: planck.Body
  private ledges = new Map<unknown, planck.Body>()
  private walls: planck.Body[] = []
  state: RagState = 'air'
  private t = 0
  private since = 0
  private acc = 0
  private stun = 0
  private calm = 0
  private lastHit = -1
  private mass = 0
  private bounds = { w: 0, h: 0 }
  private seed = Math.random() * 6.28
  /** standing up from the ground (recovered, steadied) as opposed to knocked while on his feet */
  fresh = true

  /**
   * @param x,y pelvis on the screen (px)
   * @param dir the way he faces
   * @param start joint angles he starts in (what he was doing), sim convention
   */
  constructor(
    x: number,
    y: number,
    private dir: 1 | -1,
    private hooks: RagHooks,
    start: Partial<Joints> = {},
    vx = 0,
    vy = 0,
    tilt = 0,
    spin = 0
  ) {
    this.world = new planck.World({ gravity: V(0, -GRAV) })
    this.ground = this.world.createBody({ type: 'static' })
    const angles: Joints = { spine: 0, neck: 0, hipL: 0, hipR: 0, kneeL: 0, kneeR: 0, shL: 0.1, shR: 0.1, elL: 0.15, elR: 0.15, ...start }
    this.build(this.sx(x), this.sy(y), angles, tilt)
    for (const b of Object.values(this.bodies)) {
      b.setLinearVelocity(V((this.dir * vx * VS) / PXM, (-vy * VS) / PXM))
      b.setAngularVelocity(spin)
    }
    this.world.on('post-solve', (contact, impulse) => {
      let n = 0
      for (let i = 0; i < impulse.normalImpulses.length; i++) n += impulse.normalImpulses[i]
      // impulse relative to his weight: a landing on his feet is gentle, a face plant is not
      const s = n / (this.mass * 7)
      if (s > 0.18 && this.t - this.lastHit > 0.07) {
        this.lastHit = this.t
        // a hit takes the strength out of the muscles for a moment, the harder the longer
        this.stun = Math.max(this.stun, clamp(s * 0.5, 0.1, 0.9))
        const pt = contact.getWorldManifold(null)?.points[0]
        this.hooks.impact(s, pt ? this.px(pt.x) : 0, pt ? this.py(pt.y) : 0)
      }
    })
  }

  // -------------------------------------------------------------------------------------------
  // the screen <-> the simulation

  private sx(px: number): number {
    return (this.dir * px) / PXM
  }
  private sy(py: number): number {
    return -py / PXM
  }
  private px(x: number): number {
    return (this.dir * x) * PXM
  }
  private py(y: number): number {
    return -y * PXM
  }

  // -------------------------------------------------------------------------------------------
  // the skeleton

  /** builds every body by forward kinematics from the pelvis, so he can start in any pose */
  private build(px: number, py: number, a: Joints, tilt: number): void {
    const rest = (n: PartName): [number, number] => PARTS[n].centre
    const frames = {} as Record<PartName, { x: number; y: number; ang: number }>
    const jointOf = (n: PartName): JointName => Object.entries(JOINT_OF).find(([, p]) => p === n)![0] as JointName
    const pelvisC = rest('pelvis')
    // world position of a rest point (model units) given a frame that carries it
    const place = (f: { x: number; y: number; ang: number }, from: [number, number], p: [number, number]): [number, number] => {
      const dx = (p[0] - from[0]) * U
      const dy = (p[1] - from[1]) * U
      return [f.x + dx * Math.cos(f.ang) - dy * Math.sin(f.ang), f.y + dx * Math.sin(f.ang) + dy * Math.cos(f.ang)]
    }
    // the pelvis centre is where px,py says the hip joint is; the body hangs on it
    const hip = HIP_Y
    const pf = { x: px - (pelvisC[0] - 0) * U * 0, y: py + (pelvisC[1] - hip) * U * Math.cos(tilt), ang: tilt }
    pf.x = px - (pelvisC[1] - hip) * U * Math.sin(tilt)
    frames.pelvis = pf
    const order: PartName[] = ['pelvis', 'torso', 'head', 'thighL', 'thighR', 'shinL', 'shinR', 'upperL', 'upperR', 'foreL', 'foreR']
    for (const n of order) {
      const part = PARTS[n]
      if (!part.parent) continue
      const pf2 = frames[part.parent]
      const j = part.joint!
      const jp = place(pf2, rest(part.parent), j)
      const ang = pf2.ang + a[jointOf(n)]
      // the body's centre relative to its joint, turned by its own angle
      const c = place({ x: jp[0], y: jp[1], ang }, j, part.centre)
      frames[n] = { x: c[0], y: c[1], ang }
    }
    for (const n of order) {
      const part = PARTS[n]
      const f = frames[n]
      const body = this.world.createBody({ type: 'dynamic', position: V(f.x, f.y), angle: f.ang, allowSleep: false, linearDamping: 0, angularDamping: 0.15 })
      const fix = { density: part.density, friction: 0.9, restitution: 0.12, filterCategoryBits: CAT[n], filterMaskBits: MASK[CAT[n]] }
      body.createFixture(planck.Box(part.box[0] * U, part.box[1] * U), fix)
      if (part.foot) body.createFixture(planck.Box(part.foot.box[0] * U, part.foot.box[1] * U, V((part.foot.c[0] - part.centre[0]) * U, (part.foot.c[1] - part.centre[1]) * U), 0), fix)
      this.bodies[n] = body
      this.mass += body.getMass()
    }
    for (const [jn, pn] of Object.entries(JOINT_OF) as [JointName, PartName][]) {
      const part = PARTS[pn]
      const jp = place(frames[part.parent!], rest(part.parent!), part.joint!)
      const def: planck.RevoluteJointOpt = {
        enableLimit: true,
        lowerAngle: part.limits![0],
        upperAngle: part.limits![1],
        enableMotor: true,
        maxMotorTorque: S.limp,
        motorSpeed: 0
      }
      this.joints[jn] = this.world.createJoint(planck.RevoluteJoint(def, this.bodies[part.parent!], this.bodies[pn], V(jp[0], jp[1])))!
    }
  }

  /** the angle of a body in the world */
  private ang(n: PartName): number {
    // wrapped: after being spun around by the cursor a body can be turns over, and every "toward upright" below
    // would then try to undo the turns (he lay stuck on the floor)
    const a = this.bodies[n].getAngle()
    return Math.atan2(Math.sin(a), Math.cos(a))
  }

  /**
   * Asks a joint to put its body at an angle in the WORLD (a thigh hanging straight down whatever the pelvis
   * does is 0), with a strength. This is what keeps him standing, braced or reaching while the body turns.
   */
  private aimWorld(j: JointName, world: number, strength: number, speed = 11, gain = 16): void {
    const rev = this.joints[j]
    const parent = PARTS[JOINT_OF[j]].parent!
    const want = clamp(world - this.ang(parent), PARTS[JOINT_OF[j]].limits![0], PARTS[JOINT_OF[j]].limits![1])
    const have = rev.getJointAngle()
    rev.setMotorSpeed(clamp(gain * (want - have), -speed, speed))
    rev.setMaxMotorTorque(strength)
  }
  /** the same in the parent's frame */
  private aimRel(j: JointName, rel: number, strength: number, speed = 11, gain = 16): void {
    const rev = this.joints[j]
    const lim = PARTS[JOINT_OF[j]].limits!
    rev.setMotorSpeed(clamp(gain * (clamp(rel, lim[0], lim[1]) - rev.getJointAngle()), -speed, speed))
    rev.setMaxMotorTorque(strength)
  }
  /** a limb's world angle that points it along a direction (limbs rest pointing down) */
  private static pointing(dx: number, dy: number): number {
    return Math.atan2(dx, -dy)
  }

  // -------------------------------------------------------------------------------------------
  // the world around him

  /** the window and the platforms (screen px); call again whenever they move */
  setWorld(w: number, h: number, ledges: Ledge[], ceiling = 40): void {
    if (this.bounds.w !== w || this.bounds.h !== h) {
      for (const b of this.walls) this.world.destroyBody(b)
      this.walls = []
      const wall = (cx: number, cy: number, hx: number, hy: number): void => {
        const b = this.world.createBody({ type: 'static', position: V(this.sx(cx), this.sy(cy)) })
        b.createFixture(planck.Box(hx / PXM, hy / PXM), { friction: 0.9, restitution: 0.15, filterCategoryBits: 1, filterMaskBits: ALL_BODY })
        this.walls.push(b)
      }
      // floor (its top is the window's bottom edge), ceiling (under the title bar), two walls
      wall(w / 2, h + 30, w, 30)
      wall(w / 2, ceiling - 30, w, 30)
      wall(-30, h / 2, 30, h)
      wall(w + 30, h / 2, 30, h)
      this.bounds = { w, h }
    }
    const seen = new Set<unknown>()
    for (const l of ledges) {
      seen.add(l.key)
      const cx = (l.left + l.right) / 2
      const hw = (l.right - l.left) / 2
      let b = this.ledges.get(l.key)
      const pos = V(this.sx(cx), this.sy(l.top + 4))
      if (!b) {
        b = this.world.createBody({ type: 'static', position: pos })
        b.createFixture(planck.Box(hw / PXM, 4 / PXM), { friction: 0.9, restitution: 0.12, filterCategoryBits: 1, filterMaskBits: ALL_BODY })
        ;(b as unknown as { hw: number }).hw = hw
        this.ledges.set(l.key, b)
      } else {
        b.setPosition(pos)
        // the width of a platform changes when the window does: rebuilt then
        if (Math.abs((b as unknown as { hw: number }).hw - hw) > 1) {
          this.world.destroyBody(b)
          this.ledges.delete(l.key)
          return this.setWorld(w, h, ledges, ceiling)
        }
      }
    }
    for (const [k, b] of this.ledges) {
      if (seen.has(k)) continue
      this.world.destroyBody(b)
      this.ledges.delete(k)
    }
  }

  /** a shove at the torso (px/s): he staggers or goes down */
  shove(vx: number, vy = 0): void {
    for (const n of ['torso', 'head', 'pelvis'] as PartName[]) {
      const b = this.bodies[n]
      b.setLinearVelocity(b.getLinearVelocity().add(V((this.dir * vx * VS) / PXM, (-vy * VS) / PXM)))
    }
    // the upper body goes first: he leans into it
    this.bodies.torso.setAngularVelocity(this.bodies.torso.getAngularVelocity() - Math.sign(this.dir * vx) * 2)
    this.stun = Math.max(this.stun, 0.25)
  }

  // -------------------------------------------------------------------------------------------
  // the muscles and reflexes

  private com(): { x: number; y: number; vx: number; vy: number } {
    let x = 0
    let y = 0
    let vx = 0
    let vy = 0
    for (const b of Object.values(this.bodies)) {
      const m = b.getMass()
      const p = b.getWorldCenter()
      const v = b.getLinearVelocity()
      x += p.x * m
      y += p.y * m
      vx += v.x * m
      vy += v.y * m
    }
    return { x: x / this.mass, y: y / this.mass, vx: vx / this.mass, vy: vy / this.mass }
  }

  /** how upright the torso is: 0 upright, ±1.57 lying (positive: on his back) */
  private lean(): number {
    return this.ang('pelvis') * 0.4 + this.ang('torso') * 0.6
  }

  /** the lowest point of the feet is on something */
  private feetDown(): boolean {
    for (const n of ['shinL', 'shinR'] as PartName[]) {
      for (let c = this.bodies[n].getContactList(); c; c = c.next ?? null) {
        if (c.contact.isTouching()) return true
      }
    }
    return false
  }

  /** anything of him in contact with the world */
  private touching(n: PartName): boolean {
    for (let c = this.bodies[n].getContactList(); c; c = c.next ?? null) if (c.contact.isTouching()) return true
    return false
  }

  /** how high the pelvis is above whatever is under it (m) */
  private groundHeight(): number {
    const p = this.bodies.pelvis.getPosition()
    let d = 4
    this.world.rayCast(p, V(p.x, p.y - 4), (fixture, _pt, _n, fraction) => {
      if (fixture.getFilterCategoryBits() !== 1) return -1
      d = Math.min(d, fraction * 4)
      return fraction
    })
    return d
  }

  /** time to the next surface along his motion, s (Infinity when nothing is near) */
  private toImpact(): { t: number; dx: number; dy: number } {
    const c = this.com()
    const speed = Math.hypot(c.vx, c.vy)
    if (speed < 2) return { t: Infinity, dx: 0, dy: -1 }
    const dx = c.vx / speed
    const dy = c.vy / speed
    const reach = Math.min(speed * 0.45, 6)
    let hit = Infinity
    this.world.rayCast(V(c.x, c.y), V(c.x + dx * reach, c.y + dy * reach), (fixture, _p, _n, fraction) => {
      if (fixture.getFilterCategoryBits() !== 1) return -1
      hit = Math.min(hit, fraction * reach)
      return fraction
    })
    return { t: hit / speed, dx, dy }
  }

  private control(dt: number): void {
    const stun = this.stun > 0
    const t = this.t
    const k = stun ? 0.12 : 1
    const c = this.com()
    switch (this.state) {
      case 'air': {
        const hit = this.toImpact()
        const bracing = hit.t < 0.3 && this.t - this.since > 0.12
        if (bracing) {
          // a surface ahead: the arms reach for it, the head tucks, the legs lead (a feet-first or hands-first landing)
          const a = Ragdoll.pointing(hit.dx, hit.dy)
          const f = 1 - clamp(hit.t / 0.3, 0, 1) * 0.4
          this.aimWorld('shL', a, S.firm * k * f, 14)
          this.aimWorld('shR', a, S.firm * k * f, 14)
          this.aimRel('elL', 0.3, S.soft * k)
          this.aimRel('elR', 0.3, S.soft * k)
          this.aimRel('neck', -0.7, S.firm * k)
          this.aimRel('spine', -0.25, S.soft * k)
          this.aimWorld('hipL', a, S.firm * k, 12)
          this.aimWorld('hipR', a, S.firm * k, 12)
          this.aimRel('kneeL', -0.5, S.soft * k)
          this.aimRel('kneeR', -0.5, S.soft * k)
        } else {
          // flailing: everything loose, the arms out and wheeling
          const s = this.seed
          this.aimWorld('shL', 2.3 + 0.9 * Math.sin(t * 13 + s), S.soft * 0.5 * k, 9)
          this.aimWorld('shR', 2.3 + 0.9 * Math.sin(t * 11 + s + 2), S.soft * 0.5 * k, 9)
          this.aimRel('elL', 0.6 + 0.5 * Math.sin(t * 17 + s), S.soft * 0.3 * k)
          this.aimRel('elR', 0.6 + 0.5 * Math.sin(t * 15 + s + 1), S.soft * 0.3 * k)
          this.aimWorld('hipL', 0.8 + 0.7 * Math.sin(t * 12 + s), S.soft * 0.4 * k, 9)
          this.aimWorld('hipR', 0.8 - 0.7 * Math.sin(t * 12 + s), S.soft * 0.4 * k, 9)
          this.aimRel('kneeL', -0.8 - 0.5 * Math.sin(t * 9 + s), S.soft * 0.3 * k)
          this.aimRel('kneeR', -0.8 + 0.5 * Math.sin(t * 9 + s), S.soft * 0.3 * k)
          this.aimRel('spine', 0, S.soft * 0.3 * k)
          this.aimRel('neck', 0, S.soft * 0.3 * k)
        }
        // down and quiet: lying
        const speed = Math.hypot(c.vx, c.vy)
        if (speed < 0.5 && this.touching('pelvis') || (speed < 0.35 && this.feetDown() && Math.abs(this.lean()) > 0.9)) {
          this.calm += dt
          if (this.calm > 0.25) this.go('lie')
        } else if (speed < 0.5 && this.feetDown() && Math.abs(this.lean()) < 0.5) {
          // landed on his feet and standing
          this.calm += dt
          if (this.calm > 0.2) this.go('stand')
        } else this.calm = 0
        break
      }
      case 'lie': {
        // dazed: loose and slowly stirring, then he decides to get up
        this.eachLimp(0.25)
        break
      }
      case 'stand': {
        // the muscles take up the load gradually: snapped straight at once they would throw the body over
        this.balance(c, k * (0.2 + 0.8 * clamp((t - this.since) / 0.5, 0, 1)))
        break
      }
    }
  }

  /** every joint loose, with a little tone */
  private eachLimp(tone: number): void {
    for (const j of Object.keys(JOINT_OF) as JointName[]) this.aimRel(j, this.joints[j].getJointAngle(), S.limp * tone, 0, 0)
  }

  /**
   * The restoring push (see balance): a push at the head and the opposite one on the feet, as hard as the lean
   * calls for up to a cap. settle 0..1 is how much extra help he still has (just up from the ground).
   */
  private assist(c: { x: number; y: number; vx: number; vy: number }, k: number, age: number): { phi: number; reach: number } {
    const l = this.bodies.shinL.getPosition()
    const r = this.bodies.shinR.getPosition()
    const fx = (l.x + r.x) / 2
    const fy = Math.min(l.y, r.y)
    const h = Math.max(0.3, c.y - fy)
    const phi = Math.atan2(c.x - fx, h)
    const dphi = c.vx / h
    const g = GRAV
    const reach = Math.abs(phi)
    // the help fades out as the lean grows past what ankles could do
    const fade = 1 - clamp((reach - 0.3) / 0.25, 0, 1)
    // just up from the ground he is still held up a little, the help fading over a second
    const settle = clamp(1 - age, 0, 1)
    if (settle > 0) {
      this.bodies.torso.applyForceToCenter(V(0, this.mass * g * 0.35 * settle), true)
      this.bodies.pelvis.applyForceToCenter(V(0, this.mass * g * 0.15 * settle), true)
    }
    const cap = (0.5 + 0.5 * settle) * (this.fresh ? 1 : 0.7)
    const push = clamp(1.7 * phi + 0.5 * dphi, -cap, cap) * this.mass * g * fade * k
    this.bodies.head.applyForceToCenter(V(-push, 0), true)
    this.bodies.shinL.applyForceToCenter(V(push / 2, 0), true)
    this.bodies.shinR.applyForceToCenter(V(push / 2, 0), true)
    return { phi, reach }
  }

  /**
   * Standing: a post on the feet with a heavy head, so ankles alone cannot hold it. A restoring push at the
   * head, with the opposite one on the feet (so he is not shoved along), plays the part of the ankles and the
   * trunk's sway; it is capped, so a hard shove still sends him over. Past a lean the arms wheel and a leg
   * steps under the weight.
   */
  private balance(c: { x: number; y: number; vx: number; vy: number }, k: number): void {
    const t = this.t
    const { phi, reach } = this.assist(c, k, (t - this.since) / 1.2)
    const side = Math.sign(phi) || 1
    // legs straight and strong, the trunk stacked on the pelvis, whatever the lean
    this.aimWorld('hipL', 0, S.strong * k)
    this.aimWorld('hipR', 0, S.strong * k)
    this.aimRel('kneeL', 0, S.strong * k)
    this.aimRel('kneeR', 0, S.strong * k)
    this.aimRel('spine', 0, S.strong * k)
    this.aimWorld('neck', 0, S.strong * k)
    if (reach > 0.14) {
      // off balance: the arms wheel
      const w = Math.sin(t * 15)
      this.aimWorld('shL', 2.3 * side + 0.8 * w, S.firm * k, 14)
      this.aimWorld('shR', 2.3 * side - 0.8 * w, S.firm * k, 14)
      this.aimRel('elL', 0.5, S.soft * k)
      this.aimRel('elR', 0.5, S.soft * k)
    } else {
      this.aimWorld('shL', 0.15, S.soft * k)
      this.aimWorld('shR', 0.15, S.soft * k)
      this.aimRel('elL', 0.2, S.soft * k)
      this.aimRel('elR', 0.2, S.soft * k)
    }
    // the pelvis is kept level, or it rolls over the hips like a ball
    this.bodies.pelvis.applyTorque(-this.ang('pelvis') * 450 * k, true)
    if ((t - this.since) / 1.2 > 0.7 && (reach > 0.75 || Math.abs(this.lean()) > 1.0)) this.go('lie')
  }

  private go(s: RagState): void {
    if (this.state === s) return
    this.state = s
    this.since = this.t
    this.calm = 0
  }

  // -------------------------------------------------------------------------------------------
  // stepping

  step(dt: number): void {
    this.acc += Math.min(dt, 0.05)
    while (this.acc >= STEP) {
      this.acc -= STEP
      this.t += STEP
      this.stun = Math.max(0, this.stun - STEP)
      this.control(STEP)
      this.world.step(STEP, 8, 3)
    }
  }

  /**
   * On his feet and steady enough to be handed back to the animation, which takes over from wherever the
   * joints are (it blends in a moment): up from the ground with the legs under him, or settled after a knock.
   */
  get up(): boolean {
    const c = this.com()
    const speed = Math.hypot(c.vx, c.vy)
    const e = this.t - this.since
    if (this.state !== 'stand') return false
    return e > 0.45 && Math.abs(this.lean()) < 0.25 && speed < 0.5 && this.feetDown()
  }

  /** the pose to draw */
  pose(): RagPose {
    const p = this.bodies.pelvis
    const hip = p.getWorldPoint(V(0, (HIP_Y - PARTS.pelvis.centre[1]) * U))
    const rel = (j: JointName): number => this.joints[j].getJointAngle()
    return {
      x: this.px(hip.x),
      y: this.py(hip.y),
      // on the screen a mirrored (left-facing) body turns the other way
      tilt: this.dir * Math.atan2(Math.sin(p.getAngle()), Math.cos(p.getAngle())),
      spine: rel('spine'),
      neck: rel('neck'),
      hipL: rel('hipL'),
      hipR: rel('hipR'),
      kneeL: rel('kneeL'),
      kneeR: rel('kneeR'),
      shL: rel('shL'),
      shR: rel('shR'),
      elL: rel('elL'),
      elR: rel('elR')
    }
  }

  /** the lowest point of his feet on the screen (px), for putting him down on a floor */
  feetY(): number {
    let low = -Infinity
    for (const n of ['shinL', 'shinR'] as PartName[]) low = Math.max(low, this.py(this.bodies[n].getWorldPoint(V(0, -PARTS[n].box[1] * U)).y))
    return low
  }

  /**
   * Lying and quiet for a moment (or tumbling for far too long, which is a stuck pile): time to hand him to the
   * animation, which gets him up by keyframes. Not the physics, that was never reliable at it.
   */
  get down(): boolean {
    const c = this.com()
    const quiet = Math.hypot(c.vx, c.vy) < 0.6
    return (this.state === 'lie' && this.t - this.since > 0.7 && quiet) || (this.t > 7 && quiet)
  }

  /** px from the pelvis to what is under it, straight down */
  groundGap(): number {
    return this.groundHeight() * PXM
  }

  destroy(): void {
    // the world is dropped with the object; nothing outside holds on to it
  }
}
