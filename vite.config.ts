import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src',
  publicDir: resolve(__dirname, 'public'),
  base: './',  // Use relative paths for self-hosted embedding
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // IIFE keeps the bundle easy to embed in external hosts.
    modulePreload: false,
    rollupOptions: {
      input: {
        editor: resolve(__dirname, 'src/index.html'),
      },
      output: {
        // Keep filenames predictable for external embedding
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
        // Use IIFE format for broad runtime compatibility
        format: 'iife',
        // Ensure window.proof is accessible globally
        name: 'ProofEditor',
        inlineDynamicImports: true
      }
    },
  },
  server: {
    port: 5556,
    strictPort: true,  // Fail if port in use instead of auto-incrementing
    open: false,
    host: 'localhost',
    proxy: {
      '/assets': {
        target: 'http://localhost:5555',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:5555',
        changeOrigin: true,
      },
      '/d': {
        target: 'http://localhost:5555',
        changeOrigin: true,
      },
      '/new': {
        target: 'http://localhost:5555',
        changeOrigin: true,
      },
      '/get-started': {
        target: 'http://localhost:5555',
        changeOrigin: true,
      },
      '/agent-docs': {
        target: 'http://localhost:5555',
        changeOrigin: true,
      },
      '/open': {
        target: 'http://localhost:5555',
        changeOrigin: true,
      },
      '/logout': {
        target: 'http://localhost:5555',
        changeOrigin: true,
      },
      '/proof.SKILL.md': {
        target: 'http://localhost:5555',
        changeOrigin: true,
      },
      '/snapshots': {
        target: 'http://localhost:5555',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:5555',
        ws: true,
      },
    },
  },
});
