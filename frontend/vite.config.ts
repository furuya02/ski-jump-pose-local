import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 開発時は Vite（3200 番）で画面を出し、/api はローカルサーバ（8000 番）へ流す
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3200,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
})
