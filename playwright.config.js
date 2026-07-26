// Playwright config for the Todoist smart-parse parity suite (see
// tests/e2e/todoist-parity.spec.js). No local server is started here — the
// spec only drives Todoist's own web app to observe how it parses quick-add
// text; TaskFlow's own parser (parseTaskText) is imported and run directly,
// no browser needed for that half of the comparison.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    headless: true,
  },
});
