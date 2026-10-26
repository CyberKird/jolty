// OneDrive: the app folder (Files.ReadWrite.AppFolder, Apps/<app name>/), so Jolty sees only its own file. A public
// client: PKCE instead of an app secret. Microsoft rotates refresh tokens, which oauth.ts replaces as they arrive.
import { tr } from '@shared/i18n'
import { forgetToken, oauthConnect, oauthFetch, type OAuthSpec } from '../oauth'
import { BackupError, FILE, mockBase, type Config, type Provider } from '../types'

/** simple upload limit; bigger needs an upload session */
const MAX_BYTES = 250 * 1000 * 1000

const base = (): { auth: string; token: string; graph: string } => {
  const m = mockBase()
  return m
    ? { auth: `${m}/common/oauth2/v2.0/authorize`, token: `${m}/common/oauth2/v2.0/token`, graph: `${m}/v1.0` }
    : {
        auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        graph: 'https://graph.microsoft.com/v1.0'
      }
}

const spec = (cfg: Config): OAuthSpec => ({
  id: 'onedrive',
  name: 'OneDrive',
  authUrl: base().auth,
  tokenUrl: base().token,
  scope: 'offline_access Files.ReadWrite.AppFolder User.Read',
  clientId: cfg.clientId,
  // Microsoft matches http://localhost for desktop apps and ignores the port; the loopback server still listens on 127.0.0.1
  host: 'localhost'
})

const item = (): string => `${base().graph}/me/drive/special/approot:/${FILE}`

export const onedrive: Provider = {
  id: 'onedrive',
  info: () => ({
    id: 'onedrive',
    name: 'OneDrive',
    kind: 'oauth',
    fields: [{ key: 'clientId', label: 'Application (client) ID' }],
    help: tr("În Microsoft Entra (App registrations): înregistrează o aplicație pentru conturi Microsoft personale, la Authentication adaugă platforma Mobile and desktop cu redirect URI http://localhost și permite public client flows. La API permissions adaugă Files.ReadWrite.AppFolder și User.Read. Lipește Application (client) ID.")
  }),

  async connect(cfg, open) {
    await oauthConnect(spec(cfg), open)
    const me = (await (await oauthFetch(spec(cfg), `${base().graph}/me`)).json()) as { id?: string; mail?: string | null; userPrincipalName?: string; displayName?: string }
    const label = me.mail || me.userPrincipalName
    if (!me.id || !label) throw new BackupError(tr("Nu am aflat ce cont e."))
    return { sub: me.id, label, name: me.displayName }
  },

  async disconnect() {
    // Microsoft has no call for a client to revoke one refresh token
    await forgetToken('onedrive')
  },

  async find(cfg) {
    const res = await oauthFetch(spec(cfg), item(), {}, [404])
    if (res.status === 404) return null
    const f = (await res.json()) as { size: number; lastModifiedDateTime: string }
    return { modifiedAt: Date.parse(f.lastModifiedDateTime), bytes: f.size }
  },

  async put(cfg, data) {
    if (data.length > MAX_BYTES) throw new BackupError(tr("Backup-ul e prea mare pentru {provider} (limita e {limit} MB).", { provider: 'OneDrive', limit: 250 }))
    await oauthFetch(spec(cfg), `${item()}:/content`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(data) })
  },

  /** /content answers with a redirect to a pre-authenticated address: followed by hand so the token never goes along. */
  async get(cfg) {
    const url = `${item()}:/content`
    const res = await oauthFetch(spec(cfg), url, { redirect: 'manual' }, [302, 404])
    if (res.status === 404) throw new BackupError(tr("Nu există niciun backup în acest loc."))
    if (res.status !== 302) return Buffer.from(await res.arrayBuffer())
    const to = res.headers.get('location')
    if (!to) throw new BackupError(tr("{provider} a răspuns cu eroarea {code}.", { provider: 'OneDrive', code: 302 }))
    const file = await fetch(new URL(to, url))
    if (!file.ok) throw new BackupError(tr("{provider} a răspuns cu eroarea {code}.", { provider: 'OneDrive', code: file.status }))
    return Buffer.from(await file.arrayBuffer())
  }
}
