import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  server: { port: 3012, host: '0.0.0.0' },
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      '@plannotator/atlas/styles': path.resolve(__dirname, '../../packages/atlas/styles.css'),
      '@plannotator/atlas/worker-pool': path.resolve(__dirname, '../../packages/atlas/workerPool.tsx'),
      '@plannotator/atlas': path.resolve(__dirname, '../../packages/atlas/index.ts'),
      '@plannotator/ui': path.resolve(__dirname, '../../packages/ui'),
    },
  },
  worker: {
    format: 'es',
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
