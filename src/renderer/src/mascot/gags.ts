import type { Pose } from './places'

type T = Record<string, number>
const TAU = Math.PI * 2

/** poses that are only a gag: a few seconds of body language built from the same joints as the others */
export const GAGS = new Set<Pose>(['scratch', 'facepalm', 'dance', 'fight', 'push', 'tired', 'tickle'])

/**
 * The joints for a gag pose: t seconds into it, s the clock, d the way he faces. Writes over the resting values in o.
 * Same conventions as Rig3D's target(): arm X negative lifts it forward, arm Z positive out to the side, elbows
 * negative bend, thighs negative go forward, knees positive fold back, torso/head X positive lean forward/down.
 */
export function gagTarget(pose: Pose, t: number, s: number, d: number, o: T): void {
  switch (pose) {
    case 'scratch': {
      // the hand up at the back of the head, scrubbing; the head leans into it, the eyes roll up
      const scrub = Math.sin(s * 22)
      Object.assign(o, { armRRX: -0.3, armRRZ: 1.85, elbR: -0.15, foreRZ: 1.95 + 0.3 * scrub, headRZ: 0.16, headRX: -0.05, headRY: 0.12 * d, eyeX: 0.5 * d, eyeY: -0.7 })
      o.torsoRX = 0.03
      o.boltRZ = 0.1 * scrub
      break
    }
    case 'facepalm': {
      // "oh no": a flat hand slapped to the side of the hood (his short arms do not reach the visor), the head
      // dropping into a slow shake, the shoulders sagging
      const u = 1
      Object.assign(o, { armRRX: -0.3 * u, armRRZ: 1.85 * u, elbR: -0.15, foreRZ: 1.95 * u, headRX: 0.22 * u, headRZ: 0.12 * u, torsoRX: 0.12 * u, chestRX: 0.08 * u, headRY: 0.16 * Math.sin(t * 5) * u, rootY: -1.5 * u, kneeL: 0.12, kneeR: 0.12, eyeY: 0.5 })
      break
    }
    case 'dance': {
      // a bounce on the beat, hips twisting, one arm up and the other down, swapping
      const b = (s * TAU) / 0.5
      Object.assign(o, {
        rootY: 3.5 * Math.abs(Math.sin(b)), rootRY: d * 0.7 + 0.35 * Math.sin(b / 2), rootRZ: 0.07 * Math.sin(b / 2),
        armLK: 1, armRRZ: 1.6 + 0.7 * Math.sin(b / 2), armLRZ: -(1.6 - 0.7 * Math.sin(b / 2)), elbL: -0.5, elbR: -0.5,
        legLRX: 0.25 * Math.sin(b / 2), legRRX: -0.25 * Math.sin(b / 2),
        kneeL: 0.25 + 0.35 * Math.max(0, Math.sin(b)), kneeR: 0.25 + 0.35 * Math.max(0, -Math.sin(b)),
        headRZ: 0.12 * Math.sin(b / 2), boltRZ: 0.22 * Math.sin(b), torsoRX: 0.05
      })
      break
    }
    case 'fight': {
      // shadow-boxing: side-on, fists up, a jab from each arm in turn, bobbing on bent knees
      const c = (s * TAU) / 0.55
      const right = Math.pow(Math.max(0, Math.sin(c)), 2)
      const left = Math.pow(Math.max(0, -Math.sin(c)), 2)
      Object.assign(o, {
        rootRY: d * 0.5, armLK: 1,
        armRRX: -1.1 - 0.45 * right, elbR: -1.85 + 1.7 * right, armLRX: -1.1 - 0.45 * left, elbL: -1.85 + 1.7 * left,
        armRRZ: 0.15, armLRZ: -0.15, legLRX: -0.28, legRRX: 0.22, kneeL: 0.5, kneeR: 0.55,
        torsoRX: 0.12 + 0.05 * (right + left), headRX: 0.1, rootY: -2 + 1.5 * Math.abs(Math.sin(c)), rootRZ: 0.04 * Math.sin(c)
      })
      break
    }
    case 'push': {
      // against a wall that is not there: arms straight out, leaning in, the feet shuffling
      const shove = Math.sin(s * 8)
      Object.assign(o, {
        rootRY: d * 1.15, armLK: 1, armLRX: -1.4, armRRX: -1.4, elbL: -0.12, elbR: -0.12,
        torsoRX: 0.2 + 0.03 * shove, chestRX: 0.15, headRX: 0.1, legLRX: -0.3 + 0.12 * shove, legRRX: 0.35 - 0.12 * shove, kneeL: 0.2, kneeR: 0.45, rootY: -1.5
      })
      break
    }
    case 'tired': {
      // out of breath: bent over, hands on his knees, shoulders heaving, head hanging
      const pant = Math.sin(s * 9)
      Object.assign(o, {
        rootRY: d * 0.9, armLK: 1, armLRX: -0.75, armRRX: -0.75, elbL: -0.2, elbR: -0.2, armLRZ: -0.15, armRRZ: 0.15,
        torsoRX: 0.4 + 0.03 * pant, chestRX: 0.12, headRX: 0.2, legLRX: -0.28, legRRX: -0.2, kneeL: 0.45, kneeR: 0.4, rootY: -4, torsoSY: 1 + 0.02 * pant
      })
      break
    }
    case 'tickle': {
      // laughing and squirming, arms flapping in, knees going
      const sq = Math.sin(s * 26)
      Object.assign(o, {
        rootRZ: 0.1 * sq, rootY: 2 * Math.abs(Math.sin(s * 13)), armLK: 1, armLRZ: -0.9 + 0.3 * Math.sin(s * 20), armRRZ: 0.9 + 0.3 * Math.sin(s * 22),
        elbL: -0.9, elbR: -0.9, torsoRX: 0.25, headRX: -0.12, headRZ: 0.15 * sq, kneeL: 0.3 + 0.15 * sq, kneeR: 0.3 - 0.15 * sq
      })
      break
    }
  }
}
