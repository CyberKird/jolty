import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

/**
 * Jolty's right hand: a black glove with every finger on its own joints (three phalanges for the fingers, two and
 * a tip for the thumb), driven by a handful of shapes that ease into each other, and a little life on top (the
 * fingers breathe, tap when he types, flutter when he is held). Built in the hand's own frame: the wrist is the
 * origin, the fingers hang along -y, the palm faces -x (toward the body, for the right hand), the thumb is on +z.
 */
export type HandShape = 'relaxed' | 'open' | 'fist' | 'point' | 'thumbsup' | 'claw' | 'flat'

/** per finger [base, middle, tip] curl, in radians (0 straight), and the sideways spread of the base */
interface Shape {
  curl: [number, number, number][]
  spread: number[]
  /** the thumb: swing away from the palm (toward +z), and its two curls */
  thumb: { abduct: number; curl: [number, number, number] }
}

const F = (a: number, b: number, c: number): [number, number, number] => [a, b, c]
const SHAPES: Record<HandShape, Shape> = {
  relaxed: { curl: [F(0.35, 0.45, 0.3), F(0.3, 0.5, 0.3), F(0.38, 0.55, 0.35), F(0.45, 0.6, 0.4)], spread: [0.04, 0, -0.03, -0.07], thumb: { abduct: 0.5, curl: F(0.15, 0.25, 0.15) } },
  open: { curl: [F(0.04, 0.02, 0), F(0.02, 0.02, 0), F(0.04, 0.02, 0), F(0.06, 0.03, 0)], spread: [0.2, 0.05, -0.08, -0.22], thumb: { abduct: 0.95, curl: F(0, 0, 0) } },
  flat: { curl: [F(0, 0, 0), F(0, 0, 0), F(0, 0, 0), F(0, 0, 0)], spread: [0, 0, 0, 0], thumb: { abduct: 0.3, curl: F(0, 0, 0) } },
  fist: { curl: [F(1.45, 1.55, 1), F(1.5, 1.6, 1), F(1.5, 1.6, 1), F(1.45, 1.55, 1)], spread: [0, 0, 0, 0], thumb: { abduct: 0.1, curl: F(0.7, 0.9, 0.5) } },
  point: { curl: [F(0, 0, 0), F(1.5, 1.6, 1), F(1.5, 1.6, 1), F(1.45, 1.55, 1)], spread: [0.04, 0, 0, 0], thumb: { abduct: 0.3, curl: F(0.65, 0.85, 0.5) } },
  thumbsup: { curl: [F(1.45, 1.55, 1), F(1.5, 1.6, 1), F(1.5, 1.6, 1), F(1.45, 1.55, 1)], spread: [0, 0, 0, 0], thumb: { abduct: 1.5, curl: F(-0.1, 0, 0) } },
  claw: { curl: [F(0.55, 0.7, 0.5), F(0.6, 0.75, 0.5), F(0.6, 0.75, 0.5), F(0.55, 0.7, 0.5)], spread: [0.15, 0.04, -0.06, -0.18], thumb: { abduct: 0.8, curl: F(0.3, 0.4, 0.3) } }
}

// length of each phalanx, index to pinky, and the thumb
const LEN: [number, number, number][] = [
  [1.7, 1.3, 1.05],
  [1.85, 1.45, 1.1],
  [1.7, 1.3, 1.05],
  [1.35, 1.05, 0.9]
]
const THUMB: [number, number, number] = [1.5, 1.2, 1]
const ZS = [2.2, 0.73, -0.73, -2.2]
const PALM = { w: 6, h: 4, t: 4.2 }

interface Digit {
  base: THREE.Group
  mid: THREE.Group
  tip: THREE.Group
}

export class Hand {
  readonly group = new THREE.Group()
  private fingers: Digit[] = []
  private thumb: Digit
  /** eased values: per finger 3 curls + spread (index..pinky), then the thumb's abduct and 3 curls */
  private cur = new Float32Array(4 * 4 + 4)
  private mat: THREE.MeshStandardMaterial

  /** side: 1 for a hand whose palm faces -x (right), -1 mirrored */
  constructor(private side: 1 | -1 = 1) {
    this.mat = new THREE.MeshStandardMaterial({ color: '#2b2d35', roughness: 0.5, metalness: 0.05, emissive: '#101116' })
    const cuff = new THREE.MeshStandardMaterial({ color: '#202228', roughness: 0.85, metalness: 0 })
    const g = this.group
    // the wrist: a short rib cuff closing the sleeve
    const wrist = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.5, 1.4, 20), cuff)
    wrist.position.y = 0.1
    wrist.scale.z = 1.06
    g.add(wrist)
    // the hand itself a little oversized, as a chibi's is: it has to read at his size
    const hand = new THREE.Group()
    hand.scale.setScalar(1.7)
    hand.position.y = 0.4
    g.add(hand)
    const palm = new THREE.Mesh(new RoundedBoxGeometry(PALM.t, PALM.h, PALM.w, 3, 1.1), this.mat)
    palm.position.y = -PALM.h / 2 - 0.2
    hand.add(palm)
    for (let i = 0; i < 4; i++) {
      const root = new THREE.Group()
      root.position.set(0, -PALM.h - 0.05, ZS[i])
      hand.add(root)
      this.fingers.push(this.digit(root, LEN[i], 0.74 - i * 0.02))
    }
    const troot = new THREE.Group()
    troot.position.set(-0.3 * this.side, -1.4, PALM.w / 2 - 0.4)
    hand.add(troot)
    this.thumb = this.digit(troot, THUMB, 0.88)
  }

  /** three phalanges as capsules hanging from joints, each joint a group the curl turns */
  private digit(root: THREE.Group, len: [number, number, number], r: number): Digit {
    const seg = (parent: THREE.Group, l: number, rr: number): void => {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(rr, Math.max(0.01, l - rr * 1.2), 4, 10), this.mat)
      m.position.y = -l / 2
      parent.add(m)
    }
    const base = root
    seg(base, len[0], r)
    const mid = new THREE.Group()
    mid.position.y = -len[0]
    base.add(mid)
    seg(mid, len[1], r * 0.96)
    const tip = new THREE.Group()
    tip.position.y = -len[1]
    mid.add(tip)
    seg(tip, len[2], r * 0.9)
    return { base, mid, tip }
  }

  /**
   * Eases toward a shape. `time` runs the small life on top: `tap` is how much the fingers type (0..1), `flutter`
   * how much they flap loosely (held, falling).
   */
  update(shape: HandShape, dt: number, time: number, tap = 0, flutter = 0): void {
    const s = SHAPES[shape]
    const k = 1 - Math.exp(-dt * 16)
    const c = this.cur
    const sgn = -this.side
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) c[i * 4 + j] += (s.curl[i][j] - c[i * 4 + j]) * k
      c[i * 4 + 3] += (s.spread[i] - c[i * 4 + 3]) * k
    }
    c[16] += (s.thumb.abduct - c[16]) * k
    for (let j = 0; j < 3; j++) c[17 + j] += (s.thumb.curl[j] - c[17 + j]) * k
    for (let i = 0; i < 4; i++) {
      // life: a slow breath in every finger, a tap when typing, a loose flap when flung about
      const breath = 0.04 * Math.sin(time * 1.7 + i * 0.9)
      const tapping = tap * Math.max(0, Math.sin(time * 17 + i * 2.1)) * 0.45
      const flap = flutter * 0.35 * Math.sin(time * 13 + i * 1.3)
      const d = this.fingers[i]
      const base = c[i * 4] + breath + tapping + flap
      d.base.rotation.set(-c[i * 4 + 3], 0, sgn * base)
      d.mid.rotation.z = sgn * (c[i * 4 + 1] + breath * 0.6 + tapping * 0.5 + flap * 0.7)
      d.tip.rotation.z = sgn * (c[i * 4 + 2] + tapping * 0.3 + flap * 0.5)
    }
    const t = this.thumb
    t.base.rotation.set(-c[16], 0, sgn * (c[17] + 0.03 * Math.sin(time * 1.3)))
    t.mid.rotation.z = sgn * c[18]
    t.tip.rotation.z = sgn * c[19]
  }

  /** a hand put straight into a shape, no easing (for the first frame) */
  snap(shape: HandShape): void {
    this.update(shape, 10, 0)
  }
}
