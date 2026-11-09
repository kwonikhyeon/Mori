import { defineConfig } from 'vitest/config'

// The build goes straight into the Go embed directory (spec §3 #115).
// Assets are never inlined: the CSP forbids data: fonts and scripts.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  plugins: [
    {
      // emptyOutDir removes the .gitkeep that keeps dist/ in git.
      name: 'mori-gitkeep',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: '.gitkeep', source: '' })
      },
    },
  ],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7761',
      '/ws': { target: 'ws://127.0.0.1:7761', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    // Stylesheets are emptied in tests; one asked for as text stays as it is (styles.test.ts).
    css: { include: [/\.css\?raw$/] },
  },
})
