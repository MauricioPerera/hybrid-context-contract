import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  // Relative base so the static build can be served from any subpath (e.g. GitHub Pages).
  base: './',
  resolve: {
    alias: {
      // The engine imports node's `crypto` only for SHA-256; map it to a tiny shim
      // instead of pulling in a full crypto polyfill.
      crypto: fileURLToPath(new URL('./src/crypto-shim.ts', import.meta.url))
    }
  },
  server: {
    // Allow importing the compiled engine from the parent project (../dist).
    fs: { allow: ['..'] }
  }
});
