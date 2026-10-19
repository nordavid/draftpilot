import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite fuer das Tauri-Frontend: fester Port fuer `tauri dev`, Build nach dist/ (wird
// von Tauri in die EXE eingebettet). WebView2 = aktuelles Chromium -> modernes Target.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  build: {
    target: 'chrome120',
    outDir: 'web-dist',
    emptyOutDir: true
  }
})
