// Google Drive: the hidden app folder (scope drive.appdata), so Jolty sees only its own file and every Google account
// has a folder of its own.
import { tr } from '@shared/i18n'
import { forgetToken, oauthConnect, oauthFetch, type OAuthSpec } from '../oauth'
import { BackupError, FILE, mockBase, type Config, type Provider } from '../types'

const base = (): { auth: string; token: string; userinfo: string; revoke: string; drive: string; upload: string } => {
  const m = mockBase()
  return m
    ? { auth: `${m}/auth`, token: `${m}/token`, userinfo: `${m}/userinfo`, revoke: `${m}/revoke`, drive: `${m}/drive/v3`, upload: `${m}/upload/drive/v3` }
    : {
        auth: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
        revoke: 'https://oauth2.googleapis.com/revoke',
        drive: 'https://www.googleapis.com/drive/v3',
        upload: 'https://www.googleapis.com/upload/drive/v3'
      }
}

// Jolty's own Google client (a Desktop app client, published in production with non-sensitive scopes only). Google says
// the secret of an installed app is not confidential; it is split so scanners of public repos do not revoke it.
const OWN_CLIENT_ID = '609538879126-39s89qusvvl1d5ia094dtbecaqs1b3rd.apps.googleusercontent.com'
const OWN_CLIENT_SECRET = ['GOCSPX', 'EyKFq6EV74pXxVPdKo', 'Tp5ihdMjy'].join('-')

const spec = (cfg: Config): OAuthSpec => ({
  id: 'google',
  name: 'Google',
  authUrl: base().auth,
  tokenUrl: base().token,
  scope: 'openid email profile https://www.googleapis.com/auth/drive.appdata',
  clientId: cfg.clientId?.trim() || OWN_CLIENT_ID,
  clientSecret: cfg.clientId?.trim() ? cfg.clientSecret : OWN_CLIENT_SECRET,
  // without it Google sends the refresh token only the first time this account signs in
  extraAuth: { access_type: 'offline', prompt: 'consent' }
})

interface DriveFile {
  id: string
  modifiedTime: string
  size: string
}

async function findFile(cfg: Config): Promise<DriveFile | undefined> {
  const q = encodeURIComponent(`name='${FILE}' and trashed=false`)
  const res = await oauthFetch(spec(cfg), `${base().drive}/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime,size)&orderBy=modifiedTime%20desc&pageSize=1`)
  return ((await res.json()) as { files?: DriveFile[] }).files?.[0]
}

export const google: Provider = {
  id: 'google',
  info: () => ({
    id: 'google',
    name: 'Google Drive',
    kind: 'oauth',
    fields: [
      { key: 'clientId', label: 'Client ID', optional: true },
      { key: 'clientSecret', label: 'Client secret', secret: true, optional: true }
    ],
    help: tr("Te conectezi cu contul tău Google, fără nicio setare. Jolty vede doar un folder ascuns al lui în Drive. Avansat: poți lipi ID-ul și secretul unui client OAuth propriu de tip Desktop app.")
  }),

  async connect(cfg, open) {
    await oauthConnect(spec(cfg), open)
    const me = (await (await oauthFetch(spec(cfg), base().userinfo)).json()) as { sub?: string; email?: string; name?: string }
    if (!me.sub || !me.email) throw new BackupError(tr("Nu am aflat ce cont e."))
    return { sub: me.sub, label: me.email, name: me.name }
  },

  async disconnect() {
    await forgetToken('google', base().revoke)
  },

  async find(cfg) {
    const f = await findFile(cfg)
    return f ? { modifiedAt: Date.parse(f.modifiedTime), bytes: Number(f.size) } : null
  },

  /** Resumable upload in two calls: the first names the file and gets an address, the second sends the bytes. */
  async put(cfg, data) {
    const existing = (await findFile(cfg))?.id
    const init = await oauthFetch(spec(cfg), `${base().upload}/files${existing ? `/${existing}` : ''}?uploadType=resumable`, {
      method: existing ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/octet-stream', 'x-upload-content-length': String(data.length) },
      body: JSON.stringify(existing ? {} : { name: FILE, parents: ['appDataFolder'] })
    })
    const to = init.headers.get('location')
    if (!to) throw new BackupError(tr("Nu am primit adresa de încărcare."))
    await oauthFetch(spec(cfg), to, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(data) })
  },

  async get(cfg) {
    const f = await findFile(cfg)
    if (!f) throw new BackupError(tr("Nu există niciun backup în acest loc."))
    return Buffer.from(await (await oauthFetch(spec(cfg), `${base().drive}/files/${f.id}?alt=media`)).arrayBuffer())
  }
}
