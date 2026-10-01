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

// large-image-timing.test.ts builds a ~217MP image and runs real GIMP ops against it (its own
// EDITMAMEI_GIMP_PERF=1 gate decides whether that heavy work actually runs, but even an idle file
// opens a vitest worker). Run alongside the REST of tests/gimp-live -- which vitest parallelizes
// across worker files, each driving its own real headless GIMP -- the CPU/memory contention skews
// its own measurements AND has pushed an unrelated file's live test (verify-ops.live.test.ts's
// "spatial scaling clamps..." test) past its own 30s timeout under that load. Always excluded from
// the general tests/gimp-live run; `npm run test:gimp:timing` (or naming the file directly) is the
// one way to run it, alone.
const GIMP_TIMING_FILE = 'tests/gimp-live/large-image-timing.test.ts';
const gimpTimingRequested = process.argv.some((arg) =>
  arg.replace(/\\/g, '/').includes(GIMP_TIMING_FILE)
);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      ...(gimpLiveRequested ? [] : [`${GIMP_LIVE}/**`]),
      ...(gimpTimingRequested ? [] : [GIMP_TIMING_FILE]),
    ],
    reporters: ['default'],
    testTimeout: 10_000,
    // Live GIMP teardown (`session.shutdown()` in each file's afterAll) is a graceful quit bounded
    // by SHUTDOWN_GRACE_MS plus a process-tree kill; with many GIMPs running at once on a CI
    // runner that can exceed vitest's 10 s default hook budget even though every test passed.
    ...(gimpLiveRequested ? { hookTimeout: 60_000 } : {}),
  },
  resolve: {
    alias: {
      '@editmamei': editmameiSrc,
    },
  },
});
