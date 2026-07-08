const { defineConfig } = require('vite');

// Dedicated config for the API/credit-engine tests. These are plain Node
// (express + supertest), so they run in the node environment from repo root —
// separate from the jsdom-based web component tests.
module.exports = defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['apps/api/**/*.test.js'],
    env: {
      // Sig auth middleware is unit-tested separately; disable it in engine
      // tests so they can POST without wallet signature headers.
      CHANCY_DISABLE_SIG_AUTH: '1',
    },
  },
});
