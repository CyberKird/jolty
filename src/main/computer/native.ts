// Computer use as the app runs it: the helper process, the screen overlay and the service are built on first use,
// the kill key is registered, and the chat side (permission asks, notices, mode of a chat) comes in through bind().
import { clipboard, globalShortcut, app } from 'electron'
import path from 'path'
import type { PermissionDecision, PermissionMode } from '@shared/types'
import { tr } from '@shared/i18n'
import { dataDir, loadSettings, saveSettings } from '../store'
import { electronCapturer } from './capture'
import { NativeInput } from './helper'
import { ScreenOverlay } from './overlay'
import { ComputerService, type AskInput } from './service'

/** Ctrl+Alt+Esc: caught by the helper's keyboard hook (works while another program has focus) and, as a second way, by Electron. */
const KILL = { vk: 0x1b, mods: 3, accelerator: 'Control+Alt+Escape', label: 'Ctrl+Alt+Esc' }

export interface ComputerChats {
  mode(sid: string): PermissionMode | undefined
  enabled(sid: string): boolean
  ask(sid: string, q: AskInput): Promise<PermissionDecision>
  notice(sid: string, text: string, level: 'info' | 'warn' | 'error'): void
  /** the kill key was pressed: the toggle goes off in every chat that had it on */
  killed(): void
}

class NativeComputer {
  private svc?: ComputerService
  private input?: NativeInput
  private chats?: ComputerChats

  bind(chats: ComputerChats): void {
    this.chats = chats
  }

  private service(): ComputerService {
    if (this.svc) return this.svc
    const chats = (): ComputerChats => {
      if (!this.chats) throw new Error('computer use is not bound to the chats')
      return this.chats
    }
    const input = new NativeInput(() => path.join(dataDir(), 'computer'))
    this.input = input
    const svc = new ComputerService({
      input,
      capturer: electronCapturer,
      overlay: new ScreenOverlay(() => tr("Jolty folosește PC-ul · {key} oprește", { key: KILL.label })),
      host: {
        settings: () => {
          const s = loadSettings()
          return { human: s.computerHuman ?? 'max', paste: s.computerPaste === true, trusted: s.computerTrusted ?? [] }
        },
        trust: (key) => {
          const have = loadSettings().computerTrusted ?? []
          if (!have.includes(key)) saveSettings({ computerTrusted: [...have, key] })
        },
        mode: (sid) => chats().mode(sid),
        enabled: (sid) => chats().enabled(sid),
        ask: (sid, q) => chats().ask(sid, q),
        notice: (sid, text, level) => chats().notice(sid, text, level),
        clipboard: { readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t), hasImage: () => clipboard.has('image/png') },
        self: { pid: process.pid, exe: process.execPath }
      }
    })
    this.svc = svc
    const stop = (): void => void svc.killAll().then(() => this.chats?.killed())
    input.onKill(stop)
    void input.setKillKey(KILL.vk, KILL.mods)
    if (app.isReady()) globalShortcut.register(KILL.accelerator, stop)
    return svc
  }

  /** The MCP endpoint of the hub, for every chat. */
  handle(sid: string, msg: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    return this.service().handle(sid, msg)
  }

  /** The chat turned the toggle on or off. Turning it on starts the helper, so a missing compiler shows up right away. */
  async setEnabled(sid: string, on: boolean): Promise<void> {
    if (on) await this.service().input.start()
    this.svc?.setEnabled(sid, on)
  }

  /** A new message of the user: the action budget starts over. */
  newTurn(sid: string): void {
    this.svc?.newTurn(sid)
  }

  /** The chat is gone or the toggle is off: forget what it saw. */
  release(sid: string): void {
    this.svc?.release(sid)
  }

  async stop(): Promise<void> {
    if (!this.svc) return
    globalShortcut.unregister(KILL.accelerator)
    this.svc.overlay.destroy()
    await this.input?.stop()
    this.svc = undefined
    this.input = undefined
  }
}

export const nativeComputer = new NativeComputer()
