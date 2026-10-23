// Picks the model of a started session from what Jolty has: every usable account and provider, scored like the
// model picker. Hard jobs go to the strongest model, simple ones to the fastest that is still good enough.
import type { ModelOption, Profile } from '@shared/types'
import { modelScore } from '@shared/scores'

export interface Candidate {
  profileId: string
  model: string
  label: string
  iq: number
  tps?: number
}

/** Below this the model is too weak to hand a job to, however fast it is. */
export const MIN_IQ_SIMPLE = 30
/** An account this full is left out: the job would stop on its limit. */
export const FULL_PERCENT = 95

export function candidates(profile: Profile, models: ModelOption[]): Candidate[] {
  const out: Candidate[] = []
  for (const m of models) {
    const s = modelScore(profile, m)
    if (s) out.push({ profileId: profile.id, model: m.id, label: m.label, iq: s.iq, tps: s.tps })
  }
  return out
}

export function pickAuto(kind: 'simple' | 'hard', list: Candidate[]): Candidate | undefined {
  const speed = (c: Candidate): number => c.tps ?? 0
  if (kind === 'hard') return [...list].sort((a, b) => b.iq - a.iq || speed(b) - speed(a))[0]
  return list.filter((c) => c.iq >= MIN_IQ_SIMPLE && c.tps !== undefined).sort((a, b) => speed(b) - speed(a) || b.iq - a.iq)[0]
}
