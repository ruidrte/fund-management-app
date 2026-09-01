/**
 * Single-file build.
 *
 * Inlines every asset into one HTML document so the application can be opened
 * from a link, an email attachment or a local disk with no server and no
 * network. Used for review builds; `vite.config.ts` remains the real one.
 */
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Folds the emitted JS and CSS into index.html and drops the separate files. */
function inlineEverything(): Plugin {
  return {
    name: 'inline-everything',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find(
        (file) => file.type === 'asset' && file.fileName.endsWith('.html'),
      );
      if (!html || html.type !== 'asset') return;

      let source = String(html.source);

      for (const [name, file] of Object.entries(bundle)) {
        // The replacement is a function, not a string. Minified JS is full of
        // `$` sequences, and String.replace treats `$&`, `$1` and friends as
        // substitution patterns — passing the code as a string silently
        // corrupts it wherever one appears.
        if (file.type === 'chunk' && file.isEntry) {
          source = source.replace(
            new RegExp(`<script[^>]*src="[^"]*${escapeRe(file.fileName)}"[^>]*></script>`),
            () => `<script type="module">${file.code}</script>`,
          );
          delete bundle[name];
        } else if (file.type === 'asset' && file.fileName.endsWith('.css')) {
          source = source.replace(
            new RegExp(`<link[^>]*href="[^"]*${escapeRe(file.fileName)}"[^>]*>`),
            () => `<style>${String(file.source)}</style>`,
          );
          delete bundle[name];
        }
      }

      html.source = source;
    },
  };
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default defineConfig({
  plugins: [react(), inlineEverything()],
  build: {
    outDir: 'dist-single',
    sourcemap: false,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // One chunk: a separate file could not be fetched from a single-file host.
        inlineDynamicImports: true,
      },
    },
  },
});
