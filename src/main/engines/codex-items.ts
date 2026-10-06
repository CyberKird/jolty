import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Attachment, ChatItem, FileDiff, PlanStep } from '@shared/types'
import { truncate } from './format'

type Any = any

export function planItemSteps(text: string): PlanStep[] {
  const lines = text.split('\n').map((line) => line.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/)?.[1]?.trim()).filter((line): line is string => Boolean(line))
  return (lines.length ? lines : [text.trim()]).filter(Boolean).map((step) => ({ text: step, status: 'pending' }))
}

function toolStatus(s: string | undefined): 'running' | 'done' | 'error' {
  if (s === 'completed') return 'done'
  if (s === 'failed' || s === 'declined') return 'error'
  return 'running'
}

/** Converts one app-server thread item into a Jolty chat item (undefined = not shown). */
export function codexItem(item: Any, liveOutput?: string): ChatItem | undefined {
  switch (item?.type) {
    case 'userMessage': {
      const text = (item.content || []).filter((c: Any) => c.type === 'text').map((c: Any) => c.text).join('\n')
      return text ? { kind: 'user', id: item.id, text } : undefined
    }
    case 'agentMessage':
      return { kind: 'assistant', id: item.id, text: item.text || '' }
    case 'reasoning':
      return { kind: 'reasoning', id: item.id, text: (item.summary || []).join('\n\n') }
    case 'plan':
      return { kind: 'reasoning', id: item.id, text: item.text || '' }
    case 'commandExecution':
      return {
        kind: 'tool',
        id: item.id,
        name: 'Shell',
        title: `$ ${item.command}`,
        command: item.command,
        status: toolStatus(item.status),
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : undefined,
        output: truncate(item.aggregatedOutput ?? liveOutput ?? '')
      }
    case 'fileChange': {
      const diffs: FileDiff[] = (item.changes || []).map((c: Any) => ({ path: c.path, kind: c.kind?.type || 'update', diff: truncate(c.diff || '', 30000) }))
      return { kind: 'tool', id: item.id, name: 'Edit', title: `Editează ${diffs.map((d) => d.path).join(', ')}`, status: toolStatus(item.status), diffs }
    }
    case 'mcpToolCall':
      return {
        kind: 'tool',
        id: item.id,
        name: `${item.server}/${item.tool}`,
        title: `${item.server} / ${item.tool}`,
        status: toolStatus(item.status),
        input: item.arguments,
        output: item.error ? String(item.error.message ?? JSON.stringify(item.error)) : item.result ? truncate(JSON.stringify(item.result.content ?? item.result, null, 2)) : undefined
      }
    case 'webSearch':
      return { kind: 'tool', id: item.id, name: 'WebSearch', title: `Caută pe web: ${item.query ?? ''}`, status: 'done' }
    case 'contextCompaction':
      return { kind: 'notice', id: item.id, text: 'Conversația a fost compactată ca să încapă în context.', level: 'info' }
    default:
      return undefined
  }
}

/** Writes pasted images to temp files: app-server takes images by path. */
export function saveImages(images: Attachment[]): string[] {
  const dir = path.join(os.tmpdir(), 'jolty-images')
  fs.mkdirSync(dir, { recursive: true })
  return images.map((img) => {
    const ext = img.mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    const file = path.join(dir, `${randomUUID()}.${ext}`)
    fs.writeFileSync(file, Buffer.from(img.data!, 'base64'))
    return file
  })
}

