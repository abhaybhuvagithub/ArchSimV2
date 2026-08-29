import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The web app is a *consumer* of the packages, not their owner. Nothing in
// src/ may import from another app, and nothing in packages/ may import from
// here — that separation is what let the engine move into a CLI at all.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  server: { port: 5173 },
})
