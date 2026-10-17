// The browser server as each engine wants it: Jolty's own bridge is a local HTTP MCP server (one URL per
// chat); the older modes run Playwright MCP as a child process.
import { browserMode, browserServer, BROWSER_SERVER } from './browser'
import { nativeBrowser } from './jbrowser/native'

export { BROWSER_SERVER }

/** For Claude Code (SDK `mcpServers`). */
export function claudeBrowserServer(sid: string): { type: 'stdio'; command: string; args: string[]; env: Record<string, string> } | { type: 'http'; url: string; headers: Record<string, string> } {
  if (browserMode() === 'jolty') return { type: 'http', ...nativeBrowser.mcp(sid) }
  return { type: 'stdio', ...browserServer() }
}

/** For Codex (`config.mcp_servers`). */
export function codexBrowserServer(sid: string): Record<string, unknown> {
  if (browserMode() === 'jolty') {
    const { url, headers } = nativeBrowser.mcp(sid)
    return { url, http_headers: headers, tool_timeout_sec: 120 }
  }
  return { ...browserServer() }
}
