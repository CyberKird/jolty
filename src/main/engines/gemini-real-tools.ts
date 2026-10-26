// The tool groups Gemini can use in a chat: the Jolty browser and the PC, the same servers Claude and Codex reach over
// MCP, called here in the app itself (the page cannot speak MCP, so gemini-tools.ts carries the requests in text).
import { BROWSER_ACT_TOOLS, BROWSER_BLOCKED_TOOLS, BROWSER_READ_TOOLS, BROWSER_RULES, BROWSER_SERVER } from '../browser'
import { COMPUTER_ACT_TOOLS, COMPUTER_READ_TOOLS, COMPUTER_RULES, COMPUTER_SERVER } from '../computer/names'
import { nativeComputer } from '../computer/native'
import { nativeBrowser } from '../jbrowser/native'
import { loadSettings } from '../store'
import type { GeminiTools } from './gemini-web'
import type { ToolSet } from './gemini-tools'

const BROWSER_HOW =
  "Tabs you open appear in a separate Jolty browser window, so the user's own tabs stay untouched. Read pages with browser_snapshot (refs like e12 stay valid until the page changes; mode \"text\" gives just the readable text of an article or thread), use browser_find for things off screen and browser_scroll to move. Use browser_take_screenshot only when you need to see layout or images."

const browserSet: ToolSet = {
  server: BROWSER_SERVER,
  mcp: { handle: (sid, msg) => nativeBrowser.service.handle(sid, msg) },
  expose: (n) => BROWSER_READ_TOOLS.includes(n) || BROWSER_ACT_TOOLS.includes(n),
  kind: (n) => (BROWSER_BLOCKED_TOOLS.includes(n) ? 'blocked' : BROWSER_READ_TOOLS.includes(n) ? 'read' : BROWSER_ACT_TOOLS.includes(n) ? 'act' : 'other'),
  rules: `The browser tools (the user's Jolty browser window): ${BROWSER_HOW} ${BROWSER_RULES}`
}

const computerSet: ToolSet = {
  server: COMPUTER_SERVER,
  mcp: { handle: (sid, msg) => nativeComputer.handle(sid, msg) },
  expose: (n) => COMPUTER_READ_TOOLS.includes(n) || COMPUTER_ACT_TOOLS.includes(n),
  // the computer server asks the user itself, per application, outside Manual mode
  kind: (n) => (COMPUTER_READ_TOOLS.includes(n) || COMPUTER_ACT_TOOLS.includes(n) ? 'self' : 'other'),
  rules: `The PC tools: start with computer_screenshot (coordinates are pixels of the latest screenshot, origin top-left), look again after anything that changes the screen, and use them only for what a browser page cannot do. ${COMPUTER_RULES}`
}

export const realTools: GeminiTools = {
  sets: (meta) => [...(meta.browser ? [browserSet] : []), ...(meta.computer ? [computerSet] : [])],
  siteTrust: () => loadSettings().siteTrust || 'site',
  newTurn: (sid) => nativeComputer.newTurn(sid),
  interrupt: (sid) => nativeComputer.interrupt(sid)
}
