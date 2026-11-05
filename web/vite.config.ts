import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Same-origin /api in dev, so no CORS and no hard-coded server URL.
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
