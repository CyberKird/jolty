import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { Marked } from 'marked'
import { FileCode, FileText } from 'lucide-react'
import { memo, useMemo, type KeyboardEvent, type MouseEvent } from 'react'
import { isShell, shellCommand, valueKind } from '@shared/copy-values'
import type { FileDiff } from '@shared/types'
import { api, errMsg, useStore } from '../store'
import { chipText, copyText, lastCodeBlock, runAct } from '../copy'
import { copyItem, imageItems, itemsAt, showMenu } from './ContextMenu'
import { tr } from '@shared/i18n'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function highlight(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    if (code.length < 20000) return hljs.highlightAuto(code).value
  } catch {
    // fall through to plain text
  }
  return escapeHtml(code)
}

/** Colouring for a file the model is still writing: auto-detecting the language is slow, so without a known one it stays plain text. */
export function highlightLive(code: string, lang?: string): string {
  return lang && hljs.getLanguage(lang) ? highlight(code, lang) : escapeHtml(code)
}

const attr = (s: string): string => escapeHtml(s).replace(/"/g, '&quot;')
const unEntity = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** A control inside rendered Markdown. Its words are CSS content (never in a selection or in innerText); one delegated handler runs it. */
const control = (act: string, label: string, text = '', done = ''): string =>
  `<button type="button" class="cp" data-act="${act}" aria-label="${attr(label)}" title="${attr(label)}"><i class="ic ic-${act}" aria-hidden="true"></i>${text ? `<span class="lbl" aria-hidden="true" data-t="${attr(text)}" data-ok="${attr(done)}"></span>` : ''}</button>`

/** A block longer than this folds, with a fade and a button; the whole text is still what Copy takes. */
const FOLD_LINES = 28

function newMarked(fold: boolean): Marked {
  return new Marked({
    gfm: true,
    breaks: false,
    walkTokens,
    renderer: {
      code({ text, lang }) {
        const l = (lang || '').trim().split(/\s+/)[0]
        const lines = text.split('\n').length
        const long = fold && lines > FOLD_LINES
        const shell = isShell(l)
        const copied = tr("Copiat")
        // a terminal block copies its commands; when sample output is mixed in, the whole block is a second button
        const main = shell ? control('cmd', tr("Copiază comanda"), tr("Comandă"), copied) : control('code', tr("Copiază codul"), tr("Copiază"), copied)
        const all = shell && shellCommand(text) !== text ? control('code', tr("Copiază codul"), tr("Tot"), copied) : ''
        return `<div class="cb"${long ? ' data-long' : ''}><div class="cb-head"><span class="cb-lang" data-t="${attr(l)}"></span><span class="cb-acts">${control('wrap', tr("Împachetează liniile"))}${all}${main}</span></div><pre><code class="hljs${l ? ` language-${attr(l)}` : ''}">${highlight(text, lang || undefined)}</code></pre>${
          long ? `<button type="button" class="cb-more" data-act="more" aria-expanded="false" data-t="${attr(tr("Arată tot ({n} linii)", { n: lines }))}" data-t2="${attr(tr("Restrânge"))}"></button>` : ''
        }</div>`
      },
      // a span that looks like a value to copy becomes a chip; an ordinary word stays plain code
      codespan({ text }) {
        const kind = valueKind(unEntity(text))
        return kind ? `<code class="cv" data-k="${kind}" data-t="${attr(tr("Clic pentru a copia"))}" role="button" tabindex="0">${text}</code>` : `<code>${text}</code>`
      }
    }
  })
}

function walkTokens(token: { type: string; href?: string }): void {
  if (token.type !== 'link' || !token.href) return
  // A leading slash keeps Windows paths valid under the sanitizer's normal URL rules.
  if (/^[a-z]:[\\/]/i.test(token.href)) token.href = `/${token.href}`
  else if (/^file:\/\//i.test(token.href)) {
    try {
      const url = new URL(token.href)
      if (!url.hostname) token.href = url.pathname
    } catch {
      // Invalid file URLs stay subject to the sanitizer's default checks.
    }
  }
}

// a reply still arriving is not folded: the reader watches the code being written
const marked = newMarked(true)
const markedLive = newMarked(false)

const tableOpen = (): string => `<div class="tbl"><span class="tbl-acts" role="group" aria-label="${attr(tr("Copiază tabelul"))}">${control('md', tr("Copiază tabelul ca Markdown"), 'MD', tr("Copiat"))}${control('tsv', tr("Copiază tabelul ca TSV (Excel, Sheets)"), 'TSV', tr("Copiat"))}${control('csv', tr("Copiază tabelul ca CSV"), 'CSV', tr("Copiat"))}</span><div class="tbl-scroll"><table>`

/**
 * Em and en dashes in prose become plain hyphens, as the user wants none in the app. Code blocks and
 * inline code keep their exact characters, since they show what is really in the files.
 */
export function plainDashes(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/([ \t]*)[\u2013\u2014]([ \t]*)/g, (_m, before: string, after: string, at: number, s: string) =>
            at === 0 || s[at - 1] === '\n' ? `${before}-${after}` : before || after ? ' - ' : '-'
          )
    )
    .join('')
}

// chat text is rendered via dangerouslySetInnerHTML, so links carry no onClick; a plain <a>
// click would navigate the app's own window (or silently do nothing under CSP). Route it instead.
function onLinkClick(e: MouseEvent<HTMLDivElement>): void {
  const a = (e.target as HTMLElement).closest('a')
  const href = a?.getAttribute('href')
  if (!href || href.startsWith('#')) return
  e.preventDefault()
  // The main process opens documents and reveals executable files without running them.
  const opened = /^https?:\/\//i.test(href) ? api.app.openExternal(href) : api.app.openLocal(href)
  void opened.catch((err) => useStore.getState().toast(errMsg(err), true))
}

/** Right-click on a chat message: link actions when on a link, then copy actions. */
export function messageMenu(e: MouseEvent<HTMLElement>, markdown?: string): void {
  const text = e.currentTarget.innerText.trim()
  const shown = markdown && plainDashes(markdown)
  const code = shown ? lastCodeBlock(shown) : ''
  showMenu(e, [
    ...itemsAt(e.target as Element),
    'sep',
    ...(text ? [copyItem(tr("Copiază mesajul"), text)] : []),
    ...(shown ? [copyItem(tr("Copiază ca Markdown"), shown, FileText)] : []),
    ...(code ? [copyItem(tr("Copiază ultimul bloc de cod"), code, FileCode)] : [])
  ])
}

export function imageMenu(e: MouseEvent<HTMLElement>, image: string, imageName: string): void {
  e.stopPropagation()
  showMenu(e, imageItems(image, imageName))
}

/** One click handler for everything inside a message: copy buttons, copy chips and links. */
function onMdClick(e: MouseEvent<HTMLDivElement>): void {
  const t = e.target as HTMLElement
  const act = t.closest<HTMLElement>('[data-act]')
  if (act) return runAct(act)
  const chip = t.closest<HTMLElement>('code.cv')
  // dragging over a chip to select it is not a click to copy; a chip inside a link follows the link
  if (chip && !chip.closest('a') && window.getSelection()?.isCollapsed !== false) return copyText(chipText(chip), chip)
  onLinkClick(e)
}

function onMdKey(e: KeyboardEvent<HTMLDivElement>): void {
  const chip = e.target as HTMLElement
  if ((e.key === 'Enter' || e.key === ' ') && chip.matches('code.cv')) {
    e.preventDefault()
    copyText(chipText(chip), chip)
  }
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => {
    const out = (streaming ? markedLive : marked).parse(plainDashes(text), { async: false }) as string
    return DOMPurify.sanitize(out.includes('<table>') ? out.replace(/<table>/g, tableOpen()).replace(/<\/table>/g, '</table></div></div>') : out)
  }, [text, streaming])
  return <div className="md" onClick={onMdClick} onKeyDown={onMdKey} dangerouslySetInnerHTML={{ __html: html }} />
})

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  cs: 'csharp',
  cpp: 'cpp',
  c: 'c',
  h: 'cpp',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  xml: 'xml',
  json: 'json',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  sh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  lua: 'lua',
  gd: 'python'
}

export function langOf(path?: string): string | undefined {
  const ext = path?.split('.').pop()?.toLowerCase()
  return ext ? EXT_LANG[ext] : undefined
}

export function DiffView({ diffs }: { diffs: FileDiff[] }) {
  return (
    <div className="diff">
      {diffs.map((d, i) => (
        <div key={i}>
          <div className="diff-file">
            {d.kind === 'add' ? tr("fișier nou · ") : d.kind === 'delete' ? tr("șters · ") : ''}
            {d.path}
          </div>
          {d.diff.split('\n').map((line, j) => {
            const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''
            return (
              <div key={j} className={`diff-line ${cls}`}>
                {line || ' '}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
