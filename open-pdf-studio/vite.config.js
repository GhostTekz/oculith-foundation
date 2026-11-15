import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { pdfjsAssets } from './scripts/pdfjs-assets.mjs';
import { preloadMain } from './scripts/preload-main.mjs';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const edition = 'community';

export default defineConfig({
  cacheDir: process.env.OCUDRAW_VITE_CACHE_DIR || undefined,
  plugins: [solidPlugin(), pdfjsAssets(), preloadMain()],
  resolve: {
    alias: [
      // Add-ons load through the public plug-in host at startup.
      // PDF.js 6's modern build calls Map.prototype.getOrInsertComputed and
      // other recent APIs without fallbacks; the WebViews on older macOS and
      // Linux lack them. The legacy build ships the polyfills.
      { find: /^pdfjs-dist$/, replacement: 'pdfjs-dist/legacy/build/pdf.mjs' },
    ],
  },
  define: {
    '__APP_VERSION__': JSON.stringify(pkg.version),
    '__OCUDRAW_EDITION__': JSON.stringify(edition),
  },
  server: {
    port: 3041,
    strictPort: true,
    // `::` accepts IPv4 and IPv6. The debug app loads http://localhost:3041,
    // and this host resolves ::1 before 127.0.0.1. A preview started with
    // --host 0.0.0.0 --port 3042 still overrides this.
    host: '::',
    fs: {
      // Sta /@fs/-requests binnen de hele repo toe (dev-project + workspace-
      // crates). Zonder dit weigert Vite o.a. de PDF.js-worker-URL met 403 in
      // een verse webview — het document laadt dan nooit (zie js/pdf/loader.js).
      allow: ['..'],
    },
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    // Share the HTTP port. A fixed 3041 socket stays open when the preview
    // is started on 3042, and a normal GET there returns 426. localhost then
    // reaches that socket instead of the debug app.
    hmr: {
      protocol: 'ws',
      host: 'localhost',
    },
  },
  optimizeDeps: {
    // Alleen in de PDFium-worker van de webversie geïmporteerd (pdf/pdfium-web/):
    // vooraf bundelen, anders ontdekt de dev-server hem pas bij de eerste
    // render en herlaadt hij de pagina midden in het openen.
    include: ['@embedpdf/pdfium'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 6000,
    // The PDF.js worker shim (js/pdf/pdfjs-worker-shim.js) reads the worker
    // to load from its own URL's query; a data: URL has none, so it stays a
    // file however small it is.
    assetsInlineLimit: (filePath) => (/pdfjs-worker-shim\.js$/.test(filePath) ? false : undefined),
    rollupOptions: {
      output: {
        // Force .js extensions on entry chunks and dynamic-import chunks
        // so the web host serves them with the correct MIME type
        // (some hosts return application/octet-stream for .mjs).
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        // Same treatment for assets, but ONLY for .mjs files (don't touch
        // CSS, images, fonts, etc). PDF.js's worker is loaded via
        //   new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url)
        // which Vite handles as an asset import — without this, the
        // worker is emitted as `pdf.worker-HASH.mjs` and the web build
        // can't fetch it.
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name || '';
          if (name.endsWith('.mjs')) {
            return 'assets/[name]-[hash].js';
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
