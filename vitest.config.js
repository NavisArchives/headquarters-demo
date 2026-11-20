import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // Many tests boot a real D1 (Miniflare, a SQLite file on disk; see
    // test/helpers/d1.js). On a Mac busy with other sessions one of them now
    // and then crossed vitest's 5 s default and failed for no reason of its
    // own (30 Oct: accept-quote ×2 and orders ×1 at 5.0–5.4 s, 1 run in 6).
    // 20 s still catches a real hang.
    testTimeout: 20_000,
  },
});
