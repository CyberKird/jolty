/**
 * Jolty's sounds, made on the spot with WebAudio (no files): soft and short, and silent while the window is
 * not the one you use, so they never call you back to it. Off with the mascot or with their own switch.
 */
let ctx: AudioContext | undefined
let on = true

export function soundsOn(v: boolean): void {
  on = v
}

// out of focus = nothing may sound, also what was already scheduled
window.addEventListener('blur', () => void ctx?.suspend())

type Note = { type?: OscillatorType; from: number; to?: number; at?: number; len: number; vol: number }

function tone(a: AudioContext, n: Note, out: AudioNode): void {
  const t = a.currentTime + (n.at ?? 0)
  const o = a.createOscillator()
  const g = a.createGain()
  o.type = n.type ?? 'sine'
  o.frequency.setValueAtTime(n.from, t)
  if (n.to) o.frequency.exponentialRampToValueAtTime(n.to, t + n.len)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(n.vol, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + n.len)
  o.connect(g).connect(out)
  o.start(t)
  o.stop(t + n.len + 0.02)
}

/** filtered noise: thuds (low), whooshes and scrapes (band), crackle (high) */
function noise(a: AudioContext, len: number, vol: number, filter: BiquadFilterType, freq: number, out: AudioNode, at = 0, sweepTo?: number): void {
  const t = a.currentTime + at
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * len), a.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length)
  const src = a.createBufferSource()
  src.buffer = buf
  const f = a.createBiquadFilter()
  f.type = filter
  f.frequency.setValueAtTime(freq, t)
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + len)
  const g = a.createGain()
  g.gain.setValueAtTime(vol, t)
  src.connect(f).connect(g).connect(out)
  src.start(t)
}

export type Sound = 'hop' | 'land' | 'thud' | 'oof' | 'grab' | 'whoosh' | 'cheer' | 'hello' | 'ding' | 'worry' | 'crackle' | 'click' | 'scrape' | 'zap' | 'arrive' | 'knock' | 'step' | 'effort' | 'rustle' | 'key' | 'blip' | 'snore' | 'giggle' | 'beat' | 'pant'

/** strength 0..1 scales the impact sounds */
export function play(sound: Sound, strength = 0.5): void {
  if (!on || !document.hasFocus() || document.hidden || document.documentElement.classList.contains('reduce-motion')) return
  ctx ??= new AudioContext()
  const a = ctx
  if (a.state === 'suspended') void a.resume()
  const out = a.createGain()
  out.gain.value = 0.55
  out.connect(a.destination)
  const s = Math.max(0.15, Math.min(1, strength))
  switch (sound) {
    case 'hop':
      return tone(a, { from: 520, to: 820, len: 0.08, vol: 0.05 }, out)
    case 'land':
      noise(a, 0.06, 0.05 * s, 'lowpass', 500, out)
      return tone(a, { from: 150, to: 80, len: 0.08, vol: 0.06 * s }, out)
    case 'thud':
      noise(a, 0.12, 0.12 * s, 'lowpass', 380, out)
      return tone(a, { from: 120, to: 55, len: 0.16, vol: 0.12 * s }, out)
    case 'oof':
      return tone(a, { type: 'triangle', from: 620, to: 260, len: 0.17, vol: 0.05, at: 0.05 }, out)
    case 'grab':
      return tone(a, { type: 'triangle', from: 700, to: 1050, len: 0.07, vol: 0.04 }, out)
    case 'whoosh':
      return noise(a, 0.22, 0.06 * s, 'bandpass', 500, out, 0, 2400)
    case 'cheer':
      tone(a, { from: 660, len: 0.09, vol: 0.045 }, out)
      return tone(a, { from: 990, len: 0.13, vol: 0.045, at: 0.08 }, out)
    case 'hello':
      return tone(a, { from: 880, to: 990, len: 0.07, vol: 0.035 }, out)
    case 'ding':
      return tone(a, { from: 1320, len: 0.25, vol: 0.03 }, out)
    case 'worry':
      return tone(a, { type: 'triangle', from: 420, to: 300, len: 0.15, vol: 0.035 }, out)
    case 'crackle':
      for (let i = 0; i < 3; i++) noise(a, 0.025, 0.035, 'highpass', 3500, out, i * 0.045 + Math.random() * 0.02)
      return
    case 'click':
      return noise(a, 0.02, 0.05, 'highpass', 2500, out)
    case 'zap':
      // the teleport: a bright zip that sweeps up and a falling buzz under it
      noise(a, 0.16, 0.07, 'bandpass', 700, out, 0, 6000)
      return tone(a, { type: 'sawtooth', from: 1500, to: 260, len: 0.15, vol: 0.03 }, out)
    case 'arrive':
      // and where he lands: a short snap with a little crackle
      noise(a, 0.05, 0.08, 'highpass', 3000, out)
      tone(a, { from: 520, to: 180, len: 0.1, vol: 0.05 }, out)
      return noise(a, 0.03, 0.04, 'highpass', 3800, out, 0.06)
    case 'step':
      // a soft sole on the floor, a little different each time
      noise(a, 0.045, 0.045 + Math.random() * 0.02, 'lowpass', 700 + Math.random() * 500, out)
      return tone(a, { type: 'triangle', from: 170 + Math.random() * 40, to: 90, len: 0.06, vol: 0.03 }, out)
    case 'effort':
      // a small "hup": a short breathy voiced push, rising then dropping
      noise(a, 0.12, 0.03, 'bandpass', 1400, out)
      return tone(a, { type: 'triangle', from: 300, to: 220, len: 0.14, vol: 0.03, at: 0.01 }, out)
    case 'rustle':
      // cloth on the floor as he moves
      noise(a, 0.32, 0.03, 'bandpass', 2200, out, 0, 1100)
      return noise(a, 0.2, 0.02, 'highpass', 3000, out, 0.12)
    case 'key':
      // one key of the laptop: a short tick, higher or lower
      noise(a, 0.014, 0.035, 'highpass', 2800 + Math.random() * 1200, out)
      return tone(a, { type: 'square', from: 900 + Math.random() * 500, to: 600, len: 0.02, vol: 0.008 }, out)
    case 'blip':
      // an idea starting to form
      tone(a, { from: 520, to: 700, len: 0.07, vol: 0.03 }, out)
      return tone(a, { from: 700, to: 920, len: 0.09, vol: 0.03, at: 0.08 }, out)
    case 'snore':
      // asleep: a low breath that swells and fades
      return noise(a, 0.9, 0.035, 'lowpass', 320, out, 0, 160)
    case 'scrape':
      // the stool dragged across the floor under him: a rough wooden scrape that slows down, with creaks in it
      noise(a, 0.5, 0.075, 'bandpass', 620, out, 0, 240)
      noise(a, 0.5, 0.03, 'lowpass', 300, out)
      for (const [at, f, len] of [[0.04, 210, 0.09], [0.2, 170, 0.12], [0.34, 240, 0.08]] as const) tone(a, { type: 'sawtooth', from: f, to: f * 0.78, len, vol: 0.022, at }, out)
      return
    case 'giggle':
      // a few quick rising chirps
      for (let i = 0; i < 3; i++) tone(a, { type: 'triangle', from: 520 + i * 70, to: 760 + i * 90, len: 0.07, vol: 0.03, at: i * 0.1 }, out)
      return
    case 'beat':
      // a soft kick on the beat
      noise(a, 0.05, 0.05, 'lowpass', 260, out)
      return tone(a, { from: 140, to: 60, len: 0.1, vol: 0.07 }, out)
    case 'pant':
      return noise(a, 0.3, 0.03, 'bandpass', 1500, out, 0, 900)
    case 'knock':
      // it stops against him: a dull knock of wood
      noise(a, 0.07, 0.07, 'lowpass', 420, out)
      return tone(a, { type: 'triangle', from: 190, to: 80, len: 0.12, vol: 0.08 }, out)
  }
}
