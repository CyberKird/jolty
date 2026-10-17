// Key names the model uses ("Enter", "Control+A", "Shift+Tab", "a") turned into DevTools key events.

interface KeyDef {
  key: string
  code: string
  keyCode: number
  text?: string
}

const NAMED: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 }
}
for (let i = 1; i <= 12; i++) NAMED['F' + i] = { key: 'F' + i, code: 'F' + i, keyCode: 111 + i }

const ALIASES: Record<string, string> = {
  esc: 'Escape', return: 'Enter', del: 'Delete', ctrl: 'Control', cmd: 'Meta', command: 'Meta', option: 'Alt',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pgup: 'PageUp', pgdn: 'PageDown', spacebar: 'Space',
  controlorMeta: 'Control', controlormeta: 'Control'
}

const MOD_BIT: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

function define(name: string): KeyDef {
  const canon = ALIASES[name.toLowerCase()] || name
  if (NAMED[canon]) return NAMED[canon]
  if (canon.length === 1) {
    const upper = canon.toUpperCase()
    const letter = /[a-z]/i.test(canon)
    const digit = /[0-9]/.test(canon)
    return {
      key: canon,
      code: letter ? 'Key' + upper : digit ? 'Digit' + canon : '',
      keyCode: upper.charCodeAt(0),
      text: canon
    }
  }
  throw new Error(`unknown key "${name}". Use names like Enter, Tab, Escape, ArrowDown, Backspace, F5, or a single character, with modifiers like Control+A.`)
}

export interface KeyPress {
  down: Record<string, unknown>[]
  up: Record<string, unknown>[]
}

/** "Control+Shift+K" -> the key events that press the chord, then release it. */
export function keyPress(spec: string): KeyPress {
  let last = spec
  let modPart = ''
  if (spec.endsWith('++')) {
    last = '+'
    modPart = spec.slice(0, -2)
  } else {
    const i = spec.lastIndexOf('+')
    if (i > 0) {
      last = spec.slice(i + 1)
      modPart = spec.slice(0, i)
    }
  }
  const mods = (modPart ? modPart.split('+') : []).map((m) => ALIASES[m.toLowerCase()] || m)
  let bits = 0
  const down: Record<string, unknown>[] = []
  const up: Record<string, unknown>[] = []
  for (const m of mods) {
    if (!(m in MOD_BIT)) throw new Error(`unknown modifier "${m}"`)
    bits |= MOD_BIT[m]
    const d = NAMED[m]
    down.push({ type: 'rawKeyDown', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, modifiers: bits })
  }
  const k = define(last)
  const typing = !!k.text && !(bits & (MOD_BIT.Control | MOD_BIT.Alt | MOD_BIT.Meta))
  const shifted = bits & MOD_BIT.Shift && k.key.length === 1 ? k.key.toUpperCase() : k.key
  down.push(
    typing
      ? { type: 'keyDown', key: shifted, code: k.code, windowsVirtualKeyCode: k.keyCode, text: bits & MOD_BIT.Shift ? shifted : k.text, unmodifiedText: k.text, modifiers: bits }
      : { type: 'rawKeyDown', key: shifted, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: bits, commands: chordCommands(k, bits) }
  )
  up.push({ type: 'keyUp', key: shifted, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: bits })
  for (const m of [...mods].reverse()) {
    bits &= ~MOD_BIT[m]
    const d = NAMED[m]
    up.push({ type: 'keyUp', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, modifiers: bits })
  }
  return { down, up }
}

// editing shortcuts only work from a raw key event when the command is named explicitly
function chordCommands(k: KeyDef, bits: number): string[] | undefined {
  if (!(bits & (MOD_BIT.Control | MOD_BIT.Meta)) || k.key.length !== 1) return undefined
  const c = k.key.toLowerCase()
  const map: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' }
  if (c === 'z' && bits & MOD_BIT.Shift) return ['redo']
  return map[c] ? [map[c]] : undefined
}
