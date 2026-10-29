// Background mode (tray, hide on close) and the global quick entry shortcut, the parts that need no Electron.
import type { AppSettings } from './types'

/** Closing the window hides Jolty: on by default in the installed app, off in dev and test runs so those still exit. */
export function keepsRunning(s: Pick<AppSettings, 'keepInBackground'>, installed: boolean): boolean {
  return s.keepInBackground ?? installed
}

/** The saved shortcut; unset is the default, '' is off. */
export function quickKeyOf(s: Pick<AppSettings, 'quickKey'>): string {
  return s.quickKey ?? DEFAULT_QUICK_KEY
}

export const DEFAULT_QUICK_KEY = 'Ctrl+Alt+Space'

const MODS = ['Ctrl', 'Alt', 'Shift', 'Super'] as const
const MOD_ALIASES: Record<string, (typeof MODS)[number]> = {
  ctrl: 'Ctrl', control: 'Ctrl', cmdorctrl: 'Ctrl', commandorcontrol: 'Ctrl',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
  super: 'Super', win: 'Super', meta: 'Super', cmd: 'Super', command: 'Super'
}
const NAMED: Record<string, string> = {
  space: 'Space', ' ': 'Space', spacebar: 'Space', enter: 'Enter', return: 'Enter', tab: 'Tab', backspace: 'Backspace',
  delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down', left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
  esc: 'Escape', escape: 'Escape'
}
/** keys Jolty or Windows already own: Ctrl+Alt+Esc is the PC-control kill key, Ctrl+Alt+Del is the system's */
const RESERVED = new Set(['Ctrl+Alt+Escape', 'Ctrl+Alt+Delete', 'Ctrl+Shift+Escape', 'Alt+Tab', 'Alt+F4', 'Super+L'])

function keyName(raw: string): string | undefined {
  const k = raw.toLowerCase()
  if (NAMED[k]) return NAMED[k]
  if (/^[a-z0-9]$/.test(k)) return k.toUpperCase()
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(k)) return k.toUpperCase()
  return undefined
}

/** Canonical accelerator, or an error: at least one modifier and exactly one other key, and not a reserved one. */
export function parseHotkey(input: string): { key: string } | { error: string } {
  const parts = String(input || '').split('+').map((p) => p.trim()).filter(Boolean)
  // "Ctrl+Alt++" means the plus key: not supported, it reads as an empty part
  const mods = new Set<string>()
  let key: string | undefined
  for (const p of parts) {
    const mod = MOD_ALIASES[p.toLowerCase()]
    if (mod) mods.add(mod)
    else if (key) return { error: 'two-keys' }
    else if (!(key = keyName(p))) return { error: 'unknown-key' }
  }
  if (!key) return { error: 'no-key' }
  if (mods.size === 0 || (mods.size === 1 && mods.has('Shift'))) return { error: 'no-modifier' }
  const accel = [...MODS.filter((m) => mods.has(m)), key].join('+')
  if (RESERVED.has(accel)) return { error: 'reserved' }
  return { key: accel }
}

/** What a keydown in the Settings recorder means: an accelerator once a real key is pressed with the modifiers held. */
export function hotkeyFromEvent(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; key: string; code?: string }): string | undefined {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return undefined
  // the code keeps the key when Alt/Shift changes what e.key prints (Alt+Shift+1 gives "!")
  const fromCode = e.code && (/^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit([0-9])$/.exec(e.code)?.[1])
  const key = fromCode || (e.code === 'Space' ? 'Space' : e.key)
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', key].filter(Boolean).join('+')
}
