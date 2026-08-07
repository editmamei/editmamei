/**
 * Pure helpers for `core-binary-guard.test.ts`, extracted so they can be
 * tested against fixture directories instead of only against the live tree.
 *
 * A guard whose own logic is unverified is a guard you are trusting on
 * faith — and both functions here have quiet failure modes (a filter that
 * matches nothing, a walk that misses an input) where the guard would still
 * pass while meaning nothing. `tests/integration/pre-push-gate.test.ts`
 * exercises them.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The gate idiom every binary-dependent spec file opens with. */
export const GATE_IDIOM = 'skipIf(!goCoreBinaryAvailable)';

/** This guard's own file, which must never count itself as gated. */
export const GUARD_FILENAME = 'core-binary-guard.test.ts';

/**
 * Spec files that actually gate on the go-core binary, read off disk rather
 * than hardcoded — a count in a message rots the first time someone adds a
 * spec file, and a stale number in a failure message is worse than none.
 *
 * Membership in the directory is NOT the test: `registry-integrity.test.ts`
 * lives there and runs unconditionally, so listing every neighbour would name
 * files that did not skip. Select on the gate itself.
 *
 * This is a substring match, so it fails OPEN: if Prettier ever wraps the
 * `describe.skipIf(...)` call across lines, or a file aliases the import, that
 * file drops off the list silently. The caller must treat an empty result as
 * broken rather than as "nothing was skipped" — see `gatedSpecFilesOrAll`.
 */
export function gatedSpecFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts') && f !== GUARD_FILENAME)
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes(GATE_IDIOM))
    .sort();
}

/**
 * The gated list, or every spec file when the filter matched nothing.
 *
 * The guard's assertion keys on `goCoreBinaryAvailable`, not on this list, so
 * a broken filter cannot make the guard pass wrongly — but it can make the
 * failure message read "all 0 spec files silently skipped", which tells the
 * reader the opposite of the truth. Falling back to the full listing keeps the
 * message honest even when the idiom match has rotted.
 */
export function gatedSpecFilesOrAll(dir: string): { files: string[]; degraded: boolean } {
  const gated = gatedSpecFiles(dir);
  if (gated.length > 0) return { files: gated, degraded: false };
  const all = readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts') && f !== GUARD_FILENAME)
    .sort();
  return { files: all, degraded: true };
}

/**
 * True for a file whose content changes what the compiled binary emits.
 *
 * `_test.go` files are excluded deliberately: they are compiled only by
 * `go test`, never linked into the shipped binary, so editing one would
 * otherwise report the binary as stale when it is not.
 */
export function isBinaryInput(name: string): boolean {
  if (name === 'go.mod' || name === 'go.sum') return true;
  return name.endsWith('.go') && !name.endsWith('_test.go');
}

/**
 * Newest mtime among the sources the binary is compiled from.
 *
 * `go.mod`/`go.sum` are included because a dependency bump changes the binary
 * without touching a single `.go` file. Still not a complete input set — the
 * Go toolchain version and any embedded non-Go asset can also change output —
 * so this detects the common staleness, not every possible one.
 *
 * Returns 0 for a missing directory rather than throwing: a trimmed export
 * without `go-core/` should not crash the guard with a raw ENOENT.
 */
export function newestSourceMtimeMs(dir: string): number {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtimeMs(full));
    } else if (isBinaryInput(entry.name)) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // A broken symlink is not a staleness signal; skip it rather than
        // failing a passing test with an ENOENT.
      }
    }
  }
  return newest;
}
