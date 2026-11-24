// Tells the user when a Claude account lost its sign-in on its own (the server refused the refresh token), instead of
// leaving them to find out from a chat that cannot start. Reads only the credentials file, so a check costs nothing.
import { Notification } from 'electron'
import type { Profile } from '@shared/types'
import { tr } from '@shared/i18n'
import { profileDir } from './store'
import { signedOutIn } from './signin-watch-core'

const EVERY = 10 * 60e3

const isSignedOut = (p: Profile): boolean => p.engine === 'claude' && p.auth === 'subscription' && signedOutIn(profileDir(p))

/** Checks now, then every 10 minutes. Each lost sign-in is announced once; signing in again re-arms it. */
export function start(deps: { profiles: () => Profile[]; open: () => void }): void {
  if (process.env.JOLTY_TEST) return
  const told = new Set<string>()
  const run = (): void => {
    for (const p of deps.profiles()) {
      if (!isSignedOut(p)) {
        told.delete(p.id)
        continue
      }
      if (told.has(p.id) || !Notification.isSupported()) continue
      told.add(p.id)
      const n = new Notification({
        title: tr("{profile} s-a deconectat", { profile: p.name }),
        body: tr("Claude a încheiat autentificarea acestui cont. Deschide Conturi și chei și apasă Conectează contul.")
      })
      n.on('click', deps.open)
      n.show()
    }
  }
  setTimeout(run, 20_000)
  setInterval(run, EVERY)
}
