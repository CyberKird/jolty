// Renders the app icon (build/icon.png + build/icon.ico) with Electron, from the Joltarise bolt symbol.
// Run: electron scripts/make-icon.cjs   (on Linux without a screen: xvfb-run -a electron ...)
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

// joltarise-v2/public/brand/joltarise-symbol.svg: ink tile, volt bolt drawn heavy enough for 16 px
const SYMBOL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0b0b0a"/><svg x="14" y="6" width="72" height="88" viewBox="0 0 205 740"><polygon fill="#d4ff00" points="52,0 170,0 118,300 205,284 56,740 84,408 0,426"/></svg></svg>`

function html(size) {
  return `<!doctype html><html><head><style>
html { zoom: __S__; }
html, body { margin: 0; width: ${size}px; height: ${size}px; background: transparent; overflow: hidden; }
svg { display: block; width: ${size}px; height: ${size}px; }
</style></head><body>${SYMBOL}</body></html>`
}

/** Renders the `size` design on a canvas of at least 256 px, then scales it down. */
async function render(size) {
  const canvas = Math.max(size, 256)
  const w = new BrowserWindow({ width: canvas, height: canvas, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } })
  const file = path.join(app.getPath('temp'), `jolty-icon-${size}.html`)
  fs.writeFileSync(file, html(size).replace(/__S__/g, String(canvas / size)))
  await w.loadFile(file)
  fs.rmSync(file, { force: true })
  await new Promise((r) => setTimeout(r, 150))
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: canvas, height: canvas })
  w.destroy()
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG()
}

/** ICO with PNG-compressed entries (supported since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const dir = Buffer.alloc(16 * pngs.length)
  let offset = 6 + dir.length
  pngs.forEach(({ size, data }, i) => {
    const e = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, e)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)
    dir.writeUInt8(0, e + 2)
    dir.writeUInt8(0, e + 3)
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)])
}

app.disableHardwareAcceleration()
// each size gets its own window; keep running between them
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const out = path.join(root, 'build')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'icon.png'), await render(1024))
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = []
  for (const size of sizes) pngs.push({ size, data: await render(size) })
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(pngs))
  for (const p of pngs) if (p.size === 32 || p.size === 256) fs.writeFileSync(path.join(process.env.ICON_PREVIEW || out, `icon-${p.size}.png`), p.data)
  console.log('icon written:', sizes.join(', '))
  app.quit()
})
