import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatItem } from '../src/shared/types'
import { buildLibrary, cleanUrl, kindOf } from '../src/main/library'

const items: Record<string, ChatItem[]> = {
  old: [
    { kind: 'user', id: 'u1', text: 'see https://example.com/a. and (https://docs.example.org/x?y=1)', images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' }], files: [{ name: 'plan.pdf', mime: 'application/pdf' }] },
    { kind: 'assistant', id: 'a1', text: 'Also https://example.com/a again, and https://news.site/post!' }
  ],
  fresh: [
    { kind: 'user', id: 'u2', text: 'clip', images: [{ name: 'b.png', dataUrl: 'data:image/png;base64,BBBB' }, { name: 'c.png', dataUrl: 'data:image/png;base64,CCCC' }], files: [{ name: 'take.mp4', mime: 'video/mp4' }, { name: 'voice.m4a', mime: 'audio/mp4' }] }
  ]
}
const sessions = [
  { id: 'old', title: 'Old chat', updatedAt: 1 },
  { id: 'fresh', title: 'Fresh chat', updatedAt: 9 },
  { id: 'broken', title: 'Broken', updatedAt: 5 }
]

test('pictures, files and links of every conversation, newest conversation first, a bad transcript skipped', () => {
  const lib = buildLibrary(sessions, (id) => {
    if (id === 'broken') throw new Error('unreadable')
    return items[id]
  })
  assert.deepEqual(lib.images.map((i) => `${i.sessionId}:${i.index}:${i.name}`), ['fresh:0:b.png', 'fresh:1:c.png', 'old:0:a.png'])
  assert.deepEqual(lib.files.map((f) => `${f.name}:${f.kind}`), ['take.mp4:video', 'voice.m4a:audio', 'plan.pdf:file'])
  assert.deepEqual(lib.links.map((l) => l.url), ['https://example.com/a', 'https://docs.example.org/x?y=1', 'https://news.site/post'])
  assert.equal(lib.links[0].host, 'example.com')
  assert.equal(lib.links[0].title, 'Old chat', 'a link seen twice is listed once')
})

test('an address loses the punctuation of the sentence around it; a type says what a file is', () => {
  assert.equal(cleanUrl('https://a.b/c.'), 'https://a.b/c')
  assert.equal(cleanUrl('https://a.b/c!?'), 'https://a.b/c')
  assert.equal(kindOf('video/webm'), 'video')
  assert.equal(kindOf('audio/mpeg'), 'audio')
  assert.equal(kindOf('application/zip'), 'file')
})
