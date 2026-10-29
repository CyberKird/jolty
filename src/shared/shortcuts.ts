import { tr } from './i18n'

export type ShortcutGroup = 'general' | 'chat' | 'composer'

/** `keys` are shown one chip each; 'Mod' is Ctrl (Cmd on a Mac). Add a shortcut by adding a line to SHORTCUTS. */
export interface Shortcut {
  group: ShortcutGroup
  keys: string[]
  label: () => string
}

export const SHORTCUT_GROUPS: { id: ShortcutGroup; label: () => string }[] = [
  { id: 'general', label: () => tr("General") },
  { id: 'chat', label: () => tr("Conversație") },
  { id: 'composer', label: () => tr("Câmpul de scris") }
]

// every line matches a real handler: App.tsx, Chat.tsx (composer), ChatTools.tsx, FindBar.tsx, Shortcuts.tsx, ModelPicker.tsx, VoiceButton.tsx, Sidebar.tsx, main/computer/native.ts
export const SHORTCUTS: Shortcut[] = [
  { group: 'general', keys: ['Mod', 'N'], label: () => tr("Conversație nouă") },
  { group: 'general', keys: ['Mod', 'K'], label: () => tr("Caută în conversații") },
  { group: 'general', keys: ['Mod', 'B'], label: () => tr("Arată sau ascunde bara laterală") },
  { group: 'general', keys: ['Mod', 'L'], label: () => tr("Arată sau ascunde panoul Live") },
  { group: 'general', keys: ['Alt', '1-9'], label: () => tr("Deschide a N-a conversație din lista Live") },
  { group: 'general', keys: ['Mod', '/'], label: () => tr("Această listă de scurtături") },
  { group: 'general', keys: ['Alt', '↑ ↓'], label: () => tr("Mută o secțiune sau un cont în listă (cu elementul în focus)") },
  { group: 'general', keys: ['Ctrl', 'Alt', 'Esc'], label: () => tr("Oprește imediat controlul calculatorului") },
  { group: 'general', keys: ['Esc'], label: () => tr("Închide fereastra, previzualizarea sau meniul deschis") },
  { group: 'chat', keys: ['Mod', 'F'], label: () => tr("Caută în conversația deschisă") },
  { group: 'chat', keys: ['Enter'], label: () => tr("La căutare: următoarea potrivire") },
  { group: 'chat', keys: ['Shift', 'Enter'], label: () => tr("La căutare: potrivirea anterioară") },
  { group: 'chat', keys: ['Ctrl', 'Shift', 'C'], label: () => tr("Copiază ultimul răspuns") },
  { group: 'chat', keys: ['Ctrl', 'Alt', 'C'], label: () => tr("Copiază ultimul bloc de cod") },
  { group: 'composer', keys: ['Enter'], label: () => tr("Trimite mesajul") },
  { group: 'composer', keys: ['Shift', 'Enter'], label: () => tr("Rând nou") },
  { group: 'composer', keys: ['Mod', 'Shift', 'Enter'], label: () => tr("Trimite în paralel (împarte lucrul în sesiuni)") },
  { group: 'composer', keys: ['Shift', 'Tab'], label: () => tr("Schimbă modul de permisiuni") },
  { group: 'composer', keys: ['1-5'], label: () => tr("Alege un mod cât timp meniul modurilor e deschis") },
  { group: 'composer', keys: ['↑ ↓', 'Enter'], label: () => tr("Alege din meniul @ sau /") },
  { group: 'composer', keys: ['Esc'], label: () => tr("Oprește răspunsul în curs, sau anulează înregistrarea vocală") }
]

/** What the chips of a shortcut show on this system. */
export function keyLabels(keys: string[], mac: boolean): string[] {
  return keys.map((k) => (k === 'Mod' ? (mac ? '⌘' : 'Ctrl') : k))
}

/** The shortcuts of one group, in the order of the list. */
export function shortcutsIn(group: ShortcutGroup): Shortcut[] {
  return SHORTCUTS.filter((s) => s.group === group)
}
