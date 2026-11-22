import { defineConfig, type Plugin } from 'vite';

// Content-Security-Policy for the production build. `connect-src 'self'` means
// the page itself cannot send data to any other origin; there is no backend on
// the same origin either (GitHub Pages is static).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  // Relative base: the same build works at username.github.io/<any-repo-name>/
  base: './',
  plugins: [csp()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    sourcemap: false,
    // PDF.js is one large chunk on purpose: everything loads up front so the app works offline.
    chunkSizeWarningLimit: 1500,
  },
});
