// The model list of a Claude account. Claude Code only knows the models of its own release ("Fable 5.1" until Jolty
// ships a newer one), but the account's own list (GET /v1/models) already has what the Claude app shows ("Fable 5.2").
// Nothing here names a model line: a newer model of a known line replaces its row, a line never seen is added while it is new.
import type { ModelOption } from './types'

export interface AccountModel {
  id: string
  display_name?: string
  created_at?: string
  line?: string
  capabilities?: { effort?: Record<string, unknown> }
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** a line first listed more than this long ago is an old model, not news */
const NEW_FOR_MS = 60 * 864e5

/** "claude-fable-5-2" -> [5, 2]; dated snapshots ("...-20251001") and other shapes are not the plain model of a line */
function version(id: string): number[] | undefined {
  const m = /^claude-[a-z]+-(\d+(?:-\d{1,2})?)$/.exec(id)
  return m ? m[1].split('-').map(Number) : undefined
}
const newer = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}
const nameOf = (m: AccountModel): string => (m.display_name || m.id).replace(/^Claude\s+/i, '')
/** "Fable 5.1" -> [5, 1] */
const labelVersion = (label: string): number[] =>
  (/(\d+(?:\.\d+)?)\s*$/.exec(label)?.[1] ?? '')
    .split('.')
    .filter(Boolean)
    .map(Number)

/** the account's newest plain model of every line */
function newestPerLine(models: AccountModel[]): Map<string, AccountModel> {
  const out = new Map<string, AccountModel>()
  for (const m of models) {
    const v = version(m.id)
    const line = m.line || /^claude-([a-z]+)-/.exec(m.id)?.[1]
    if (!v || !line) continue
    const best = out.get(line)
    if (!best || newer(v, version(best.id)!)) out.set(line, m)
  }
  return out
}

/** The old model's name inside its description ("Fable 5.1 · Most capable...") becomes the new model's name: the row is the new model, its text must say so. */
function renamed(description: string | undefined, from: string, to: string): string | undefined {
  if (!description || from === to) return description
  return description.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi'), to)
}

export function mergeAccountModels(list: ModelOption[], account: AccountModel[], now = Date.now()): ModelOption[] {
  const out = [...list]
  for (const [line, m] of newestPerLine(account)) {
    const label = nameOf(m)
    const row = out.findIndex((x) => x.id === line || x.id === m.id || new RegExp(`^${line}\\b`, 'i').test(x.label))
    const efforts = EFFORTS.filter((e) => m.capabilities?.effort?.[e])
    const fresh: ModelOption = {
      id: m.id,
      label,
      description: row >= 0 ? out[row].description : undefined,
      isDefault: row >= 0 ? out[row].isDefault : undefined,
      alias: row >= 0 && out[row].id !== m.id ? out[row].id : undefined,
      efforts: efforts.length ? [...efforts] : row >= 0 ? out[row].efforts : undefined
    }
    if (row >= 0) {
      // only a newer model than the row already shows replaces it
      if (out[row].id !== m.id && newer(labelVersion(label), labelVersion(out[row].label))) out[row] = { ...fresh, description: renamed(fresh.description, out[row].label, label) }
      continue
    }
    const made = m.created_at ? Date.parse(m.created_at) : NaN
    if (!Number.isNaN(made) && now - made < NEW_FOR_MS) out.push(fresh)
  }
  return out
}

export function parseAccountModels(raw: unknown): AccountModel[] {
  const data = (raw as { data?: unknown })?.data
  return Array.isArray(data) ? (data as AccountModel[]).filter((m) => m && typeof m.id === 'string') : []
}
