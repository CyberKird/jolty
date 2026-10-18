// Bundles one browser test with esbuild (Electron stubbed) and runs it: node test/jbrowser/run.mjs <file> [--test]
// Through esbuild's JS API: on Linux its bin/esbuild is the native binary, which node cannot run.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { buildSync } from 'esbuild'

const [file, ...rest] = process.argv.slice(2)
const out = path.join('out-test', 'jb-' + path.basename(file).replace(/\.ts$/, '') + '.mjs')
buildSync({
  entryPoints: [file],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { electron: './test/electron-stub.ts', '@shared': './src/shared' },
  external: ['ws'],
  outfile: out,
  logLevel: 'error',
  banner: { js: 'import{createRequire as __cr}from"module";const require=__cr(import.meta.url);' }
})
execFileSync(process.execPath, [...(rest.includes('--test') ? ['--test'] : []), out], { stdio: 'inherit' })
