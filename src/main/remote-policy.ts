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
  // the PC is the point of the phone link: the model drives this PC, every action still asks here (or on the PC) and Ctrl+Alt+Esc stops it
  'sessions:setComputer',
  'sessions:compact',
  'sessions:compactAndWait',
  // "continue in" another model or account, the side chat, the review and the better-prompt helper: all just chats
  'sessions:handoff',
  'sessions:side',
  'sessions:promoteSide',
  'sessions:review',
  'sessions:improvePrompt',
  'sessions:remove',
  'sessions:closed',
  'sessions:restore',
  'browser:info',
  'usage:time',
  'sessions:respond',
  'sessions:rename',
  'sessions:setFlags',
  // shut the PC down (or restart, sleep, lock) when the work is done, from the phone
  'power:arm',
  'power:cancel',
  'power:state',
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
  // how the model works in the browser: asks per action or per site, and how it attaches to a tab
  'siteTrust',
  'browserMode',
  'browserPick',
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
