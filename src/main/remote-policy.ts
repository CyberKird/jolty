// What a paired phone may ask of this PC. Everything not listed here is refused, so a new IPC channel is
// never reachable from outside until someone adds it on purpose.

const ALLOWED = new Set([
  'profiles:list',
  'profiles:status',
  'profiles:models',
  'sessions:list',
  'sessions:start',
  'sessions:history',
  'sessions:send',
  'sessions:interrupt',
  'sessions:setModel',
  'sessions:setEffort',
  'sessions:setPermissionMode',
  'sessions:setBrowser',
  'sessions:compact',
  'sessions:respond',
  'sessions:rename',
  'sessions:setFlags',
  'composer:slash',
  'composer:files',
  'usage:summary',
  'usage:balance',
  'usage:refreshLimits',
  'schedules:list',
  'background:state',
  'app:settings',
  'app:saveSettings',
  'app:version',
  'app:copyText',
  'voice:status',
  'voice:transcribe',
  'updates:status'
])

/** Preferences a phone may change: look and last choices. Anything else in a settings patch is dropped. */
const SETTINGS_KEYS = new Set([
  'theme',
  'glassClear',
  'language',
  'lastComposer',
  'lastProfileId',
  'lastModels',
  'lastCwd',
  'seenVersion',
  'ownKeyHintDismissed',
  'mascot',
  'mascotSize',
  'mascotSounds',
  'reduceMotion',
  'lowPower'
])

/** Modes without questions stay a decision made at the PC: a phone cannot switch them on. */
const OPEN_MODES = new Set(['project', 'full'])

function plain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Returns the arguments to run the call with, or throws the reason the phone's call is refused. */
export function remoteArgs(channel: string, args: unknown): unknown[] {
  if (!ALLOWED.has(channel)) throw new Error(`Not available from the phone: ${channel}`)
  if (!Array.isArray(args)) throw new Error('Bad request')
  if (channel === 'sessions:setPermissionMode' && OPEN_MODES.has(String(args[1]))) throw new Error('This mode can only be turned on at the PC')
  if (channel === 'sessions:start') {
    const input = args[0]
    if (!plain(input)) throw new Error('Bad request')
    if (OPEN_MODES.has(String(input.permissionMode))) throw new Error('This mode can only be turned on at the PC')
  }
  if (channel === 'app:saveSettings') {
    const patch = args[0]
    if (!plain(patch)) throw new Error('Bad request')
    return [Object.fromEntries(Object.entries(patch).filter(([k]) => SETTINGS_KEYS.has(k)))]
  }
  return args
}
