import { execFile, spawn } from 'child_process'
import os from 'os'
import type { CatalogModel, ChatEvent, Fit, GpuInfo, HardwareInfo, LocalModel, OllamaStatus } from '@shared/types'
import { tr } from '@shared/i18n'

export const OLLAMA_URL = 'http://127.0.0.1:11434'
/** Claude Code needs a large context; Ollama defaults to 4k on smaller GPUs. */
export const LOCAL_CONTEXT = 65536

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out)))
  )
}

// ---------------------------------------------------------------------------
// Hardware
// ---------------------------------------------------------------------------
async function nvidiaGpus(): Promise<GpuInfo[]> {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
  return out
    .split('\n')
    .map((l) => l.split(','))
    .filter((p) => p.length >= 2 && p[0].trim())
    .map(([name, mib]) => ({ name: name.trim(), vramGb: Math.round((Number(mib) / 1024) * 10) / 10 }))
}

/** Windows: the registry has the real 64-bit VRAM size (WMI's AdapterRAM stops at 4 GB). */
async function windowsGpus(): Promise<GpuInfo[]> {
  const script =
    "Get-ItemProperty -Path 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.'HardwareInformation.qwMemorySize' } | ForEach-Object { $_.DriverDesc + '|' + $_.'HardwareInformation.qwMemorySize' }"
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  return out
    .split('\n')
    .map((l) => l.trim().split('|'))
    .filter((p) => p.length === 2 && p[0])
    .map(([name, bytes]) => ({ name, vramGb: Math.round((Number(bytes) / 1024 ** 3) * 10) / 10 }))
}

let hardwareCache: HardwareInfo | undefined

export async function hardware(): Promise<HardwareInfo> {
  if (hardwareCache) return hardwareCache
  let gpus = await nvidiaGpus()
  if (!gpus.length && process.platform === 'win32') gpus = await windowsGpus()
  // integrated graphics report shared memory; only count cards with real VRAM
  const dedicated = gpus.filter((g) => g.vramGb >= 2 && !/intel\(r\) (uhd|iris|hd)/i.test(g.name))
  const cpus = os.cpus()
  hardwareCache = {
    ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    cpu: cpus[0]?.model?.trim() || 'necunoscut',
    cores: cpus.length,
    gpus,
    bestVramGb: dedicated.reduce((m, g) => Math.max(m, g.vramGb), 0)
  }
  return hardwareCache
}

// ---------------------------------------------------------------------------
// Catalog: local models Ollama recommends for coding agents, with an honest
// comparison to the Claude models the user already knows.
// Sizes: Ollama's docs where they give one, otherwise the download size of the
// default quantization plus room for a 64k context.
// ---------------------------------------------------------------------------
const CATALOG: Omit<CatalogModel, 'fit' | 'installed'>[] = [
  { tag: 'qwen3:4b', title: 'Qwen3 4B', vramGb: 4, vision: false, tier: 1, equivalent: 'Mult sub Haiku 4.5', notes: tr("Merge și pe laptopuri modeste. Bun pentru întrebări scurte, slab la sarcini lungi.") },
  { tag: 'qwen3-vl:8b', title: 'Qwen3-VL 8B', vramGb: 7, vision: true, tier: 1, equivalent: 'Sub Haiku 4.5', notes: tr("Vede imagini. Util ca „ochi” local pentru modelele care nu văd.") },
  { tag: 'qwen3.5', title: 'Qwen3.5', vramGb: 11, vision: true, tier: 2, equivalent: tr("Aproape de Haiku 4.5 la sarcini simple"), notes: tr("Recomandat de Ollama pentru agenți: raționament, cod și imagini (~11 GB VRAM).") },
  { tag: 'gemma4', title: 'Gemma 4', vramGb: 16, vision: false, tier: 2, equivalent: tr("Aproape de Haiku 4.5"), notes: tr("Raționament și cod local (~16 GB VRAM).") },
  { tag: 'qwen3.5:27b', title: 'Qwen3.5 27B', vramGb: 18, vision: true, tier: 3, equivalent: tr("În jurul lui Haiku 4.5"), notes: tr("Mai rapid și mai capabil decât varianta mică (~18 GB VRAM).") },
  { tag: 'qwen3-coder:30b', title: 'Qwen3-Coder 30B', vramGb: 20, vision: false, tier: 3, equivalent: tr("În jurul lui Haiku 4.5, la cod"), notes: tr("Specializat pe programare și unelte.") },
  { tag: 'nemotron-3-nano:30b', title: 'Nemotron 3 Nano 30B', vramGb: 24, vision: false, tier: 3, equivalent: tr("În jurul lui Haiku 4.5"), notes: tr("Recomandat de Ollama pentru agenți; încape în 24 GB VRAM.") },
  { tag: 'qwen3.6', title: 'Qwen3.6', vramGb: 24, vision: true, tier: 3, equivalent: tr("Între Haiku 4.5 și Sonnet 5, pe sarcini ușoare"), notes: tr("Raționament, cod și imagini (~24 GB VRAM).") },
  { tag: 'glm-4.7-flash', title: 'GLM-4.7 Flash', vramGb: 25, vision: false, tier: 3, equivalent: tr("În jurul lui Haiku 4.5"), notes: tr("Raționament și generare de cod (~25 GB VRAM).") },
  // Refusals removed by abliteration (community builds, pages on ollama.com show the tools badge).
  {
    tag: 'huihui_ai/gemma-4-abliterated:12b',
    title: tr("Gemma 4 12B fără restricții"),
    vramGb: 10,
    vision: true,
    tier: 2,
    unrestricted: true,
    equivalent: 'Sub Haiku 4.5',
    notes: tr("Gemma 4 fără refuzuri, vede imagini. Pentru texte creative sau pentru adulți. Pentru cod rămâne mult sub Claude.")
  },
  {
    tag: 'huihui_ai/qwen3-abliterated:14b',
    title: tr("Qwen3 14B fără restricții"),
    vramGb: 11,
    vision: false,
    tier: 2,
    unrestricted: true,
    equivalent: 'Sub Haiku 4.5',
    notes: tr("Qwen3 fără refuzuri, cu gândire. Versiune comunitară: calitatea poate varia față de modelul original.")
  },
  { tag: 'gpt-oss:120b', title: 'gpt-oss 120B', vramGb: 70, vision: false, tier: 4, equivalent: tr("Între Haiku 4.5 și Sonnet 5"), notes: tr("Cere hardware de stație de lucru (80 GB VRAM sau foarte multă memorie).") }
]

function fitFor(vramGb: number, hw: HardwareInfo): Fit {
  if (hw.bestVramGb >= vramGb) return 'gpu'
  // on CPU the model sits in RAM next to Windows and the apps: keep a healthy margin
  if (hw.ramGb * 0.7 >= vramGb) return 'cpu'
  return 'no'
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------
async function api<T>(path: string, body?: unknown, timeoutMs = 10000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(OLLAMA_URL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    })
    if (!r.ok) throw new Error(`Ollama ${path}: ${r.status} ${await r.text()}`)
    return (await r.json()) as T
  } finally {
    clearTimeout(t)
  }
}

async function ollamaInstalled(): Promise<boolean> {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    const out = await run('where', ['ollama'])
    if (out.trim()) return true
    if (local) {
      const fs = await import('fs')
      return fs.existsSync(`${local}\\Programs\\Ollama\\ollama.exe`)
    }
    return false
  }
  return Boolean((await run('which', ['ollama'])).trim())
}

export async function modelInfo(tag: string): Promise<LocalModel> {
  const show = await api<{ capabilities?: string[]; details?: { parameter_size?: string } }>('/api/show', { model: tag })
  const caps = show.capabilities || []
  return { tag, sizeGb: 0, vision: caps.includes('vision'), tools: caps.includes('tools'), thinking: caps.includes('thinking') }
}

export async function status(): Promise<OllamaStatus> {
  let version: string | undefined
  try {
    version = (await api<{ version: string }>('/api/version', undefined, 2000)).version
  } catch {
    return { installed: await ollamaInstalled(), running: false, models: [] }
  }
  const tags = await api<{ models: { name: string; size: number }[] }>('/api/tags')
  const models: LocalModel[] = []
  for (const m of tags.models || []) {
    try {
      const info = await modelInfo(m.name)
      models.push({ ...info, sizeGb: Math.round((m.size / 1024 ** 3) * 10) / 10 })
    } catch {
      models.push({ tag: m.name, sizeGb: Math.round((m.size / 1024 ** 3) * 10) / 10, vision: false, tools: false, thinking: false })
    }
  }
  return { installed: true, running: true, version, models }
}

export async function catalog(): Promise<CatalogModel[]> {
  const hw = await hardware()
  let installed = new Set<string>()
  try {
    installed = new Set((await status()).models.map((m) => m.tag.replace(/:latest$/, '')))
  } catch {
    // Ollama not running
  }
  return CATALOG.map((c) => ({ ...c, fit: fitFor(c.vramGb, hw), installed: installed.has(c.tag) || installed.has(`${c.tag}-jolty`) }))
}

/** Downloads a model, reporting progress through `emit`. */
export async function pull(tag: string, emit: (e: ChatEvent) => void): Promise<void> {
  const r = await fetch(OLLAMA_URL + '/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: tag, stream: true }) })
  if (!r.ok || !r.body) throw new Error(tr("Descărcarea a eșuat: {status}", { status: r.status }))
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const ev = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string }
      if (ev.error) {
        emit({ type: 'pull', tag, status: 'eroare', error: ev.error, done: true })
        throw new Error(ev.error)
      }
      emit({ type: 'pull', tag, status: ev.status || '', completed: ev.completed, total: ev.total })
    }
  }
  emit({ type: 'pull', tag, status: 'gata', done: true })
}

export async function remove(tag: string): Promise<void> {
  const r = await fetch(OLLAMA_URL + '/api/delete', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: tag }) })
  if (!r.ok) throw new Error(tr("Nu am putut șterge {tag}: {status}", { tag, status: r.status }))
}

/**
 * Creates `<tag>-jolty` with a 64k context window, so Claude Code has room for a real project.
 * Returns the tag to use.
 */
export async function ensureLargeContext(tag: string): Promise<string> {
  const base = tag.replace(/:latest$/, '')
  const name = `${base.replace(/:/g, '-')}-jolty`
  await api('/api/create', { model: name, from: tag, parameters: { num_ctx: LOCAL_CONTEXT }, stream: false }, 120000)
  return name
}

/** Installs Ollama with winget in a visible console window (Windows). */
export function installOllama(): void {
  if (process.platform !== 'win32') throw new Error(tr("Instalarea automată e disponibilă doar pe Windows; descarcă Ollama de pe ollama.com"))
  spawn('cmd.exe', ['/d', '/s', '/c', '"start "Jolty - instalare Ollama" winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements"'], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true
  }).unref()
}
