import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './', // the packaged app loads dist/index.html over file://
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
