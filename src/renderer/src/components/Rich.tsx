import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { Marked } from 'marked'
import { memo, useMemo, type MouseEvent } from 'react'
import type { FileDiff } from '@shared/types'
import { api } from '../store'

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
  // a local path is revealed, not run: a link in model output must not launch an .exe on one click
  if (/^https?:\/\//i.test(href)) void api.app.openExternal(href)
  else void api.app.revealPath(href)
}

/** Right-click on a chat message: link actions when on a link, then copy actions. */
export function messageMenu(e: MouseEvent<HTMLElement>, markdown?: string): void {
  e.preventDefault()
  const href = (e.target as HTMLElement).closest('a')?.getAttribute('href') || undefined
  const selection = window.getSelection()?.toString() || undefined
  void api.app.contextMenu({ href, selection, text: e.currentTarget.innerText.trim() || undefined, markdown })
}

export function imageMenu(e: MouseEvent<HTMLElement>, image: string, imageName: string): void {
  e.preventDefault()
  e.stopPropagation()
  void api.app.contextMenu({ image, imageName })
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
