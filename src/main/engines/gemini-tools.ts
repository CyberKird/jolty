// Tools for a model that only has a chat box. Gemini on gemini.google.com cannot call tools, so Jolty teaches it a
// small protocol in plain text: the model answers with one fenced block naming a tool, Jolty runs it (the same
// browser and computer tools Claude and Codex get over MCP) and sends the result back as the next message.
// This file is the pure part: the instructions, reading a reply, writing a result. The loop is in gemini-web.ts.
import type { Attachment } from '@shared/types'

/** a tool server as the engines see it over MCP: JSON-RPC in, JSON-RPC out */
export interface McpLike {
  handle(sid: string, msg: Record<string, unknown>): Promise<Record<string, unknown> | undefined>
}

export type ToolKind = 'read' | 'act' | 'self' | 'other' | 'blocked'

/** One group of tools (the browser, the PC) and what Jolty does before running each of them. */
export interface ToolSet {
  /** the MCP server name the tools carry in the chat (`mcp__<server>__<tool>`) */
  server: string
  mcp: McpLike
  /** the tools the model is told about */
  expose(name: string): boolean
  /** read: looks only; act: changes a page (asked once per site); self: the server asks the user itself; other: asked every time */
  kind(name: string): ToolKind
  /** what the model must know about using this group safely */
  rules: string
}

export interface ToolDefLite {
  name: string
  description: string
  inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] }
}

export interface ToolCall {
  tool: string
  args: Record<string, unknown>
}

export interface ToolOutcome {
  text: string
  images: { mime: string; data: string }[]
  error: boolean
}

/** at most this many tools in one answer of the user, so a model that loops cannot run all night */
export const MAX_STEPS = 30
/** a tool result longer than this is cut: the page would take it, but the answer would be slow and the model lost in it */
export const MAX_RESULT = 24000

const FENCE = /(```|~~~~)([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\1[ \t]*(?=\n|$)|$)/g

function asCall(body: string, known: (name: string) => boolean): ToolCall | undefined {
  let o: unknown
  try {
    o = JSON.parse(body.trim())
  } catch {
    return undefined
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined
  const { tool, name, args, arguments: a2, input, ...rest } = o as Record<string, unknown>
  const id = typeof tool === 'string' ? tool : typeof name === 'string' ? name : ''
  if (!id || !known(id)) return undefined
  const given = [args, a2, input].find((v) => v && typeof v === 'object' && !Array.isArray(v)) as Record<string, unknown> | undefined
  return { tool: id, args: given ?? rest }
}

const looksLikeCall = (lang: string, body: string): boolean => /^jolty-tool\b/i.test(lang) || /^\s*\{\s*"(?:tool|name)"\s*:/.test(body)

/**
 * What the model said, without its tool block, and the tool it asked for. While the answer is still being written
 * the block is hidden as soon as it starts, so it never flashes in the chat.
 */
export function splitReply(markdown: string, known: (name: string) => boolean): { text: string; call?: ToolCall } {
  let call: ToolCall | undefined
  let text = markdown.replace(FENCE, (all, _f: string, lang: string, body: string) => {
    if (!looksLikeCall(lang.trim(), body)) return all
    call ??= asCall(body, known)
    return ''
  })
  // an opening fence that has no line after it yet may be the start of a tool block (after an odd number of fences it
  // closes an open code block instead)
  const tail = /(?:^|\n)(?:```|~~~~)([a-z-]*)$/i.exec(text)
  if (tail && (text.slice(0, tail.index).match(/^(?:```|~~~~)/gm)?.length ?? 0) % 2 === 0 && (!tail[1] || 'jolty-tool'.startsWith(tail[1].toLowerCase()))) text = text.slice(0, tail.index)
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), call }
}

const first = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  const end = one.search(/[.!?](\s|$)/)
  const cut = end > 0 && end < 170 ? one.slice(0, end + 1) : one.slice(0, 170)
  return cut
}

const signature = (t: ToolDefLite): string => {
  const props = t.inputSchema?.properties ?? {}
  const need = new Set(t.inputSchema?.required ?? [])
  return Object.entries(props).map(([k, v]) => `${k}${need.has(k) ? '' : '?'}: ${v?.type ?? 'any'}`).join(', ')
}

/** The instructions the model gets once per conversation: the format, the tools, and what it must not do. */
export function toolsPrompt(sets: { set: ToolSet; defs: ToolDefLite[] }[]): string {
  const lines = sets.flatMap(({ set, defs }) => defs.filter((d) => set.expose(d.name)).map((d) => `- ${d.name}(${signature(d)}): ${first(d.description)}`))
  return [
    '[Jolty] You are working inside Jolty, an app that can run tools on this PC for you. When a task needs one, answer with exactly one fenced block and nothing after it:',
    '```jolty-tool',
    '{"tool":"<tool name>","args":{"<parameter>":"<value>"}}',
    '```',
    'Jolty runs it and replies with a message that starts with "jolty-result", with what the tool returned (pictures come as attached images). Then call the next tool, or answer the user in plain text without any block: an answer without a block ends the work. One tool per answer. A short sentence before the block saying what you are about to do is welcome. Never invent a result, wait for the jolty-result message. If the request needs no tool, just answer.',
    'Tools:',
    ...lines,
    ...sets.map(({ set }) => set.rules).filter(Boolean)
  ].join('\n')
}

/** The next message to the model: what the tool returned. */
export function resultMessage(tool: string, out: ToolOutcome): string {
  const body = out.text.length > MAX_RESULT ? out.text.slice(0, MAX_RESULT) + `\n... (${out.text.length - MAX_RESULT} more characters were cut)` : out.text
  const pics = out.images.length ? `\n(${out.images.length} image${out.images.length > 1 ? 's' : ''} attached)` : ''
  return `jolty-result ${tool}${out.error ? ' (error)' : ''}\n${body || '(no text)'}${pics}`
}

/** A tool result as the MCP reply carries it: text parts and images. */
export function outcomeOf(reply: Record<string, unknown> | undefined): ToolOutcome {
  const err = (reply?.error as { message?: string } | undefined)?.message
  if (err) return { text: err, images: [], error: true }
  const r = (reply?.result ?? {}) as { content?: { type?: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }
  const parts = Array.isArray(r.content) ? r.content : []
  return {
    text: parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n').trim(),
    images: parts.filter((p) => p.type === 'image' && p.data).map((p) => ({ mime: p.mimeType || 'image/png', data: p.data! })),
    error: Boolean(r.isError)
  }
}

export function imageFiles(images: ToolOutcome['images'], prefix: string): Attachment[] {
  return images.map((im, i) => ({ id: `${prefix}-${i + 1}`, name: `${prefix}-${i + 1}.${im.mime.includes('jpeg') ? 'jpg' : 'png'}`, mime: im.mime, data: im.data }))
}

export async function listTools(set: ToolSet, sid: string): Promise<ToolDefLite[]> {
  const r = await set.mcp.handle(sid, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const tools = (r?.result as { tools?: ToolDefLite[] } | undefined)?.tools
  return Array.isArray(tools) ? tools : []
}

export async function callTool(set: ToolSet, sid: string, call: ToolCall): Promise<ToolOutcome> {
  try {
    return outcomeOf(await set.mcp.handle(sid, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: call.tool, arguments: call.args } }))
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), images: [], error: true }
  }
}
