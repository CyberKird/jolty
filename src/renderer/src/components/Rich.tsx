import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { Marked } from 'marked'
import { FileText } from 'lucide-react'
import { memo, useMemo, type MouseEvent } from 'react'
import type { FileDiff } from '@shared/types'
import { api, errMsg, useStore } from '../store'
import { copyItem, imageItems, itemsAt, showMenu } from './ContextMenu'

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

const marked = new Marked({
  gfm: true,
  breaks: false,
  walkTokens(token) {
    if (token.type !== 'link') return
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
  },
  renderer: {
    code({ text, lang }) {
      return `<pre><code class="hljs">${highlight(text, lang || undefined)}</code></pre>`
    }
  }
})

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
  showMenu(e, [...itemsAt(e.target as Element), 'sep', ...(text ? [copyItem('Copiază mesajul', text)] : []), ...(markdown ? [copyItem('Copiază ca Markdown', markdown, FileText)] : [])])
}

export function imageMenu(e: MouseEvent<HTMLElement>, image: string, imageName: string): void {
  e.stopPropagation()
  showMenu(e, imageItems(image, imageName))
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(plainDashes(text), { async: false }) as string), [text])
  return <div className="md" onClick={onLinkClick} dangerouslySetInnerHTML={{ __html: html }} />
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
            {d.kind === 'add' ? 'fișier nou · ' : d.kind === 'delete' ? 'șters · ' : ''}
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
