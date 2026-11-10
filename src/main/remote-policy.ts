// What a paired phone may ask of this PC. A phone is the owner's own: the whole app works from it. What is refused is what
// only makes sense at the PC (folder dialogs, opening local paths, the phone link itself) and what could cut the phone off
// (installing an update restarts Jolty). A new channel needs a decision before it is reachable from outside.

/** Whole groups of channels: each page of the app lives in one. */
const GROUPS = ['profiles:', 'sessions:', 'schedules:', 'skills:', 'system:', 'local:', 'setup:', 'usage:', 'backup:', 'merge:', 'codexImport:', 'browser:', 'composer:', 'power:', 'voice:']

const ALLOWED = new Set([
  'background:state',
  // the phone keeps the way to wake the PC, for when the PC is off and cannot be asked
  'remote:wakeConfig',
  'app:settings',
  'app:saveSettings',
  'app:version',
  'app:sendBugReport',
  'app:notificationsBlocked',
  'updates:status',
  'updates:check'
])

/** Inside the groups: what stays at the PC. */
const REFUSED = new Set([
  'skills:reveal',
  'browser:openExtensionPage',
  'browser:installNative',
  'local:installOllama',
  // the phone's own browser and clipboard are used there (remote/boot.ts)
  'voice:download'
])

/** Preferences a phone may not change: where the PC's own doors are. */
const SETTINGS_REFUSED = new Set(['remoteScreen', 'dataDir'])

function plain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Returns the arguments to run the call with, or throws the reason the phone's call is refused. */
export function remoteArgs(channel: string, args: unknown): unknown[] {
  if (REFUSED.has(channel) || !(ALLOWED.has(channel) || GROUPS.some((g) => channel.startsWith(g)))) throw new Error(`Not available from the phone: ${channel}`)
  if (!Array.isArray(args)) throw new Error('Bad request')
  if (channel === 'app:saveSettings') {
    const patch = args[0]
    if (!plain(patch)) throw new Error('Bad request')
    return [Object.fromEntries(Object.entries(patch).filter(([k]) => !SETTINGS_REFUSED.has(k)))]
  }
  return args
}
