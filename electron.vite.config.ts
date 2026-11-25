import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import hoverMedia from './scripts/postcss-hover-media'

const alias = { '@shared': resolve(__dirname, 'src/shared') }
// app.getVersion() reports Electron's version when the app is started from out/main directly
const version = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version

export default defineConfig({
  main: { resolve: { alias }, define: { __JOLTY_VERSION__: JSON.stringify(version) } },
  preload: { resolve: { alias } },
  // minified: a third of the size to parse on every launch
  // .glb: the mascot's model (imported ?inline)
  // manifest: the phone's page names the scripts it will run up front (main/remote-files.ts)
  // hoverMedia: every :hover rule applies only where a hover exists, so a phone never needs a second tap (scripts/postcss-hover-media.ts)
  renderer: { resolve: { alias }, plugins: [react()], assetsInclude: ['**/*.glb'], build: { minify: 'esbuild', manifest: 'build-manifest.json' }, css: { postcss: { plugins: [hoverMedia()] } } }
})
