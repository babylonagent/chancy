const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

module.exports = defineConfig({
  plugins: [react()],
  root: 'apps/web',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/tx': 'http://localhost:8787',
      '/read': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
