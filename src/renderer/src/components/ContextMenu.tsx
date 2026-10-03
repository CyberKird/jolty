// The right-click menu, drawn in Jolty's theme (not the Windows one). Every place that wants a menu builds a list of
// entries; whatever nobody claimed falls to the document-level listener, which reads links, paths, code and selections.
import { ClipboardPaste, Copy, Download, ExternalLink, FileCode, FolderOpen, Image as ImageIcon, Link, Redo2, Scissors, TextSelect, Undo2, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { EditAction } from '@shared/types'
import { api } from '../store'

export interface MenuItem {
  label: string
  icon?: LucideIcon
  /** shortcut shown on the right */
  hint?: string
  disabled?: boolean
  run: () => void
}
export type Entry = MenuItem | 'sep'

interface MenuState {
  at?: { x: number; y: number }
  items: Entry[]
  show: (at: { x: number; y: number }, items: Entry[]) => void
  hide: () => void
}

const useMenu = create<MenuState>((set) => ({
  items: [],
  show: (at, items) => set({ at, items }),
  hide: () => set({ at: undefined, items: [] })
}))

/** No separator first, last or twice in a row. */
function tidy(entries: Entry[]): Entry[] {
  const out: Entry[] = []
  for (const e of entries) if (e !== 'sep' || (out.length && out[out.length - 1] !== 'sep')) out.push(e)
  while (out[out.length - 1] === 'sep') out.pop()
  return out
}

export function showMenu(e: { clientX: number; clientY: number; preventDefault(): void }, entries: Entry[]): void {
  e.preventDefault()
  const items = tidy(entries)
  if (items.length) useMenu.getState().show({ x: e.clientX, y: e.clientY }, items)
}

export const copyItem = (label: string, text: string, icon: LucideIcon = Copy): MenuItem => ({ label, icon, run: () => void api.app.copyText(text) })

const editItem = (label: string, action: EditAction, icon: LucideIcon, hint: string, disabled = false): MenuItem => ({ label, icon, hint, disabled, run: () => void api.app.edit(action) })

/** Items for a file or folder on disk. */
export function pathItems(p: string): Entry[] {
  return [
    { label: 'Deschide', icon: FileCode, run: () => void api.app.openLocal(p) },
    { label: 'Arată în Explorer', icon: FolderOpen, run: () => void api.app.revealPath(p) },
    copyItem('Copiază calea', p, Link)
  ]
}

export function imageItems(image: string, name: string): Entry[] {
  return [
    { label: 'Copiază imaginea', icon: Copy, run: () => void api.app.image('copy', image, name) },
    { label: 'Salvează imaginea...', icon: Download, run: () => void api.app.image('save', image, name) },
    { label: 'Deschide imaginea', icon: ImageIcon, run: () => void api.app.image('open', image, name) }
  ]
}

/** What a right-click on `el` offers by itself: text fields, links, files, code and the selected text. */
export function itemsAt(el: Element | null): Entry[] {
  const out: Entry[] = []
  const group = (...g: Entry[]): void => {
    if (out.length && g.length) out.push('sep')
    out.push(...g)
  }
  const field = el?.closest<HTMLInputElement | HTMLTextAreaElement>('textarea, input[type="text"], input[type="search"], input[type="password"], input:not([type])')
  if (field && !field.disabled) {
    const picked = field.selectionStart !== field.selectionEnd
    if (field.readOnly) return picked ? [editItem('Copiază', 'copy', Copy, 'Ctrl+C'), editItem('Selectează tot', 'selectAll', TextSelect, 'Ctrl+A')] : [editItem('Selectează tot', 'selectAll', TextSelect, 'Ctrl+A')]
    return [
      editItem('Anulează', 'undo', Undo2, 'Ctrl+Z'),
      editItem('Reface', 'redo', Redo2, 'Ctrl+Y'),
      'sep',
      editItem('Taie', 'cut', Scissors, 'Ctrl+X', !picked),
      editItem('Copiază', 'copy', Copy, 'Ctrl+C', !picked),
      editItem('Lipește', 'paste', ClipboardPaste, 'Ctrl+V'),
      editItem('Selectează tot', 'selectAll', TextSelect, 'Ctrl+A')
    ]
  }
  const href = el?.closest('a[href]')?.getAttribute('href') || ''
  if (/^https?:\/\//i.test(href)) {
    group({ label: 'Deschide linkul', icon: ExternalLink, run: () => void api.app.openLink(href) }, copyItem('Copiază linkul', href, Link))
  } else if (href && !href.startsWith('#')) {
    group(...pathItems(href))
  }
  const path = el?.closest<HTMLElement>('[data-path]')?.dataset.path
  if (path) group(...pathItems(path))
  const selected = window.getSelection()?.toString().trim()
  if (selected) group(copyItem('Copiază', selected))
  const code = el?.closest('pre')
  if (code && !selected) group(copyItem('Copiază codul', code.innerText.trim(), FileCode))
  return out
}

export function ContextMenu() {
  const { at, items, hide } = useMenu()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number }>()
  const [active, setActive] = useState(-1)

  // anything nobody built a menu for: what the click landed on decides
  useEffect(() => {
    const onMenu = (e: MouseEvent): void => {
      if (e.defaultPrevented) return
      showMenu(e, itemsAt(e.target as Element))
    }
    document.addEventListener('contextmenu', onMenu)
    return () => document.removeEventListener('contextmenu', onMenu)
  }, [])

  // placed after it is measured, so it never hangs off the window
  useLayoutEffect(() => {
    setActive(-1)
    if (!at || !ref.current) return setPos(undefined)
    const { width, height } = ref.current.getBoundingClientRect()
    setPos({ x: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - height - 8)) })
  }, [at, items])

  useEffect(() => {
    if (!at) return
    const usable = (): number[] => items.flatMap((it, i) => (it !== 'sep' && !it.disabled ? [i] : []))
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) hide()
    }
    // the keys go to the menu, not to the text field behind it, whose focus stays where it was
    const onKey = (e: KeyboardEvent): void => {
      const list = usable()
      if (e.key === 'Escape') hide()
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const from = list.indexOf(active)
        setActive(list[(from + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length] ?? -1)
      } else if (e.key === 'Enter' && active >= 0) {
        const it = items[active]
        hide()
        if (it !== 'sep') it.run()
      } else return
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    window.addEventListener('wheel', hide, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
      window.removeEventListener('wheel', hide, true)
    }
  }, [at, items, active, hide])

  if (!at) return null
  return (
    <div
      className="ctx"
      ref={ref}
      role="menu"
      style={{ left: pos?.x ?? at.x, top: pos?.y ?? at.y, visibility: pos ? 'visible' : 'hidden' }}
      // a click on the menu must not take focus or the selection from the page: Cut, Copy and Paste act on it
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it === 'sep' ? (
          <div className="ctx-sep" role="separator" key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`ctx-item ${active === i ? 'on' : ''}`}
            disabled={it.disabled}
            onMouseEnter={() => setActive(it.disabled ? -1 : i)}
            onClick={() => {
              hide()
              it.run()
            }}
          >
            {it.icon && <it.icon size={14} strokeWidth={1.6} />}
            <span className="ctx-label">{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        )
      )}
    </div>
  )
}
