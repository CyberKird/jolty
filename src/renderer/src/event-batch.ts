import type { ChatEvent } from '@shared/types'

/**
 * Streamed text arrives token by token; rendering the chat for each one is what makes a long answer stutter on a weak
 * PC. Deltas of one item are joined and handed on every `delay()` ms; any other event goes through at once, after the
 * deltas that came before it, so the order the chat sees is the order the engine sent.
 */
export function batchDeltas(emit: (e: ChatEvent) => void, delay: () => number): (e: ChatEvent) => void {
  const pending = new Map<string, Extract<ChatEvent, { type: 'delta' }>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined
    const list = [...pending.values()]
    pending.clear()
    for (const d of list) emit(d)
  }
  return (e) => {
    if (e.type !== 'delta') {
      flush()
      emit(e)
      return
    }
    const key = `${e.sessionId}\n${e.itemId}`
    const prev = pending.get(key)
    if (prev) prev.delta += e.delta
    else pending.set(key, { ...e })
    timer ??= setTimeout(flush, delay())
  }
}
