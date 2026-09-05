import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Which version is running, readable from inside the application.
 *
 * "Are you on the latest?" is otherwise a question only a terminal can answer,
 * and asking somebody to open one to find out is how a five-minute problem
 * becomes an afternoon. It is stamped in at startup, so it is the version of
 * the code actually being served.
 */
function version(): string {
  try {
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const when = execSync('git log -1 --format=%cs', { encoding: 'utf8' }).trim();
    return `${hash} · ${when}`;
  } catch {
    // No git, or not a checkout — a downloaded zip, say. Saying so is better
    // than a version that looks real.
    return 'unknown';
  }
}

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['lucide-react'] },
  build: { sourcemap: true },
  define: { __APP_VERSION__: JSON.stringify(version()) },
});
