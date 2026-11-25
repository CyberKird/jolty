import assert from 'node:assert/strict'
import { test } from 'node:test'
import { avcCodec, avcDescription, splitNals, toAvcc, videoCaps } from '../src/renderer/src/remote/screen-video'

// the stream from the PC is Annex B; browsers want lengths in front of each unit and the parameter sets in a description
const b = (...n: number[]): Uint8Array => Uint8Array.from(n)
const SPS = b(0x67, 0x64, 0x00, 0x2a, 0xac, 0xd9, 0x40)
const PPS = b(0x68, 0xeb, 0xe3, 0xcb)
const IDR = b(0x65, 0x88, 0x84, 0x00, 0x01, 0x02)
const DELTA = b(0x41, 0x9a, 0x24, 0x6c)
const annexb = (...units: Uint8Array[]): Uint8Array => {
  const parts: number[] = []
  units.forEach((u, i) => parts.push(...(i % 2 ? [0, 0, 1] : [0, 0, 0, 1]), ...u))
  return Uint8Array.from(parts)
}

test('splits a chunk into its units, with 3 and 4 byte start codes, and no stray zeros', () => {
  const nals = splitNals(annexb(b(0x09, 0xf0), SPS, PPS, IDR))
  assert.deepEqual(nals.map((u) => Array.from(u)), [[0x09, 0xf0], Array.from(SPS), Array.from(PPS), Array.from(IDR)])
  assert.equal(splitNals(b(1, 2, 3)).length, 0, 'no start code, no unit')
  const padded = splitNals(Uint8Array.from([0, 0, 0, 1, 0x41, 0x9a, 0, 0, 0, 0, 1, 0x41, 0x01]))
  assert.deepEqual(padded.map((u) => Array.from(u)), [[0x41, 0x9a], [0x41, 0x01]])
})

test('the description holds the parameter sets and the codec string says the profile and level', () => {
  const d = avcDescription(splitNals(annexb(SPS, PPS, IDR)))!
  assert.equal(d.codec, 'avc1.64002a')
  assert.equal(d.description[0], 1, 'avcC version')
  assert.deepEqual(Array.from(d.description.subarray(1, 4)), [0x64, 0x00, 0x2a])
  assert.equal(d.description[4], 0xff, 'four byte lengths')
  assert.equal(d.description[5], 0xe1, 'one SPS')
  assert.equal((d.description[6] << 8) | d.description[7], SPS.length)
  assert.deepEqual(Array.from(d.description.subarray(8, 8 + SPS.length)), Array.from(SPS))
  assert.equal(d.description[8 + SPS.length], 1, 'one PPS')
  assert.deepEqual(Array.from(d.description.subarray(11 + SPS.length)), Array.from(PPS))
  assert.equal(avcDescription(splitNals(annexb(IDR))), undefined, 'a picture without them gives nothing')
})

test('the picture units get 4 byte lengths and the parameter sets and delimiters are left out', () => {
  const out = toAvcc(splitNals(annexb(b(0x09, 0xf0), SPS, PPS, IDR)))
  assert.deepEqual(Array.from(out), [0, 0, 0, IDR.length, ...IDR])
  const two = toAvcc(splitNals(annexb(DELTA, b(0x41, 0x01))))
  assert.deepEqual(Array.from(two), [0, 0, 0, 4, ...DELTA, 0, 0, 0, 2, 0x41, 0x01])
})

// ---------------------------------------------------------------- what a phone decodes (Android low end, iOS Safari)
// The browser is asked with the exact codec strings; these fakes stand for the answers real phones give.

type Cfg = { codec: string; codedWidth?: number; hardwareAcceleration?: string }
const fakeDecoder = (answer: (c: Cfg) => boolean | 'throw') => ({
  isConfigSupported: async (c: Cfg) => {
    const a = answer(c)
    if (a === 'throw') throw new TypeError('Unsupported codec')
    return { supported: a, config: c }
  }
})
;(globalThis as { EncodedVideoChunk?: unknown }).EncodedVideoChunk ??= class {}

test('a phone that decodes everything in hardware gets High, 4K60 (the PC screen at its own pixels)', async () => {
  const caps = await videoCaps(fakeDecoder(() => true) as never)
  assert.deepEqual(caps, { profiles: ['high', 'main', 'baseline'], maxEdge: 3840, maxFps: 60, hardware: true })
})

test('a phone whose hardware stops at 1080p60 says so (asked with the 4K level strings first)', async () => {
  const caps = await videoCaps(fakeDecoder((c) => c.hardwareAcceleration === 'prefer-hardware' && (c.codedWidth ?? 0) <= 1920) as never)
  assert.deepEqual(caps, { profiles: ['high', 'main', 'baseline'], maxEdge: 1920, maxFps: 60, hardware: true })
})

test('a low-end Android decoder (Main and Baseline, up to 720p30, hardware) is told as such', async () => {
  const caps = await videoCaps(fakeDecoder((c) => c.hardwareAcceleration === 'prefer-hardware' && !c.codec.startsWith('avc1.6400') && ['1F', '1E'].includes(c.codec.slice(-2))) as never)
  assert.deepEqual(caps, { profiles: ['main', 'baseline'], maxEdge: 1280, maxFps: 30, hardware: true })
})

test('software decoding only: never more than 720p30', async () => {
  const caps = await videoCaps(fakeDecoder((c) => c.hardwareAcceleration !== 'prefer-hardware') as never)
  assert.equal(caps?.maxEdge, 1280)
  assert.equal(caps?.maxFps, 30)
  assert.equal(caps?.hardware, false)
})

test('isConfigSupported saying no, or throwing, means pictures (JPEG), not a broken video', async () => {
  assert.equal(await videoCaps(fakeDecoder(() => false) as never), undefined)
  assert.equal(await videoCaps(fakeDecoder(() => 'throw') as never), undefined)
  assert.equal(await videoCaps(undefined), undefined, 'no WebCodecs at all (iOS before 16.4)')
})

test('a decoder that throws on High (an older Safari) still plays Main and Baseline', async () => {
  const caps = await videoCaps(fakeDecoder((c) => (c.codec.startsWith('avc1.6400') ? 'throw' : true)) as never)
  assert.deepEqual(caps?.profiles, ['main', 'baseline'])
  assert.equal(caps?.maxFps, 60)
})

test('codec strings are the ones the PC encoders name', () => {
  assert.equal(avcCodec('high', '2A'), 'avc1.64002A')
  assert.equal(avcCodec('main', '28'), 'avc1.4D4028')
  assert.equal(avcCodec('baseline', '1F'), 'avc1.42E01F')
  // AMF writes Constrained Baseline as 42 40 1F: the phone builds its decoder from the stream's own parameter set
  const sps = b(0x67, 0x42, 0x40, 0x1f, 0xda, 0x01)
  assert.equal(avcDescription(splitNals(annexb(sps, PPS, IDR)))?.codec, 'avc1.42401f')
})
