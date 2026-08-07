import { describe, it, expect } from 'vitest';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goCoreBinaryAvailable, hostBinaryPath } from './_helpers.ts';
import { gatedSpecFilesOrAll, newestSourceMtimeMs } from './core-binary-guard-lib.ts';

/**
 * The honest-green guard for the spec suite.
 *
 * Every other file in `tests/spec/` opens with
 * `describe.skipIf(!goCoreBinaryAvailable)`, so a run without a prior
 * `npm run build` doesn't fail — it silently drops the ExtendScript golden
 * checks and still exits 0. Both runs report success; only the counts differ,
 * which is exactly what makes it easy to miss. The tests that vanish are the
 * ones pinning what the Go engine emits into Photoshop.
 *
 * That matters most exactly where it is least visible: `.githooks/pre-push`
 * runs `npm test` and never built anything, so for as long as that hook has
 * existed a push could be gated by a suite whose goldens never executed. The
 * hook now builds first, but a build step is not a guarantee —
 * `scripts/build-go-core-dev.ts` deliberately warns rather than fails when the
 * Go toolchain is missing, so `npm run build` can succeed and still leave no
 * binary behind. This guard turns that case into a failure.
 *
 * It is a plain `describe` on purpose. Gating this file on
 * `goCoreBinaryAvailable` — the reflex the rest of the directory teaches —
 * would make it skip in exactly the situation it exists to catch.
 *
 * **Scope, stated honestly:** this closes the gap for `tests/spec/` only.
 * Other suites still skip on absent build output and this guard does not speak
 * for them — `tests/api/snippet-client.test.ts` gates three `describe`s on
 * `go-core/bin/core.exe` and the host/Pro binaries, and
 * `tests/integration/build-output.test.ts` gates three more on
 * `packages/{ce,pro}/dist`, which only `build:ce`/`build:pro` produce and the
 * hook deliberately does not run (that cross-compile stays a release step).
 * A green push therefore still omits the CE/Pro bundle-composition assertions.
 * Closing that is a separate change; claiming it here would be the same
 * overstatement this guard exists to prevent.
 *
 * Escape hatch: `EDITMAMEI_ALLOW_MISSING_CORE=1` downgrades both checks to
 * skips, and works on a push too (`EDITMAMEI_ALLOW_MISSING_CORE=1 git push` —
 * git hooks inherit the invoking shell's environment). `tests/spec/` ships to
 * the public CE export, where a contributor without a Go toolchain still needs
 * the rest of the suite. It warns to stderr when used, because a skipped test
 * name is not a record of anything.
 */

const here = dirname(fileURLToPath(import.meta.url));
const GO_CORE_DIR = join(here, '..', '..', 'go-core');
const allowMissing = process.env.EDITMAMEI_ALLOW_MISSING_CORE === '1';

if (allowMissing) {
  console.warn(
    '[core-binary-guard] EDITMAMEI_ALLOW_MISSING_CORE=1 — the go-core binary ' +
      'checks are DISABLED. If the binary is missing or stale, the ExtendScript ' +
      'golden checks in tests/spec/ did not verify anything this run.'
  );
}

describe('spec: go-core binary guard', () => {
  it.skipIf(allowMissing)('the go-core binary exists, so the spec goldens actually ran', () => {
    const { files, degraded } = gatedSpecFilesOrAll(here);
    expect(
      goCoreBinaryAvailable,
      [
        `The go-core host binary is missing, so ${files.length} spec files silently skipped:`,
        ...files.map((f) => `  - tests/spec/${f}`),
        ...(degraded
          ? [
              '',
              '(Listing every spec file: no file matched the expected',
              '`skipIf(!goCoreBinaryAvailable)` idiom, so the gate detection itself',
              'has rotted — check core-binary-guard-lib.ts GATE_IDIOM.)',
            ]
          : []),
        '',
        `Expected it at: ${hostBinaryPath}`,
        '',
        'Fix: run `npm run build` (it emits dist/bin/), then re-run the tests.',
        'If the build already ran, the Go toolchain is probably absent —',
        'build-go-core-dev.ts warns rather than fails in that case.',
        '',
        'To run the rest of the suite without a Go toolchain, set',
        'EDITMAMEI_ALLOW_MISSING_CORE=1 (it works on `git push` too). That is an',
        'explicit, visible opt-out that warns the goldens did not run.',
      ].join('\n')
    ).toBe(true);
  });

  it.skipIf(allowMissing || !goCoreBinaryAvailable)(
    'the go-core binary is newer than every Go source, so the goldens pin current output',
    () => {
      const binaryMs = statSync(hostBinaryPath).mtimeMs;
      const sourceMs = newestSourceMtimeMs(GO_CORE_DIR);
      expect(
        binaryMs >= sourceMs,
        [
          'The go-core binary is older than the sources it is built from, so the',
          'spec goldens are checking ExtendScript that the current fragments no longer',
          'emit — a pass here would not mean what it says.',
          '',
          `  binary: ${new Date(binaryMs).toISOString()}  ${hostBinaryPath}`,
          `  source: ${new Date(sourceMs).toISOString()}  (newest build input under go-core/)`,
          '',
          'Fix: run `npm run build` to rebuild the binary from current sources.',
        ].join('\n')
      ).toBe(true);
    }
  );
});
