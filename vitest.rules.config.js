import { defineConfig } from 'vitest/config';

// Separate config for Firestore security-rules tests (tests/rules/**). These
// require the Firestore emulator to be running (see `npm run test:rules`,
// which wraps this in `firebase emulators:exec`), so they're deliberately
// excluded from the default `test:unit` run (vitest.config.js) — that one
// must stay emulator-free and fast.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rules/**/*.test.js'],
  },
});
