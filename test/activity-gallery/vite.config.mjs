import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = resolve(import.meta.dirname, '../..')
export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
  plugins: [react()],
  assetsInclude: ['**/*.glb'],
  build: { outDir: resolve(root, 'out-test/activity-gallery'), emptyOutDir: true, target: 'esnext', minify: 'esbuild' }
})
