// Renders the app icon (build/icon.png + build/icon.ico) with Electron, from the Joltarise bolt symbol.
// Run: electron scripts/make-icon.cjs   (on Linux without a screen: xvfb-run -a electron ...)
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

// joltarise-v2/public/brand/joltarise-symbol.svg: round ink badge, volt bolt drawn heavy enough for 16 px
const SYMBOL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49" fill="#0b0b0a"/><svg x="14" y="6" width="72" height="88" viewBox="0 0 205 740"><polygon fill="#d4ff00" points="52,0 170,0 118,300 205,284 56,740 84,408 0,426"/></svg></svg>`

function html(size) {
  return `<!doctype html><html><head><style>
html { zoom: __S__; }
html, body { margin: 0; width: ${size}px; height: ${size}px; background: transparent; overflow: hidden; }
svg { display: block; width: ${size}px; height: ${size}px; }
</style></head><body>${SYMBOL}</body></html>`
}

/** Renders the `size` design on a canvas of at least 256 px, then scales it down. Returns a NativeImage. */
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
  return img.resize({ width: size, height: size, quality: 'best' })
}

// ponytail: Windows' small-icon path (taskbar/Alt-Tab HICON) doesn't reliably read
// PNG-compressed ICO entries the way the large-icon/Explorer path does, so small
// sizes need a classic raw BGRA DIB entry; PNG compression is kept for 128/256 only.
function bmpEntry(size, image) {
  const rgba = image.toBitmap() // BGRA, top-down rows
  const rowBytes = size * 4
  const andRowBytes = Math.ceil(size / 32) * 4
  const header = 40
  const buf = Buffer.alloc(header + rowBytes * size + andRowBytes * size)
  buf.writeUInt32LE(header, 0)
  buf.writeInt32LE(size, 4)
  buf.writeInt32LE(size * 2, 8) // icon convention: XOR + AND combined height
  buf.writeUInt16LE(1, 12) // planes
  buf.writeUInt16LE(32, 14) // bits per pixel
  buf.writeUInt32LE(0, 16) // BI_RGB, uncompressed
  buf.writeUInt32LE(rowBytes * size, 20)
  for (let y = 0; y < size; y++) {
    const dstY = size - 1 - y // DIB rows are stored bottom-up
    rgba.copy(buf, header + dstY * rowBytes, y * rowBytes, y * rowBytes + rowBytes)
  }
  // AND mask left zeroed (fully opaque): ignored by Windows when the XOR image carries alpha
  return buf
}

/** ICO directory; small sizes get a raw BGRA entry, 128/256 stay PNG-compressed (Vista+). */
function ico(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach(({ size, data }, i) => {
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
  return Buffer.concat([header, dir, ...entries.map((p) => p.data)])
}

app.disableHardwareAcceleration()
// each size gets its own window; keep running between them
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const out = path.join(root, 'build')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'icon.png'), (await render(1024)).toPNG())
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const entries = []
  for (const size of sizes) {
    const image = await render(size)
    entries.push({ size, data: size <= 64 ? bmpEntry(size, image) : image.toPNG() })
    if (size === 32 || size === 256) fs.writeFileSync(path.join(process.env.ICON_PREVIEW || out, `icon-${size}.png`), image.toPNG())
  }
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(entries))
  console.log('icon written:', sizes.join(', '))
  app.quit()
})
