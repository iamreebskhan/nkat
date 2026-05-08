import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      // Forward API calls in dev to the local Nest backend.
      '/v1': { target: 'http://localhost:3000', changeOrigin: true },
      '/scim': { target: 'http://localhost:3000', changeOrigin: true },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: true },
      '/readyz': { target: 'http://localhost:3000', changeOrigin: true },
      '/status': { target: 'http://localhost:3000', changeOrigin: true },
      '/.well-known': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    css: false,
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    exclude: ['node_modules', 'e2e/**', 'dist/**'],
  },
});
