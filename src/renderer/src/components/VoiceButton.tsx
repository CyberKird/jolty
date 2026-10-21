import { Loader2, Mic, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { tr } from '@shared/i18n'
import { api, errMsg, useStore } from '../store'

const RATE = 16000

/** 16-bit mono PCM WAV, what whisper.cpp reads */
function wav(chunks: Float32Array[]): Uint8Array {
  const n = chunks.reduce((a, c) => a + c.length, 0)
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string): void => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  str(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, RATE, true)
  v.setUint32(28, RATE * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, n * 2, true)
  let o = 44
  for (const c of chunks)
    for (const x of c) {
      v.setInt16(o, Math.max(-1, Math.min(1, x)) * 0x7fff, true)
      o += 2
    }
  return new Uint8Array(buf)
}

/** Jolty listens while you talk (mascot/brain.ts) */
const tell = (what: 'listen' | 'done'): boolean => window.dispatchEvent(new CustomEvent('jolty:voice', { detail: what }))

/**
 * Dictation: click, talk, click again (Esc drops it). The words land at the cursor, transcribed on this PC by
 * Whisper; nothing leaves it. The first use asks to fetch the model once.
 */
export function VoiceButton({ onText }: { onText: (text: string) => void }) {
  const [state, setState] = useState<'idle' | 'rec' | 'busy'>('idle')
  const [secs, setSecs] = useState(0)
  const pull = useStore((s) => s.pulls.whisper)
  const toast = useStore((s) => s.toast)
  const btn = useRef<HTMLButtonElement>(null)
  const rec = useRef<{ stop: (keep: boolean) => void } | null>(null)

  useEffect(() => () => rec.current?.stop(false), [])
  useEffect(() => {
    if (state !== 'rec') return
    const t0 = Date.now()
    const timer = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 250)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') rec.current?.stop(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      clearInterval(timer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [state])

  const start = async (): Promise<void> => {
    const st = await api.voice.status()
    if (!st.engine) return toast(tr("Dictarea nu e inclusă în această versiune Jolty."), true)
    if (!st.model) {
      if (!window.confirm(tr("Dictarea transcrie pe PC-ul tău cu Whisper large-v3 turbo. Modelul are {v0} MB și se descarcă o singură dată. Îl descarc acum?", { v0: st.sizeMB }))) return
      try {
        await api.voice.download()
      } catch (e) {
        return toast(errMsg(e), true)
      }
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch {
      return toast(tr("Nu am acces la microfon."), true)
    }
    const ctx = new AudioContext({ sampleRate: RATE })
    const src = ctx.createMediaStreamSource(stream)
    // ponytail: ScriptProcessor is deprecated but needs no worklet file; move to an AudioWorklet if Chromium drops it
    const proc = ctx.createScriptProcessor(4096, 1, 1)
    const chunks: Float32Array[] = []
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0)
      chunks.push(new Float32Array(d))
      let sum = 0
      for (let i = 0; i < d.length; i += 16) sum += d[i] * d[i]
      btn.current?.style.setProperty('--lvl', Math.min(1, Math.sqrt(sum / (d.length / 16)) * 6).toFixed(2))
    }
    src.connect(proc)
    proc.connect(ctx.destination)
    rec.current = {
      stop: (keep) => {
        rec.current = null
        proc.disconnect()
        src.disconnect()
        stream.getTracks().forEach((t) => t.stop())
        void ctx.close()
        tell('done')
        if (!keep || chunks.length < 3) return setState('idle')
        setState('busy')
        api.voice
          .transcribe(wav(chunks))
          .then((text) => text && onText(text))
          .catch((e) => toast(errMsg(e), true))
          .finally(() => setState('idle'))
      }
    }
    setSecs(0)
    setState('rec')
    tell('listen')
  }

  const downloading = pull && !pull.done
  const pct = downloading && pull.total ? Math.round(((pull.completed || 0) / pull.total) * 100) : undefined
  return (
    <button
      ref={btn}
      className={`btn ghost small icon voice ${state}`}
      disabled={state === 'busy' || Boolean(downloading)}
      onClick={() => (state === 'rec' ? rec.current?.stop(true) : void start())}
      title={state === 'rec' ? tr("Oprește și scrie textul (Esc renunță)") : tr("Dictează: vorbește, apoi apasă din nou")}
      aria-label={tr("Dictează")}
    >
      {state === 'busy' || downloading ? <Loader2 size={15} className="spin" /> : state === 'rec' ? <Square size={13} /> : <Mic size={15} />}
      {state === 'rec' && <span className="voice-time">{`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}</span>}
      {pct !== undefined && <span className="voice-time">{pct}%</span>}
    </button>
  )
}
