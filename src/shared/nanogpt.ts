/** What the routes of a NanoGPT model promise about the data they receive, as NanoGPT reports it. */

export interface PrivacySummary {
  /** at least one route keeps no prompts */
  zdr: boolean
  /** every available route is zero retention */
  allZdr: boolean
  /** a provider inside the EU or EEA can serve it */
  eu: boolean
  /** region code of the route the summary comes from */
  region?: string
  /** the provider's own wording about retention, shortened by the page that shows it */
  note?: string
}

export const isNanoGptProfile = (profile?: { baseUrl?: string }): boolean => {
  try {
    return /(^|\.)nano-gpt\.com$/i.test(new URL(profile?.baseUrl || '').hostname)
  } catch {
    return false
  }
}

interface ProviderRoute {
  provider?: string
  available?: boolean
  privacy?: { classification?: string; retainsPrompts?: boolean; note?: string }
  region?: { code?: string; label?: string }
}

/** Reads the providers answer of a NanoGPT model page. Undefined when it says nothing useful. */
export function summarizePrivacy(providers: ProviderRoute[] | undefined): PrivacySummary | undefined {
  const list = (providers || []).filter((p) => p.available !== false && p.privacy)
  if (!list.length) return undefined
  const zero = (p: ProviderRoute): boolean => p.privacy?.classification === 'zdr' || p.privacy?.retainsPrompts === false
  const zeroRoutes = list.filter(zero)
  // the EU route is the one worth naming: it is both zero retention and inside the EEA
  const euRoute = zeroRoutes.find((p) => /^(EU|EEA)$/i.test(p.region?.code || ''))
  const pick = euRoute || zeroRoutes[0]
  return {
    zdr: zeroRoutes.length > 0,
    allZdr: zeroRoutes.length === list.length,
    eu: Boolean(euRoute),
    region: pick?.region?.code,
    note: pick?.privacy?.note
  }
}
