// What a phone decodes, as it says when it starts the screen (remote/screen-video.ts videoCaps), and the H.264 profile
// and level the PC encodes so that every phone watching can play it. A low-end Android decoder may stop at Baseline or
// 720p; Safari decodes High. Pure: checked at the boundary, used by remote-screen.ts.
import { LADDER } from './remote-screen-adapt'

export type Profile = 'high' | 'main' | 'baseline'

export interface PhoneCaps {
  profiles: Profile[]
  maxEdge: number
  maxFps: number
}

const PROFILES: Profile[] = ['high', 'main', 'baseline']
/** a phone that says nothing (an older page) is taken to play what the PC sent before: High, 1080p60 */
export const ANY_PHONE: PhoneCaps = { profiles: [...PROFILES], maxEdge: 1920, maxFps: 60 }

/** The caps a phone sent, checked: unknown profiles dropped, numbers kept in range. */
export function parseCaps(v: unknown): PhoneCaps | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const profiles = Array.isArray(o.profiles) ? PROFILES.filter((p) => (o.profiles as unknown[]).includes(p)) : []
  const n = (x: unknown, lo: number, hi: number, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d)
  if (!profiles.length) return undefined
  return { profiles, maxEdge: n(o.maxEdge, 320, 1920, 1920), maxFps: n(o.maxFps, 1, 60, 60) }
}

/** The best profile every phone in the list decodes (Constrained Baseline when they share nothing better). */
export function commonProfile(list: Array<PhoneCaps | undefined>): Profile {
  return PROFILES.find((p) => list.every((c) => (c ?? ANY_PHONE).profiles.includes(p))) ?? 'baseline'
}

/** The best step of the ladder this phone plays: a floor for its controller. */
export function capsFloor(c: PhoneCaps | undefined): number {
  if (!c) return 0
  const i = LADDER.findIndex((s) => s.edge <= c.maxEdge && s.fps <= c.maxFps)
  return i < 0 ? LADDER.length - 1 : i
}

// levels: [name, idc, max macroblocks per picture, max macroblocks per second]
const LEVELS: Array<[string, number, number, number]> = [
  ['3.0', 30, 1620, 40_500],
  ['3.1', 31, 3600, 108_000],
  ['3.2', 32, 5120, 216_000],
  ['4.0', 40, 8192, 245_760],
  ['4.2', 42, 8704, 522_240],
  ['5.1', 51, 36_864, 983_040]
]

/** The lowest H.264 level that carries `w` x `h` at `fps`, as "4.2" and as the codec string's last byte. */
export function avcLevel(w: number, h: number, fps: number): { name: string; idc: number } {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16)
  const l = LEVELS.find(([, , fs, mbps]) => mbs <= fs && mbs * fps <= mbps) ?? LEVELS[LEVELS.length - 1]
  return { name: l[0], idc: l[1] }
}

/** The codec string (RFC 6381) for a profile at a size and rate: what the Chromium encoder is configured with. */
export function avcCodecFor(profile: Profile, w: number, h: number, fps: number): string {
  const head = { high: '6400', main: '4D40', baseline: '42E0' }[profile]
  return `avc1.${head}${avcLevel(w, h, fps).idc.toString(16).toUpperCase().padStart(2, '0')}`
}
