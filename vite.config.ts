import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite for the Tauri frontend: fixed port for `tauri dev`, builds to web-dist/ (embedded
// into the EXE by Tauri). WebView2 = current Chromium -> modern target.
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
