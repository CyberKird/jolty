import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_QUICK_KEY, hotkeyFromEvent, keepsRunning, parseHotkey, quickKeyOf } from '../src/shared/background'

test('shortcuts are normalized to one Electron accelerator', () => {
  assert.deepEqual(parseHotkey('ctrl+alt+space'), { key: 'Ctrl+Alt+Space' })
  assert.deepEqual(parseHotkey(' Alt + Control + j '), { key: 'Ctrl+Alt+J' })
  assert.deepEqual(parseHotkey('Win+Shift+F12'), { key: 'Shift+Super+F12' })
  assert.deepEqual(parseHotkey('CommandOrControl+Shift+1'), { key: 'Ctrl+Shift+1' })
  assert.deepEqual(parseHotkey(DEFAULT_QUICK_KEY), { key: DEFAULT_QUICK_KEY })
})

test('bad or taken shortcuts are refused with a reason', () => {
  assert.deepEqual(parseHotkey('Space'), { error: 'no-modifier' })
  assert.deepEqual(parseHotkey('Shift+A'), { error: 'no-modifier' })
  assert.deepEqual(parseHotkey('Ctrl+Alt'), { error: 'no-key' })
  assert.deepEqual(parseHotkey('Ctrl+A+B'), { error: 'two-keys' })
  assert.deepEqual(parseHotkey('Ctrl+Ä'), { error: 'unknown-key' })
  assert.deepEqual(parseHotkey(''), { error: 'no-key' })
  // the PC-control kill key and Windows' own combinations stay theirs
  assert.deepEqual(parseHotkey('Ctrl+Alt+Esc'), { error: 'reserved' })
  assert.deepEqual(parseHotkey('alt+control+escape'), { error: 'reserved' })
  assert.deepEqual(parseHotkey('Ctrl+Alt+Del'), { error: 'reserved' })
  assert.deepEqual(parseHotkey('Alt+F4'), { error: 'reserved' })
})

test('the Settings recorder reads the physical key', () => {
  const ev = (key: string, code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>>) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, key, code, ...mods })
  assert.equal(hotkeyFromEvent(ev('Control', 'ControlLeft', { ctrlKey: true })), undefined)
  assert.equal(hotkeyFromEvent(ev(' ', 'Space', { ctrlKey: true, altKey: true })), 'Ctrl+Alt+Space')
  assert.equal(hotkeyFromEvent(ev('!', 'Digit1', { altKey: true, shiftKey: true })), 'Alt+Shift+1')
  assert.equal(hotkeyFromEvent(ev('q', 'KeyQ', { metaKey: true })), 'Super+Q')
  assert.deepEqual(parseHotkey(hotkeyFromEvent(ev('F5', 'F5', { ctrlKey: true }))!), { key: 'Ctrl+F5' })
})

test('background mode: on in the installed app, off in dev and test runs, the setting wins', () => {
  assert.equal(keepsRunning({}, true), true)
  assert.equal(keepsRunning({}, false), false)
  assert.equal(keepsRunning({ keepInBackground: false }, true), false)
  assert.equal(keepsRunning({ keepInBackground: true }, false), true)
  assert.equal(quickKeyOf({}), DEFAULT_QUICK_KEY)
  assert.equal(quickKeyOf({ quickKey: '' }), '')
})
