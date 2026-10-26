// GitHub: the backup is one file in the root of a private repository the user created, written through the contents
// API with a fine-grained token that can only touch that repository.
import { tr } from '@shared/i18n'
import { BackupError, FILE, mockBase, type Config, type Provider } from '../types'

/** The contents API takes files up to 100 MB. */
const MAX_BYTES = 100 * 1024 * 1024
const REPO_RE = /^[\w.-]+\/[\w.-]+$/

const api = (): string => mockBase() ?? 'https://api.github.com'

async function gh(cfg: Config, path: string, init: { method?: string; accept?: string; body?: string } = {}, accept: number[] = []): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${api()}${path}`, {
      method: init.method,
      headers: {
        accept: init.accept ?? 'application/vnd.github+json',
        authorization: `Bearer ${cfg.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'Jolty',
        ...(init.body ? { 'content-type': 'application/json' } : {})
      },
      body: init.body,
      signal: AbortSignal.timeout(180_000)
    })
  } catch {
    throw new BackupError(tr("Nu m-am putut conecta la server."))
  }
  if (res.ok || accept.includes(res.status)) return res
  if (res.status === 401) throw new BackupError(tr("Tokenul GitHub nu e valid sau a expirat."))
  throw new BackupError(tr("{provider} a răspuns cu eroarea {code}.", { provider: 'GitHub', code: res.status }))
}

const repoOf = (cfg: Config): string => {
  const repo = (cfg.repo ?? '').trim()
  if (!REPO_RE.test(repo)) throw new BackupError(tr("Repository-ul trebuie scris ca owner/nume."))
  return repo
}
const branchOf = (cfg: Config): string => (cfg.branch ?? '').trim()
const fileUrl = (cfg: Config): string => `/repos/${repoOf(cfg)}/contents/${FILE}`
/** the branch as a query parameter, empty for the default branch */
const refQ = (cfg: Config, name: string, first: boolean): string => (branchOf(cfg) ? `${first ? '?' : '&'}${name}=${encodeURIComponent(branchOf(cfg))}` : '')

interface Entry {
  sha: string
  size: number
}

async function entry(cfg: Config): Promise<Entry | null> {
  const res = await gh(cfg, `${fileUrl(cfg)}${refQ(cfg, 'ref', true)}`, {}, [404])
  if (res.status === 404) return null
  const f = (await res.json()) as Partial<Entry>
  // an array (a folder with this name) has no sha
  return typeof f.sha === 'string' ? { sha: f.sha, size: Number(f.size) } : null
}

export const github: Provider = {
  id: 'github',
  info: () => ({
    id: 'github',
    name: 'GitHub',
    kind: 'credentials',
    fields: [
      { key: 'token', label: 'Token', secret: true, placeholder: 'github_pat_...' },
      { key: 'repo', label: 'Repository (owner/name)', placeholder: 'me/jolty-backup' },
      { key: 'branch', label: 'Branch (optional)', optional: true, placeholder: 'main' }
    ],
    help: tr("Creează pe GitHub un repository PRIVAT și un token fine-grained doar pentru el, cu Contents: Read and write. Lipește tokenul și numele repository-ului.")
  }),

  async connect(cfg) {
    const repo = repoOf(cfg)
    const user = (await (await gh(cfg, '/user')).json()) as { id?: number; login?: string }
    if (!user.id || !user.login) throw new BackupError(tr("Nu am aflat ce cont e."))
    const res = await gh(cfg, `/repos/${repo}`, {}, [403, 404])
    if (res.status !== 200) throw new BackupError(tr("Repository-ul nu există sau tokenul nu are acces la el."))
    const info = (await res.json()) as { private?: boolean; permissions?: { push?: boolean } }
    if (!info.permissions?.push) throw new BackupError(tr("Tokenul nu poate scrie în repository (Contents: Read and write)."))
    if (info.private !== true) throw new BackupError(tr("Repository-ul e public. Folosește unul privat."))
    return { sub: `${user.id}:${repo.toLowerCase()}`, label: `${user.login} / ${repo}`, name: user.login }
  },

  async find(cfg) {
    const f = await entry(cfg)
    if (!f) return null
    // the file itself has no date, the last commit that touched it does
    let modifiedAt = Date.now()
    try {
      const list = (await (await gh(cfg, `/repos/${repoOf(cfg)}/commits?path=${FILE}&per_page=1${refQ(cfg, 'sha', false)}`)).json()) as { commit?: { committer?: { date?: string } } }[]
      const at = Date.parse(list[0]?.commit?.committer?.date ?? '')
      if (!Number.isNaN(at)) modifiedAt = at
    } catch {
      /* the date is only informative */
    }
    return { modifiedAt, bytes: f.size }
  },

  async put(cfg, data) {
    if (data.length > MAX_BYTES) throw new BackupError(tr("Backup-ul depășește 100 MB, limita GitHub."))
    const content = data.toString('base64')
    // the sha of the current file is fetched right before each try; a 409/422 means someone wrote in between
    for (let attempt = 0; ; attempt++) {
      const sha = (await entry(cfg))?.sha
      const body = JSON.stringify({ message: 'Jolty backup', content, ...(sha ? { sha } : {}), ...(branchOf(cfg) ? { branch: branchOf(cfg) } : {}) })
      const res = await gh(cfg, fileUrl(cfg), { method: 'PUT', body }, attempt === 0 ? [409, 422] : [])
      if (res.ok) return
    }
  },

  async get(cfg) {
    const res = await gh(cfg, `${fileUrl(cfg)}${refQ(cfg, 'ref', true)}`, { accept: 'application/vnd.github.raw+json' }, [404])
    if (res.status === 404) throw new BackupError(tr("Nu există niciun backup în acest loc."))
    return Buffer.from(await res.arrayBuffer())
  }
}
