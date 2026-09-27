import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve(__dirname, 'src/shared') }
// app.getVersion() reports Electron's version when the app is started from out/main directly
const version = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version

export default defineConfig({
  main: { resolve: { alias }, define: { __JOLTY_VERSION__: JSON.stringify(version) } },
  preload: { resolve: { alias } },
  // minified: a third of the size to parse on every launch
  renderer: { resolve: { alias }, plugins: [react()], build: { minify: 'esbuild' } }
})
