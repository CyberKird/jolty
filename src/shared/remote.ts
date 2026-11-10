/** A phone (or other browser) that was paired with this PC. The token itself is only kept by the device. */
export interface RemoteDevice {
  id: string
  name: string
  created: number
  lastSeen?: number
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
  /** what went wrong last, in words the user can act on */
  error?: string
}
