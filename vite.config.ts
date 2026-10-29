import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // `vercel dev` serves /api; plain `vite` proxies to it when running.
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { sourcemap: false },
});
