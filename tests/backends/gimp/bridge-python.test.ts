/**
 * Runs the bridge's stdlib-only `test_lib.py` suite via a real `python`/
 * `python3` executable when one is usable, skipping cleanly otherwise —
 * the same optional-external-tool shape as the Go toolchain probe in
 * `scripts/lib/build-common.ts`'s `buildGoCoreDev` (probe first, degrade to
 * a skip rather than fail a contributor's machine that lacks the tool).
 * `lib.py` itself has zero GIMP/numpy dependency, so this never needs a
 * GIMP install — only Python.
 *
 * `EDITMAMEI_REQUIRE_PYTHON=1` flips the missing-tool case from a skip to a
 * hard failure — the same honesty trap `tests/spec/core-binary-guard.test.ts`
 * closes for the Go core binary and `tests/gimp-live/session.live.test.ts`
 * closes for GIMP itself: a CI job that's SUPPOSED to have Python must never
 * go quietly green because the tool silently wasn't there.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = join(__dirname, '..', '..', '..', 'src', 'backends', 'gimp', 'bridge');
const REQUIRE_PYTHON = process.env.EDITMAMEI_REQUIRE_PYTHON === '1';

/**
 * A real interpreter prints an actual version string on stdout and exits 0.
 * The Windows Store's `python`/`python3` stub (installed by default on a
 * clean Windows machine with no real Python) does neither when run
 * non-interactively: it exits non-zero without a version string rather than
 * launching the Store, so checking the exit code alone isn't enough to rule
 * it out — the stub can look superficially like success.
 */
function findPython(): string | null {
  for (const candidate of ['python', 'python3']) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version)'], {
      encoding: 'utf8',
    });
    if (!probe.error && probe.status === 0 && /\d+\.\d+\.\d+/.test(probe.stdout ?? '')) {
      return candidate;
    }
  }
  return null;
}

const python = findPython();

it('a usable python/python3 must be found when EDITMAMEI_REQUIRE_PYTHON=1', () => {
  if (!REQUIRE_PYTHON) return;
  expect(
    python,
    'EDITMAMEI_REQUIRE_PYTHON=1 but no usable python/python3 was found (checked for a real ' +
      'version string on stdout, which also rules out the Windows Store stub)'
  ).not.toBeNull();
});

describe.skipIf(!python)('bridge/lib.py (python -m unittest)', () => {
  it('passes the stdlib-only lib.py unit test suite', () => {
    const result = spawnSync(python!, ['-m', 'unittest', 'test_lib', '-v'], {
      cwd: BRIDGE_DIR,
      encoding: 'utf8',
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
  });
});
