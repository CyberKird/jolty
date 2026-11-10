// Extra buckets an account may have next to its 5 h / 7 d limits: a model included for a share of the weekly limit
// ("Fable: up to 50%"), or any other promotion the server lists. Nothing here names a model or an offer: what the
// account reports is shown, an account without any gets nothing. Pure, so a test can feed it a recorded answer.
import type { LimitWindow } from './types'

interface Row {
  kind?: string
  percent?: number | null
  resets_at?: string | null
  scope?: { model?: { display_name?: string | null } | null; surface?: { display_name?: string | null } | null } | null
}
interface ShareRow {
  limit_index?: number
  allowance_percent_of_weekly?: number | null
}

/** the plain limits, already shown as the 5 h and 7 d meters */
const MAIN_KINDS = new Set(['session', 'weekly_all'])

const pct = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined)
const when = (s: unknown): number | undefined => {
  const t = typeof s === 'string' ? Date.parse(s) : NaN
  return Number.isNaN(t) ? undefined : t
}
const words = (key: string): string => {
  const t = key.replace(/_/g, ' ').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** every extra bucket of the usage answer as a meter; `scope` is set when the bucket belongs to one model */
export function extraWindows(raw: unknown): LimitWindow[] {
  const o = raw as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || Array.isArray(o)) return []
  const out: LimitWindow[] = []
  const shares = Array.isArray(o.weekly_scoped_shares) ? (o.weekly_scoped_shares as ShareRow[]) : []
  if (Array.isArray(o.limits)) {
    ;(o.limits as Row[]).forEach((row, index) => {
      if (!row || typeof row !== 'object' || !row.kind || MAIN_KINDS.has(row.kind)) return
      const used = pct(row.percent)
      if (used === undefined) return
      const model = row.scope?.model?.display_name?.trim()
      const label = model || row.scope?.surface?.display_name?.trim() || words(row.kind)
      const allowance = shares.find((s) => s.limit_index === index)?.allowance_percent_of_weekly
      out.push({
        label,
        extra: true,
        usedPercent: used,
        resetsAt: when(row.resets_at),
        ...(model ? { scope: model } : {}),
        ...(typeof allowance === 'number' && allowance > 0 && allowance < 100 ? { allowance } : {})
      })
    })
  }
  // promotions that come as a window of their own (omelette_promotional, an *_offer ...), when they carry a percentage
  for (const [key, v] of Object.entries(o)) {
    if (!/promo|offer/i.test(key) || !v || typeof v !== 'object' || Array.isArray(v)) continue
    const w = v as { utilization?: unknown; resets_at?: unknown }
    const used = pct(w.utilization)
    if (used !== undefined) out.push({ label: words(key), extra: true, usedPercent: used, resetsAt: when(w.resets_at) })
  }
  return out
}

/** the bucket a model draws from: its name starts with the bucket's ("Fable 5.2" -> "Fable") */
export function bucketFor(windows: LimitWindow[] | undefined, modelLabel: string): LimitWindow | undefined {
  const label = modelLabel.trim().toLowerCase()
  return windows?.find((w) => w.scope && (label === w.scope.toLowerCase() || label.startsWith(`${w.scope.toLowerCase()} `)))
}

/** extra buckets the account lists now that the last read did not have: the promotion that just appeared */
export function newExtras(before: LimitWindow[] | undefined, now: LimitWindow[]): LimitWindow[] {
  const known = new Set((before || []).filter((w) => w.extra).map((w) => w.label))
  return now.filter((w) => w.extra && !known.has(w.label))
}
