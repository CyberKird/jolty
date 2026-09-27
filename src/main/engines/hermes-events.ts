import { randomUUID } from 'crypto'
import type { ChatEvent, ChatItem, FileDiff } from '@shared/types'

export type AcpObject = Record<string, any>
export const object = (value: unknown): AcpObject => value && typeof value === 'object' && !Array.isArray(value) ? value as AcpObject : {}
export const list = (value: unknown): AcpObject[] => Array.isArray(value) ? value.map(object) : []
export const str = (value: unknown): string => typeof value === 'string' ? value : ''
export const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

export function toolDiffs(content: unknown): FileDiff[] {
  return list(content).filter((c) => c.type === 'diff' && typeof c.path === 'string' && typeof c.newText === 'string').map((c) => ({
    path: c.path,
    kind: c.oldText == null ? 'add' : 'update',
    diff: `--- ${c.path}\n+++ ${c.path}\n` + (typeof c.oldText === 'string' ? c.oldText.split('\n').map((s: string) => `-${s}`).join('\n') + '\n' : '') + c.newText.split('\n').map((s: string) => `+${s}`).join('\n')
  }))
}

function contentText(value: unknown): string {
  return list(value).map((c) => c.type === 'content' ? str(object(c.content).text) : '').filter(Boolean).join('\n')
}

/** Folds partial ACP tool updates and adjacent streamed chunks into Jolty's transcript. */
export class HermesEvents {
  private tools = new Map<string, AcpObject>()
  private chunk?: { id: string; kind: string; text: string }
  constructor(private sessionId: string, private emit: (event: ChatEvent) => void) {}

  reset(): void { this.chunk = undefined; this.tools.clear() }

  update(update: unknown): void {
    const u = object(update)
    const type = str(u.sessionUpdate)
    if (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(type)) {
      const text = str(object(u.content).text)
      if (!text) return
      const kind = type === 'agent_message_chunk' ? 'assistant' : type === 'agent_thought_chunk' ? 'reasoning' : 'user'
      if (this.chunk?.kind !== kind) this.chunk = { id: randomUUID(), kind, text: '' }
      this.chunk.text += text
      if (kind === 'user') this.emit({ type: 'item', sessionId: this.sessionId, item: { kind, id: this.chunk.id, text: this.chunk.text } })
      else this.emit({ type: 'delta', sessionId: this.sessionId, kind, itemId: this.chunk.id, delta: text })
      return
    }
    if (type === 'tool_call' || type === 'tool_call_update') {
      this.chunk = undefined
      const id = str(u.toolCallId)
      if (!id) return
      const defined = Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined && v !== null))
      const merged = { ...this.tools.get(id), ...defined }
      this.tools.set(id, merged)
      const latestDiffs = toolDiffs(merged.content)
      const diffs = latestDiffs.length ? latestDiffs : merged.savedDiffs || []
      merged.savedDiffs = diffs
      const latestDrafts = list(merged.content).filter((c) => c.type === 'diff' && typeof c.newText === 'string')
      if (latestDrafts.length) merged.savedDrafts = latestDrafts
      const output = contentText(merged.content) || (typeof merged.rawOutput === 'string' ? merged.rawOutput : merged.rawOutput == null ? '' : JSON.stringify(merged.rawOutput))
      const input = object(merged.rawInput)
      const item: ChatItem = {
        kind: 'tool', id, name: str(merged.kind) || 'Hermes', title: str(merged.title) || 'Unealtă Hermes',
        status: merged.status === 'completed' ? 'done' : merged.status === 'failed' ? 'error' : 'running',
        input: merged.rawInput, output, diffs,
        command: merged.kind === 'execute' ? str(input.command) || output.match(/(?:^|\n)\$ (.+)/)?.[1] || merged.savedCommand : undefined
      }
      merged.savedCommand = item.command
      this.emit({ type: 'item', sessionId: this.sessionId, item })
      for (const c of merged.savedDrafts || []) {
        if (c.type === 'diff' && typeof c.newText === 'string') this.emit({ type: 'draft', sessionId: this.sessionId, toolId: id, name: item.title, path: str(c.path), content: c.newText, done: item.status !== 'running' })
      }
    } else if (type === 'plan') {
      this.emit({ type: 'plan', sessionId: this.sessionId, steps: list(u.entries).map((e) => ({ text: str(e.content), status: e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'active' : 'pending' })) })
    } else if (type === 'usage_update') {
      this.emit({ type: 'context', sessionId: this.sessionId, used: count(u.used), window: count(u.size) || undefined })
    }
  }
}

export function collectHistory(items: ChatItem[], event: ChatEvent): void {
  if (event.type === 'item') {
    const i = items.findIndex((x) => x.id === event.item.id)
    if (i < 0) items.push(event.item)
    else items[i] = event.item
  } else if (event.type === 'delta') {
    const item = items.find((x) => x.id === event.itemId)
    if (item && (item.kind === 'assistant' || item.kind === 'reasoning')) item.text += event.delta
    else items.push({ kind: event.kind, id: event.itemId, text: event.delta })
  }
}
