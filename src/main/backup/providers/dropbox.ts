// Dropbox: an "App folder" app, so Jolty sees only Apps/<app name>/ and every Dropbox account has a folder of its own.
// A public client: PKCE instead of an app secret.
import { tr } from '@shared/i18n'
import { forgetToken, oauthConnect, oauthFetch, type OAuthSpec } from '../oauth'
import { BackupError, pictureOf, FILE, mockBase, type Config, type Provider } from '../types'

/** Dropbox only accepts the redirect that is registered letter for letter, so the port is fixed. */
const PORT = 53682
/** upload endpoint limit (150 MiB); bigger needs an upload session */
const MAX_BYTES = 150 * 1024 * 1024
const PATH = `/${FILE}`

const base = (): { auth: string; token: string; api: string; content: string } => {
  const m = mockBase()
  return m
    ? { auth: `${m}/oauth2/authorize`, token: `${m}/oauth2/token`, api: `${m}/2`, content: `${m}/2` }
    : { auth: 'https://www.dropbox.com/oauth2/authorize', token: 'https://api.dropboxapi.com/oauth2/token', api: 'https://api.dropboxapi.com/2', content: 'https://content.dropboxapi.com/2' }
}

const spec = (cfg: Config): OAuthSpec => ({
  id: 'dropbox',
  name: 'Dropbox',
  authUrl: base().auth,
  tokenUrl: base().token,
  scope: 'account_info.read files.metadata.read files.content.read files.content.write',
  clientId: cfg.clientId,
  port: PORT,
  // without it Dropbox returns no refresh token
  extraAuth: { token_access_type: 'offline' }
})

const rpc = { 'content-type': 'application/json' }
const notFound = async (res: Response): Promise<boolean> => {
  const e = ((await res.json().catch(() => ({}))) as { error?: { '.tag'?: string; path?: { '.tag'?: string } } }).error
  if (e?.['.tag'] === 'path' && e.path?.['.tag'] === 'not_found') return true
  throw new BackupError(tr("{provider} a răspuns cu eroarea {code}.", { provider: 'Dropbox', code: res.status }))
}

export const dropbox: Provider = {
  id: 'dropbox',
  info: () => ({
    id: 'dropbox',
    name: 'Dropbox',
    kind: 'oauth',
    fields: [{ key: 'clientId', label: 'App key' }],
    help: tr("În Dropbox App Console: creează o aplicație cu Scoped access și tipul App folder. La Permissions bifează account_info.read, files.metadata.read, files.content.read și files.content.write, iar la Redirect URIs adaugă exact http://127.0.0.1:53682/. Lipește App key (secretul nu e nevoie).")
  }),

  async connect(cfg, open) {
    await oauthConnect(spec(cfg), open)
    // this endpoint takes no argument: no body and no content-type
    const me = (await (await oauthFetch(spec(cfg), `${base().api}/users/get_current_account`, { method: 'POST' })).json()) as { account_id?: string; email?: string; name?: { display_name?: string }; profile_photo_url?: string }
    if (!me.account_id || !me.email) throw new BackupError(tr("Nu am aflat ce cont e."))
    return { sub: me.account_id, label: me.email, name: me.name?.display_name, ...(await pictureOf(me.profile_photo_url)) }
  },

  async disconnect(cfg) {
    await oauthFetch(spec(cfg), `${base().api}/auth/token/revoke`, { method: 'POST' }).catch(() => undefined)
    await forgetToken('dropbox')
  },

  async find(cfg) {
    const res = await oauthFetch(spec(cfg), `${base().api}/files/get_metadata`, { method: 'POST', headers: rpc, body: JSON.stringify({ path: PATH }) }, [409])
    if (res.status === 409 && (await notFound(res))) return null
    const f = (await res.json()) as { size: number; server_modified: string }
    return { modifiedAt: Date.parse(f.server_modified), bytes: f.size }
  },

  async put(cfg, data) {
    if (data.length > MAX_BYTES) throw new BackupError(tr("Backup-ul e prea mare pentru {provider} (limita e {limit} MB).", { provider: 'Dropbox', limit: 150 }))
    await oauthFetch(spec(cfg), `${base().content}/files/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'dropbox-api-arg': JSON.stringify({ path: PATH, mode: 'overwrite' }) },
      body: new Uint8Array(data)
    })
  },

  async get(cfg) {
    const res = await oauthFetch(spec(cfg), `${base().content}/files/download`, { method: 'POST', headers: { 'dropbox-api-arg': JSON.stringify({ path: PATH }) } }, [409])
    if (res.status === 409 && (await notFound(res))) throw new BackupError(tr("Nu există niciun backup în acest loc."))
    return Buffer.from(await res.arrayBuffer())
  }
}
