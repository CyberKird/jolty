import { create } from 'zustand'

// The line between the phone's connection (boot.ts, which exists before the app) and the PC screen page (PcScreen.tsx).

type Msg = Record<string, unknown>

let sender: (m: Msg) => void = () => undefined
const frames = new Set<(data: ArrayBuffer) => void>()
const messages = new Set<(m: Msg) => void>()

export const screenBus = {
  attach(send: (m: Msg) => void): void {
    sender = send
  },
  send(m: Msg): void {
    sender({ t: 'screen', ...m })
  },
  frame(data: ArrayBuffer): void {
    for (const cb of frames) cb(data)
  },
  message(m: Msg): void {
    for (const cb of messages) cb(m)
  },
  onFrame(cb: (data: ArrayBuffer) => void): () => void {
    frames.add(cb)
    return () => void frames.delete(cb)
  },
  onMessage(cb: (m: Msg) => void): () => void {
    messages.add(cb)
    return () => void messages.delete(cb)
  }
}

/** Whether the PC screen page is open (a button in the sidebar opens it, its close button shuts it). */
export const useScreenUi = create<{ open: boolean; setOpen: (v: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }))
