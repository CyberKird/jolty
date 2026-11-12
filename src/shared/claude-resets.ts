/**
 * The limit resets and promotions a Claude account holds ("Full reset", "Fable reset"), as claude.ai's usage page lists
 * them. They come from `GET /api/organizations/<org>/usage?cedar_ember=1&skip_spend=1` (the `cedar_ember` key); the OAuth
 * token Claude Code keeps is answered "not eligible" there, so they are read with the account's own claude.ai session.
 */

export interface ResetGrant {
  id: string
  /** the account's own wording of the offer ("One full limit reset (November 2026)") */
  label: string
  left: number
  total: number
  startsAt?: number
  endsAt?: number
  /** a reset that also clears the weekly limit; otherwise it refills the 5-hour limit and one model's allowance */
  full: boolean
  usableNow: boolean
}

export interface ClaudeResets {
  profileId: string
  grants: ResetGrant[]
  updatedAt: number
}

/** Where the claude.ai session of a profile stands. `account`: it is signed in to another account than the profile's. */
export interface ClaudeWebInfo {
  profileId: string
  connected: boolean
  problem?: 'signin' | 'account'
  /** the claude.ai account the session belongs to */
  email?: string
}

const ms = (v: unknown): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : undefined
}
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)

/** The grants of a usage response; empty when the account has none or the answer is not the expected shape. Spent ones are dropped. */
export function parseResets(raw: unknown, now = Date.now()): ResetGrant[] {
  const grants = (raw as { cedar_ember?: { grants?: unknown } } | null)?.cedar_ember?.grants
  if (!Array.isArray(grants)) return []
  const out: ResetGrant[] = []
  for (const g of grants) {
    if (!g || typeof g !== 'object') continue
    const o = g as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id) continue
    const left = count(o.resets_left)
    const endsAt = ms(o.ends_at)
    if (left < 1 || (endsAt !== undefined && endsAt <= now)) continue
    const clears = Array.isArray(o.clears) ? o.clears.filter((c): c is string => typeof c === 'string') : []
    out.push({
      id: o.id,
      label: typeof o.label === 'string' ? o.label : o.id,
      left,
      total: Math.max(left, count(o.resets_total)),
      startsAt: ms(o.starts_at),
      endsAt,
      full: clears.includes('seven_day') && o.gives_back_weekly !== true,
      usableNow: o.usable_now === true && o.paused !== true
    })
  }
  // the one that runs out first on top: that is the one not to forget
  return out.sort((a, b) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity))
}
