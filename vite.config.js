import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves a project site (not a custom domain) from a
// /<repo-name>/ subpath, so every built asset URL needs that prefix — but
// only in that one build, never in local dev/preview. The GitHub Actions
// deploy workflow (.github/workflows/deploy.yml) sets GH_PAGES=true.
const base = process.env.GH_PAGES ? '/taskflow/' : '/';

export default defineConfig({
  base,
  plugins: [react()],
});
