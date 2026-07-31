// Playwright config covering two suites:
//   - tests/e2e/full-suite/ — the tracked, maintained regression suite that
//     drives TaskFlow's own dev server end-to-end (see full-suite/README.md).
//     The webServer block below boots that dev server automatically, reusing
//     one that's already running locally instead of double-starting it.
//   - tests/e2e/todoist-parity.spec.js — no local server needed; it drives
//     Todoist's own web app to observe how it parses quick-add text, and
//     imports TaskFlow's own parser (parseTaskText) directly, no browser
//     needed for that half of the comparison.
//   - tests/e2e/manual/ — gitignored scratch scripts, also assume a dev
//     server at BASE_URL; the webServer block below covers these too.
import { defineConfig } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5183';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    headless: true,
    baseURL: BASE_URL,
  },
  webServer: {
    command: 'npm run dev -- --port 5183 --strictPort',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
