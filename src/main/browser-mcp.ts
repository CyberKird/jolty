// The browser server as each engine wants it: Jolty's own bridge is a local HTTP MCP server (one URL per
// chat); the older modes run Playwright MCP as a child process. Jolty's own tools ride on the same local server.
import { browserMode, browserServer, BROWSER_SERVER } from './browser'
import { JOLTY_READ_TOOLS, JOLTY_SERVER } from './jolty-tools'
import { nativeBrowser } from './jbrowser/native'
import { COMPUTER_ACT_TOOLS, COMPUTER_READ_TOOLS, COMPUTER_SERVER } from './computer/names'

export { BROWSER_SERVER }

/** For Claude Code (SDK `mcpServers`). */
export function claudeBrowserServer(sid: string): { type: 'stdio'; command: string; args: string[]; env: Record<string, string> } | { type: 'http'; url: string; headers: Record<string, string> } {
  if (browserMode() === 'jolty') return { type: 'http', ...nativeBrowser.mcp(sid) }
  return { type: 'stdio', ...browserServer() }
}

/** For ACP agents (`mcpServers` of session/new and session/load): headers and env are name/value lists. */
export function acpBrowserServers(sid: string): Record<string, unknown>[] {
  const server = claudeBrowserServer(sid)
  const pairs = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }))
  return server.type === 'http'
    ? [{ type: 'http', name: BROWSER_SERVER, url: server.url, headers: pairs(server.headers) }]
    : [{ name: BROWSER_SERVER, command: server.command, args: server.args, env: pairs(server.env) }]
}

/** For Codex (`config.mcp_servers`). */
export function codexBrowserServer(sid: string): Record<string, unknown> {
  if (browserMode() === 'jolty') {
    const { url, headers } = nativeBrowser.mcp(sid)
    return { url, http_headers: headers, tool_timeout_sec: 120 }
  }
  return { ...browserServer() }
}

/** Jolty's tools for Claude Code: empty while the local server is not up, so a chat never waits on it. */
export function claudeJoltyServer(sid: string): Record<string, { type: 'http'; url: string; headers: Record<string, string> }> {
  const c = nativeBrowser.toolsMcp(sid)
  return c ? { [JOLTY_SERVER]: { type: 'http', ...c } } : {}
}

/** Jolty's tools for Codex; reading runs on its own outside Manual mode, like the browser's reading tools. */
export function codexJoltyServer(sid: string, manual: boolean): Record<string, Record<string, unknown>> {
  const c = nativeBrowser.toolsMcp(sid)
  if (!c) return {}
  const tools = manual ? {} : Object.fromEntries(JOLTY_READ_TOOLS.map((t) => [t, { approval_mode: 'approve' }]))
  return { [JOLTY_SERVER]: { url: c.url, http_headers: c.headers, tool_timeout_sec: 120, tools } }
}

/** Computer use for Claude Code; empty while the local server is not up. */
export function claudeComputerServer(sid: string): Record<string, { type: 'http'; url: string; headers: Record<string, string> }> {
  const c = nativeBrowser.computerMcp(sid)
  return c ? { [COMPUTER_SERVER]: { type: 'http', ...c } } : {}
}

/** Computer use for ACP agents (OpenCode). */
export function acpComputerServers(sid: string): Record<string, unknown>[] {
  const c = nativeBrowser.computerMcp(sid)
  return c ? [{ type: 'http', name: COMPUTER_SERVER, url: c.url, headers: Object.entries(c.headers).map(([name, value]) => ({ name, value })) }] : []
}

/** Jolty's own tools for ACP agents (OpenCode): the same local server Claude and Codex get. */
export function acpJoltyServers(sid: string): Record<string, unknown>[] {
  const c = nativeBrowser.toolsMcp(sid)
  return c ? [{ type: 'http', name: JOLTY_SERVER, url: c.url, headers: Object.entries(c.headers).map(([name, value]) => ({ name, value })) }] : []
}

/**
 * Computer use for Codex. Outside Manual mode every tool runs on its own: Jolty's server asks the user per application,
 * the same for all engines. In Manual mode Codex asks for each call.
 */
export function codexComputerServer(sid: string, manual: boolean): Record<string, Record<string, unknown>> {
  const c = nativeBrowser.computerMcp(sid)
  if (!c) return {}
  const tools = manual ? {} : Object.fromEntries([...COMPUTER_READ_TOOLS, ...COMPUTER_ACT_TOOLS].map((t) => [t, { approval_mode: 'approve' }]))
  return { [COMPUTER_SERVER]: { url: c.url, http_headers: c.headers, tool_timeout_sec: 120, tools } }
}
