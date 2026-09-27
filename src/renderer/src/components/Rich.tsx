import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { Marked } from 'marked'
import { memo, useMemo } from 'react'
import type { FileDiff } from '@shared/types'

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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
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
