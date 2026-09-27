// Renders the app icon (build/icon.png + build/icon.ico) with Electron, from the Joltarise fonts.
// Run: electron scripts/make-icon.cjs   (on Linux without a screen: xvfb-run -a electron ...)
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const font = fs.readFileSync(path.join(root, 'node_modules/@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2')).toString('base64')

function html(size) {
  // small sizes get a heavier letter and no inner frame so the J stays readable at 16 px
  const small = size <= 48
  return `<!doctype html><html><head><style>
@font-face { font-family: Bebas; src: url(data:font/woff2;base64,${font}) format('woff2'); }
html { zoom: __S__; }
html, body { margin: 0; width: ${size}px; height: ${size}px; background: transparent; overflow: hidden; }
.tile { position: absolute; inset: 0; background: #020204; }
.frame { position: absolute; inset: ${size * 0.06}px; border: ${Math.max(1, size / 128)}px solid #1d1f24; display: ${small ? 'none' : 'block'}; }
.j { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); text-align: center;
     font-family: Bebas; color: #d4ff00; font-size: ${size * (small ? 1.02 : 0.86)}px; line-height: 1;
     margin-top: ${size * (small ? 0.06 : 0.05)}px; ${small ? `-webkit-text-stroke: ${size / 40}px #d4ff00;` : ''} }
.bar { position: absolute; left: ${size * 0.06}px; right: ${size * 0.06}px; bottom: ${size * 0.06}px; height: ${Math.max(1, size * 0.018)}px; background: #d4ff00; display: ${small ? 'none' : 'block'}; }
</style></head><body><div class="tile"></div><div class="frame"></div><div class="j">J</div><div class="bar"></div></body></html>`
}

/** Renders the `size` design on a canvas of at least 256 px, then scales it down. */
async function render(size) {
  const canvas = Math.max(size, 256)
  const w = new BrowserWindow({ width: canvas, height: canvas, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } })
  const file = path.join(app.getPath('temp'), `jolty-icon-${size}.html`)
  fs.writeFileSync(file, html(size).replace(/__S__/g, String(canvas / size)))
  await w.loadFile(file)
  fs.rmSync(file, { force: true })
  await w.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
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
