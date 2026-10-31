// find_skills: the "skill of skills", built in. Looks in the skills already on this PC first, then in the skills.sh
// directory (Vercel's open skills leaderboard), so a model can pick the right skill or know where to find one.
// It only reads: installing a third-party skill stays a decision of the user.
import type { SkillInfo } from '@shared/skills'

const HUB = 'https://skills.sh/api/search'

export interface HubSkill {
  source: string
  skillId: string
  installs: number
}

const words = (q: string): string[] => q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1)

/** Installed skills whose name or description holds every word of the query, name hits first. */
export function localMatches(all: SkillInfo[], query: string, limit: number): SkillInfo[] {
  const ws = words(query)
  if (!ws.length) return []
  const score = (s: SkillInfo): number => {
    const name = s.name.toLowerCase()
    const hay = `${name} ${s.description.toLowerCase()}`
    return ws.every((w) => hay.includes(w)) ? ws.filter((w) => name.includes(w)).length + 1 : 0
  }
  return all
    .map((s) => ({ s, n: score(s) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((x) => x.s)
}

/** The directory's answer, kept to what is needed; anything unexpected is dropped, never trusted. */
export function parseHub(json: unknown, limit: number): HubSkill[] {
  const list = (json as { skills?: unknown })?.skills
  if (!Array.isArray(list)) return []
  const out: HubSkill[] = []
  for (const x of list as Record<string, unknown>[]) {
    if (typeof x?.source !== 'string' || typeof x.skillId !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(x.source) || !/^[\w.-]+$/.test(x.skillId)) continue
    out.push({ source: x.source, skillId: x.skillId, installs: typeof x.installs === 'number' ? x.installs : 0 })
    if (out.length >= limit) break
  }
  return out
}

export async function hubSearch(query: string, limit: number, fetchImpl: typeof fetch = fetch): Promise<HubSkill[]> {
  const res = await fetchImpl(`${HUB}?q=${encodeURIComponent(query)}&limit=${limit}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`skills.sh answered ${res.status}`)
  return parseHub(await res.json(), limit)
}

export function formatFinds(query: string, local: SkillInfo[], hub: HubSkill[], hubError?: string): string {
  const parts: string[] = []
  parts.push(
    local.length
      ? `Installed on this PC (use these first):\n${local.map((s) => `- ${s.name} (${s.home}): ${s.description.slice(0, 160)}`).join('\n')}`
      : `No installed skill matches "${query}".`
  )
  if (hubError) parts.push(`The skills.sh directory could not be reached (${hubError}).`)
  else if (hub.length)
    parts.push(
      `On skills.sh, most installed first (third-party code, not reviewed by Jolty):\n${hub.map((h) => `- ${h.skillId} from ${h.source}, ${h.installs} installs, https://skills.sh/${h.source}/${h.skillId}`).join('\n')}\nTell the user which one you would use and why, and install nothing without their yes: read its SKILL.md on GitHub (https://github.com/<source>) for odd commands or network calls first, then \`npx skills add <source>\` installs the skills of that repository.`
    )
  else parts.push(`Nothing on skills.sh for "${query}".`)
  return parts.join('\n\n')
}
