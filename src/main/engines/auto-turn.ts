/**
 * Claude Code starts a turn on its own when a background command or agent ends (it reports the result).
 * That turn never goes through send(), so Jolty has to notice it from the stream: the first output of the
 * main conversation (not a subagent's) while no turn is known means the chat is working again.
 */
export function startsOwnTurn(m: { type: string; parent_tool_use_id?: string | null }, state: { turn: boolean; stopping: boolean }): boolean {
  if (state.turn || state.stopping) return false
  if (m.type !== 'assistant' && m.type !== 'stream_event') return false
  return !m.parent_tool_use_id
}
