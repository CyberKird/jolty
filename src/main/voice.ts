// Voice input: what you say into the composer's microphone, transcribed on this PC by whisper.cpp.
// whisper-cli is built with Vulkan (.github/workflows/whisper.yml), so it runs on any GPU and falls back to the
// CPU. The model, Whisper large-v3 turbo (as good as large-v3 for dictation, several times faster), is
// downloaded once into the data folder.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import { dataDir } from './store'

const MODEL = 'ggml-large-v3-turbo-q5_0.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}`

export function exe(): string {
  const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  return app.isPackaged ? path.join(process.resourcesPath, 'whisper', name) : path.resolve('build/whisper', name)
}
const model = (): string => path.join(dataDir(), 'models', MODEL)

export function status(): { engine: boolean; model: boolean; sizeMB: number } {
  return { engine: fs.existsSync(exe()), model: fs.existsSync(model()), sizeMB: 574 }
}

let pulling: Promise<void> | undefined
/** fetches the model once (a second call waits for the first); a cut download never counts as done */
export function download(progress: (done: number, total: number) => void): Promise<void> {
  pulling ??= (async () => {
    const target = model()
    const part = target + '.part'
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const res = await fetch(MODEL_URL, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`)
    const total = Number(res.headers.get('content-length')) || 0
    const out = fs.createWriteStream(part)
    let done = 0
    let told = 0
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      done += chunk.length
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      if (done - told > 4e6) progress((told = done), total)
    }
    await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())))
    // a ggml model starts with the magic "lmgg" and is hundreds of MB
    const head = Buffer.alloc(4)
    const fd = fs.openSync(part, 'r')
    fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
    if (head.toString('latin1') !== 'lmgg' || (total && done !== total)) throw new Error('the download is not a whole whisper model')
    fs.renameSync(part, target)
    progress(done, total || done)
  })().finally(() => (pulling = undefined))
  return pulling
}

/** a 16 kHz mono WAV from the renderer in, the text out */
export async function transcribe(wav: Uint8Array, lang = 'auto'): Promise<string> {
  if (!fs.existsSync(exe()) || !fs.existsSync(model())) throw new Error('voice input is not set up')
  const file = path.join(os.tmpdir(), `jolty-voice-${process.pid}-${Date.now()}.wav`)
  fs.writeFileSync(file, wav)
  try {
    const out = await new Promise<Buffer>((ok, fail) => {
      const p = spawn(exe(), ['-m', model(), '-f', file, '-l', lang, '-nt', '-np', '-t', String(Math.min(8, os.cpus().length))], { windowsHide: true })
      const chunks: Buffer[] = []
      p.stdout.on('data', (d: Buffer) => chunks.push(d))
      p.on('error', fail)
      p.on('close', (code) => (code === 0 ? ok(Buffer.concat(chunks)) : fail(new Error(`whisper exited with ${code}`))))
    })
    // utf8 decoded once, whole: a chunk can end in the middle of a character
    return out.toString('utf8').replace(/\s+/g, ' ').trim()
  } finally {
    fs.rmSync(file, { force: true })
  }
}
