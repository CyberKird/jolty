// Box: one file in the root folder of the user's account. Box authorizes the app with its secret (no PKCE) and its
// refresh tokens are single use, which oauth.ts handles by storing the new one that comes with every refresh.
import { tr } from '@shared/i18n'
import { forgetToken, oauthConnect, oauthFetch, type OAuthSpec } from '../oauth'
import { BackupError, FILE, mockBase, type Config, type Provider } from '../types'

/** Box needs the redirect registered exactly, so the port is fixed. */
const PORT = 53683
/** the single-request upload limit (50 MB); bigger needs chunked upload */
const MAX_BYTES = 50 * 1000 * 1000
const MAX_WAITS = 5

const base = (): { auth: string; token: string; api: string; upload: string } => {
  const m = mockBase()
  return m
    ? { auth: `${m}/api/oauth2/authorize`, token: `${m}/oauth2/token`, api: `${m}/2.0`, upload: `${m}/upload/2.0` }
    : { auth: 'https://account.box.com/api/oauth2/authorize', token: 'https://api.box.com/oauth2/token', api: 'https://api.box.com/2.0', upload: 'https://upload.box.com/api/2.0' }
}

const spec = (cfg: Config): OAuthSpec => ({
  id: 'box',
  name: 'Box',
  authUrl: base().auth,
  tokenUrl: base().token,
  scope: 'root_readwrite',
  clientId: cfg.clientId,
  clientSecret: cfg.clientSecret,
  noPkce: true,
  port: PORT
})

interface BoxEntry {
  type: string
  id: string
  name: string
  size: number
  modified_at: string
}

/** The file in the root folder (id 0), looked up by name through every page of the listing. */
async function findFile(cfg: Config): Promise<BoxEntry | undefined> {
  for (let offset = 0; ; ) {
    const res = await oauthFetch(spec(cfg), `${base().api}/folders/0/items?fields=id,name,size,modified_at&limit=1000&offset=${offset}`)
    const page = (await res.json()) as { entries?: BoxEntry[]; total_count?: number }
    const hit = page.entries?.find((e) => e.type === 'file' && e.name === FILE)
    offset += page.entries?.length ?? 0
    if (hit || !page.entries?.length || offset >= (page.total_count ?? 0)) return hit
  }
}

export const box: Provider = {
  id: 'box',
  info: () => ({
    id: 'box',
    name: 'Box',
    kind: 'oauth',
    fields: [
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true }
    ],
    help: tr("În Box Developer Console: creează o aplicație Custom App cu autentificare OAuth 2.0 (User Authentication). La Configuration bifează scope-ul Read and write all files and folders și adaugă redirect URI-ul http://127.0.0.1:53683/. Lipește Client ID și Client Secret.")
  }),

  async connect(cfg, open) {
    await oauthConnect(spec(cfg), open)
    const me = (await (await oauthFetch(spec(cfg), `${base().api}/users/me`)).json()) as { id?: string; login?: string; name?: string; avatar_url?: string }
    if (!me.id || !me.login) throw new BackupError(tr("Nu am aflat ce cont e."))
    return { sub: me.id, label: me.login, name: me.name }
  },

  async disconnect() {
    // Box's revoke call needs the client secret together with the token, which forgetToken does not send
    await forgetToken('box')
  },

  async find(cfg) {
    const f = await findFile(cfg)
    return f ? { modifiedAt: Date.parse(f.modified_at), bytes: f.size } : null
  },

  async put(cfg, data) {
    if (data.length > MAX_BYTES) throw new BackupError(tr("Backup-ul e prea mare pentru {provider} (limita e {limit} MB).", { provider: 'Box', limit: 50 }))
    const id = (await findFile(cfg))?.id
    // the attributes part has to come before the file part
    const form = new FormData()
    form.append('attributes', JSON.stringify(id ? { name: FILE } : { name: FILE, parent: { id: '0' } }))
    form.append('file', new Blob([new Uint8Array(data)]), FILE)
    await oauthFetch(spec(cfg), `${base().upload}/files/${id ? `${id}/` : ''}content`, { method: 'POST', body: form })
  },

  /** The download is a redirect to a temporary address (followed by hand, so the token stays here); 202 means "not ready yet, retry in a moment". */
  async get(cfg) {
    const f = await findFile(cfg)
    if (!f) throw new BackupError(tr("Nu există niciun backup în acest loc."))
    const url = `${base().api}/files/${f.id}/content`
    for (let wait = 0; wait < MAX_WAITS; wait++) {
      const res = await oauthFetch(spec(cfg), url, { redirect: 'manual' }, [202, 302])
      if (res.status === 202) {
        await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get('retry-after')) || 1, 5) * 1000))
        continue
      }
      const to = res.headers.get('location')
      if (!to) throw new BackupError(tr("{provider} a răspuns cu eroarea {code}.", { provider: 'Box', code: res.status }))
      const file = await fetch(new URL(to, url))
      if (!file.ok) throw new BackupError(tr("{provider} a răspuns cu eroarea {code}.", { provider: 'Box', code: file.status }))
      return Buffer.from(await file.arrayBuffer())
    }
    throw new BackupError(tr("{provider} a răspuns cu eroarea {code}.", { provider: 'Box', code: 202 }))
  }
}
