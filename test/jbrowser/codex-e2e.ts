// Manual: does Codex reach the browser tools over MCP/HTTP? Needs Codex logged in on this PC.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { startHarness } from './harness'

const h = await startHarness()
try {
  const codex = path.resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe')
  const url = `http://127.0.0.1:${h.hub.port}/mcp/codex-e2e`
  const out = await new Promise<string>((resolve) => {
    const child = execFile(
      codex,
      [
        'exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only',
        '-c', `mcp_servers.jb.url="${url}"`,
        '-c', 'mcp_servers.jb.http_headers={Authorization="Bearer test-token-0123456789abcdef0123456789abcdef"}',
        '-c', 'mcp_servers.jb.tool_timeout_sec=90',
        `Use the jb MCP browser tools: call browser_navigate to ${h.site}/ and then tell me the main heading of the page in one short line.`
      ],
      { timeout: 150000, cwd: process.env.TEMP },
      (_e, so, se) => resolve(String(so) + '\n' + String(se).slice(-1500))
    )
  })
  console.log(out.slice(-2500))
} finally {
  await h.stop()
}
