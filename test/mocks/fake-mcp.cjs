// A stdio MCP server for the sharing tests: logs its pid when it starts, answers initialize, tools/list and tools/call.
const fs = require('fs')
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, process.pid + '\n')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.id === undefined) continue
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n')
    if (m.method === 'initialize') send({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' }, instructions: 'use fake wisely' })
    else if (m.method === 'tools/list') send({ tools: [{ name: 'whoami', description: 'pid', inputSchema: { type: 'object' } }] })
    else if (m.method === 'tools/call') setTimeout(() => send({ content: [{ type: 'text', text: String(process.pid) }] }), 50)
    else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } }) + '\n')
  }
})
