import type { Profile } from './types'

/** Two profiles that reach the same provider through Claude Code, so one conversation file serves both. */
export function sameProvider(a: Profile, b: Profile): boolean {
  if (a.id === b.id || a.engine !== 'claude' || b.engine !== 'claude') return false
  const where = (p: Profile): string => (p.auth === 'endpoint' ? (p.baseUrl || '').replace(/\/+$/, '').toLowerCase() : 'anthropic')
  return where(a) === where(b)
}
