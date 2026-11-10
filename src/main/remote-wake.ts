import os from 'os'

/** The network cards of this PC that look like the one on the home network, the likely one first. */
export function lanMacs(): Array<{ name: string; mac: string; ip: string }> {
  const skip = /tailscale|vethernet|vmware|virtualbox|loopback|docker|wsl|bluetooth|hyper-v|vpn|tap|tun/i
  const out: Array<{ name: string; mac: string; ip: string; rank: number }> = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || !i.mac || /^(00:00:00:00:00:00|02:)/i.test(i.mac)) continue
      // a private address on a real card first: that is the network the packet has to reach
      const home = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)
      out.push({ name, mac: i.mac.toUpperCase().replace(/-/g, ':'), ip: i.address, rank: home ? 0 : 1 })
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ name, mac, ip }) => ({ name, mac, ip }))
}

/** The agent is reached over HTTPS (tailscale serve) and nothing else: anything else is refused with the reason. */
export function validAgentUrl(input: string): string {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    throw new Error('That is not an address. It looks like https://my-box.tailnet.ts.net:8443')
  }
  if (u.protocol !== 'https:') throw new Error('The address has to start with https:// (tailscale serve gives it)')
  if (u.username || u.password) throw new Error('The address must not hold a user name or password')
  return u.origin
}
