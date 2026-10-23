// What a tool call answers with, and the error that carries a message meant for the model.
export type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }

/** An expected refusal or stop: its message goes to the model as the tool's answer. */
export class UserError extends Error {}

export const text = (...parts: string[]): ToolResult => ({ content: [{ type: 'text', text: parts.join('\n\n') }] })
export const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: msg }], isError: true })
export const image = (jpeg: Buffer): { type: 'image'; data: string; mimeType: string } => ({ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' })

import type { ComputerService, Session } from './service'

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  run(svc: ComputerService, s: Session, args: Record<string, unknown>): Promise<ToolResult>
}

export type Args = Record<string, unknown>

export const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false })

export function num(v: unknown, name: string, opts: { min?: number; max?: number; optional?: boolean; def?: number } = {}): number {
  if (v === undefined || v === null) {
    if (opts.def !== undefined) return opts.def
    if (opts.optional) return NaN
    throw new UserError(`"${name}" is required (a number)`)
  }
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new UserError(`"${name}" must be a number`)
  if (opts.min !== undefined && n < opts.min) throw new UserError(`"${name}" must be at least ${opts.min}`)
  if (opts.max !== undefined && n > opts.max) throw new UserError(`"${name}" must be at most ${opts.max}`)
  return n
}

export const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw new UserError(`"${name}" is required (a string)`)
  return v
}
