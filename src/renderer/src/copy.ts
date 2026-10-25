// Copying out of the chat: one clipboard path, a 1.2 s tick on the control that was used, a polite announcement for screen readers.
import { codeBlocks, shellCommand, tableText, type TableFormat } from '@shared/copy-values'
import { tr } from '@shared/i18n'
import { api, useStore } from './store'

const timers = new WeakMap<Element, number>()

/** The tick lives in a data attribute, so no component re-renders and nothing moves. */
export function flash(el?: Element | null): void {
  if (!el) return
  window.clearTimeout(timers.get(el))
  el.setAttribute('data-copied', '')
  timers.set(el, window.setTimeout(() => el.removeAttribute('data-copied'), 1200))
}

export function announce(text: string): void {
  const live = document.getElementById('copy-live')
  if (!live) return
  live.textContent = ''
  window.setTimeout(() => (live.textContent = text), 30)
}

export function copyText(text: string, from?: Element | null, said = tr("Copiat")): void {
  if (!text) return
  void api.app.copyText(text)
  flash(from)
  announce(said)
}

/** A copy that has no control to tick (a shortcut): the toast says it. */
export function copyWithToast(text: string, said: string): void {
  if (!text) return
  void api.app.copyText(text)
  announce(said)
  useStore.getState().toast(said)
}

/** Text of a tool or message, as the page shows it: the labels of the buttons are CSS content, so they are never in it. */
export const shownText = (el: Element | null | undefined): string => (el as HTMLElement | null)?.innerText.trim() || ''

function tableRows(table: HTMLTableElement): string[][] {
  return [...table.rows].map((r) => [...r.cells].map((c) => c.textContent || ''))
}

/** The buttons the Markdown renderer puts in the HTML (code blocks, tables, chips): one place decides what each copies. */
export function runAct(btn: HTMLElement): void {
  const act = btn.dataset.act
  const block = btn.closest<HTMLElement>('.cb')
  if (act === 'wrap' && block) {
    const on = block.toggleAttribute('data-wrap')
    btn.setAttribute('aria-pressed', String(on))
  } else if (act === 'more' && block) {
    btn.setAttribute('aria-expanded', String(block.toggleAttribute('data-open')))
  } else if (act === 'code' && block) {
    copyText(block.querySelector('pre')?.textContent || '', btn)
  } else if (act === 'cmd' && block) {
    copyText(shellCommand(block.querySelector('pre')?.textContent || ''), btn, tr("Comandă copiată"))
  } else if ((act === 'md' || act === 'tsv' || act === 'csv') && btn.closest('.tbl')) {
    const table = btn.closest('.tbl')?.querySelector('table')
    if (table) copyText(tableText(tableRows(table), act as TableFormat), btn, tr("Tabel copiat"))
  }
}

/** The text of a copy chip: a command typed with its `$ ` prompt copies without it. */
export const chipText = (chip: Element): string => {
  const t = (chip.textContent || '').trim()
  return chip.getAttribute('data-k') === 'command' ? shellCommand(t) : t
}

export function lastCodeBlock(markdown: string): string {
  return codeBlocks(markdown).pop()?.code || ''
}

// ---- selection as Markdown ----

const SKIP = 'button, .cb-head, .tbl-acts, .cb-more'
const FORMATTED = 'strong, b, em, i, code, a, li, h1, h2, h3, h4, h5, h6, pre, table, blockquote'

/** True when the selected fragment holds formatting worth keeping, so "Copy as Markdown" is offered. */
export function isFormatted(frag: DocumentFragment): boolean {
  return Boolean(frag.querySelector(FORMATTED))
}

function walk(node: Node, out: { s: string }, list?: { ordered: boolean; n: number }): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.s += (node.textContent || '').replace(/\s+/g, ' ')
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return
  const el = node as HTMLElement
  if (el.matches?.(SKIP)) return
  const inner = (l = list): string => {
    const o = { s: '' }
    el.childNodes.forEach((c) => walk(c, o, l))
    return o.s
  }
  const tag = el.tagName?.toLowerCase()
  const block = (s: string): string => `\n\n${s.trim()}\n\n`
  switch (tag) {
    case 'strong':
    case 'b':
      out.s += `**${inner().trim()}**`
      break
    case 'em':
    case 'i':
      out.s += `*${inner().trim()}*`
      break
    case 'code':
      out.s += `\`${el.textContent}\``
      break
    case 'a':
      out.s += `[${inner()}](${el.getAttribute('href') || ''})`
      break
    case 'br':
      out.s += '\n'
      break
    case 'pre': {
      const lang = /language-(\w+)/.exec(el.querySelector('code')?.className || '')?.[1] || el.closest('.cb')?.querySelector('.cb-lang')?.getAttribute('data-t') || ''
      out.s += block('```' + lang + '\n' + (el.textContent || '').replace(/\n$/, '') + '\n```')
      break
    }
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      out.s += block('#'.repeat(Number(tag[1])) + ' ' + inner().trim())
      break
    case 'ul':
    case 'ol': {
      const l = { ordered: tag === 'ol', n: 0 }
      out.s += `\n${inner(l)}\n`
      break
    }
    case 'li': {
      const mark = list?.ordered ? `${++list.n}.` : '-'
      out.s += `${mark} ${inner(list).trim().replace(/\n/g, '\n  ')}\n`
      break
    }
    case 'blockquote':
      out.s += block(inner().trim().split('\n').map((l) => `> ${l}`).join('\n'))
      break
    case 'table':
      out.s += block(tableText(tableRows(el as HTMLTableElement), 'md'))
      break
    case 'p':
    case 'div':
      out.s += block(inner())
      break
    default:
      out.s += inner()
  }
}

export function fragmentMarkdown(frag: DocumentFragment): string {
  const out = { s: '' }
  walk(frag, out)
  return out.s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
