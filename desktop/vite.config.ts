import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './', // the desktop app serves dist/ as app://groundwork (desktop/electron/main.cjs); relative URLs work anywhere
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
