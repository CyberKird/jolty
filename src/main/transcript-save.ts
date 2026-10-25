// Saving a transcript while the model streams, without freezing the main process on a long conversation: items that did
// not change since the last save keep their JSON text, and the file is written in pieces between event-loop turns.
import fs from 'fs'
import path from 'path'
import type { ChatItem } from '@shared/types'
import { slimTranscript, transcriptFile, transcriptGeneration } from './store'

const texts = new WeakMap<ChatItem, string>()
/** how many items at the end are always serialised again: the ones a stream can still be changing in place */
const LIVE_TAIL = 24
const PIECE = 1 << 20

export function serialize(items: ChatItem[]): string[] {
  const live = items.length - LIVE_TAIL
  return items.map((it, i) => {
    const hit = i < live ? texts.get(it) : undefined
    if (hit !== undefined) return hit
    const text = JSON.stringify(slimTranscript([it])[0])
    texts.set(it, text)
    return text
  })
}

/**
 * Writes `items` to the transcript file (temp file, then rename). Returns how long it took in ms, or -1 when a
 * synchronous save of the same session came in meanwhile: that one is newer, so this one is dropped.
 */
export async function saveTranscriptAsync(sessionId: string, items: ChatItem[]): Promise<number> {
  const started = Date.now()
  const generation = transcriptGeneration(sessionId)
  const parts = serialize(items)
  const target = transcriptFile(sessionId)
  const tmp = `${target}.${process.pid}.async.tmp`
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  const fh = await fs.promises.open(tmp, 'w')
  try {
    let chunk = '['
    for (let i = 0; i < parts.length; i++) {
      chunk += (i ? ',' : '') + parts[i]
      if (chunk.length >= PIECE) {
        await fh.write(chunk)
        chunk = ''
      }
    }
    await fh.write(chunk + ']')
  } finally {
    await fh.close()
  }
  if (generation !== transcriptGeneration(sessionId)) {
    await fs.promises.rm(tmp, { force: true })
    return -1
  }
  fs.renameSync(tmp, target)
  return Date.now() - started
}
