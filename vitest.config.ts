import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const editmameiSrc = resolve(__dirname, 'src');

// tests/gimp-live drives a real headless GIMP per file (several at once), which saturates the CPU
// and is only meaningful where GIMP is installed, so the default `npm test` leaves it out. Naming
// it on the command line brings it back: `npm run test:gimp` (vitest run tests/gimp-live), or one
// file at a time with `npx vitest run tests/gimp-live/<file>`.
const GIMP_LIVE = 'tests/gimp-live';
const gimpLiveRequested = process.argv.some((arg) => arg.replace(/\\/g, '/').includes(GIMP_LIVE));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(gimpLiveRequested ? [] : [`${GIMP_LIVE}/**`])],
    reporters: ['default'],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@editmamei': editmameiSrc,
    },
  },
});
