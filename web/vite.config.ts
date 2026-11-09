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
    // One bundle on purpose (spec §3 #157): hashed files are cached for a year,
    // and a split makes the first terminal wait for a second file.
    chunkSizeWarningLimit: 600,
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
    // The Host header stays the dev server's: the server takes a change only
    // when Origin names its Host (spec §8). The string form rewrites Host.
    proxy: {
      '/api': { target: 'http://127.0.0.1:7761', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:7761', ws: true, changeOrigin: false },
      // A linked host's API and sockets, relayed by the server (spec §3
      // #161). The key ends in a slash so that only /h/<ID>/… goes there.
      '/h/': { target: 'http://127.0.0.1:7761', ws: true, changeOrigin: false },
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
