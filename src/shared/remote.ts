/** A phone (or other browser) that was paired with this PC. The token itself is only kept by the device. */
export interface RemoteDevice {
  id: string
  name: string
  created: number
  lastSeen?: number
  /** connected to this PC at this moment */
  online?: boolean
}

export interface RemoteStatus {
  enabled: boolean
  /** the local server is listening */
  running: boolean
  port: number
  /** Tailscale: not installed, installed but signed out, or ready */
  tailscale: 'missing' | 'off' | 'ready'
  /** https address the phone opens (set once Tailscale serves the port) */
  url?: string
  devices: RemoteDevice[]
  /** the PC's screen on the phone: switched on at the PC only, and how many phones look at it now */
  screen: { allowed: boolean; viewers: number }
  /** what went wrong last, in words the user can act on */
  error?: string
}

/** Where a phone asks for this PC to be woken while it is off: a small agent on a device that stays on in the same network. */
export interface WakeConfig {
  url: string
  token: string
}

export interface WakeStatus {
  /** where the agent can be reached (empty until the user sets it) */
  url: string
  /** the secret the agent and the phones share */
  token: string
  /** the address the agent lets in (this PC's page) */
  origin: string
  /** the network cards of this PC, the likely one first */
  macs: Array<{ name: string; mac: string; ip: string }>
}

export interface WakeTest {
  ok: boolean
  /** the MAC the agent was started with */
  mac?: string
  error?: string
}
