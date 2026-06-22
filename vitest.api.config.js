const { defineConfig } = require('vite');

// Dedicated config for the API/credit-engine tests. These are plain Node
// (express + supertest), so they run in the node environment from repo root —
// separate from the jsdom-based web component tests.
module.exports = defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['apps/api/**/*.test.js'],
  },
});
