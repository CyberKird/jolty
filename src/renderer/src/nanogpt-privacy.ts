import type { PrivacySummary } from '@shared/nanogpt'
import type { Profile } from '@shared/types'
import { api } from './store'

// NanoGPT publishes who serves each model and what that route keeps. The main process reads it
// (the renderer's CSP blocks outside requests) and the answer is kept for 30 minutes per profile,
// so the picker can say which models are safe for someone else's personal data.
const CACHE_MS = 30 * 60e3
const cache = new Map<string, { at: number; pr: Promise<Record<string, PrivacySummary>> }>()

/** The privacy of every model of one NanoGPT profile, keyed by model id. Empty for other profiles or when offline. */
export function privacyMap(profile: Profile): Promise<Record<string, PrivacySummary>> {
  const hit = cache.get(profile.id)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.pr
  const pr = api.profiles.privacy(profile.id).catch(() => ({}) as Record<string, PrivacySummary>)
  cache.set(profile.id, { at: Date.now(), pr })
  // an empty answer (offline) is not worth keeping for half an hour
  void pr.then((m) => {
    if (!Object.keys(m).length) cache.delete(profile.id)
  })
  return pr
}
