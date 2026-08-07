/**
 * The push gate's own tests.
 *
 * Two things make a green push mean what it says, and neither was verified by
 * anything until this file existed:
 *
 *  1. `.githooks/pre-push` must build BEFORE it tests. `tests/spec/*` gate on
 *     the go-core binary and skip when it is absent, so a buildless run drops
 *     the ExtendScript golden checks and still exits 0 — which is what the
 *     hook did for its entire life before 2026-08-06. Nothing stopped a future
 *     edit from reordering those two lines and silently restoring it.
 *  2. `core-binary-guard`'s helpers decide WHAT that guard reports. They have
 *     quiet failure modes — a substring filter that matches nothing, a walk
 *     that misses an input or throws on a broken symlink — where the guard
 *     still passes but no longer means anything.
 *
 * Testing the guard by hand is what the guard exists to stop people doing.
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATE_IDIOM,
  GUARD_FILENAME,
  gatedSpecFiles,
  gatedSpecFilesOrAll,
  isBinaryInput,
  newestSourceMtimeMs,
} from '../spec/core-binary-guard-lib.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_PATH = join(REPO_ROOT, '.githooks', 'pre-push');

const scratch: string[] = [];
function fixtureDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'editmamei-guard-'));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** Commands the hook runs, in order, ignoring comments and echo lines. */
function hookCommands(): string[] {
  return readFileSync(HOOK_PATH, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('npm '));
}

/**
 * `.githooks/pre-push` is an artifact of the PRIVATE monorepo — the public CE
 * export ships only `.githooks/commit-msg` and writes its own CI. So these two
 * tests must not run in the exported tree, where the file legitimately does not
 * exist. (`npm run verify:export` caught exactly that: this file shipped to CE
 * and failed both assertions there.)
 *
 * Keyed on a private-tree marker rather than on the hook's own presence — so a
 * hook DELETED from the private repo fails the assertion below instead of
 * quietly skipping the whole block. Absent file, present marker = a real
 * regression; absent file, absent marker = the public tree, correctly silent.
 *
 * The marker is `package.pro.json`, one of the three root files that exist only
 * in the private tree (pinned as an exact list by `tests/scripts/hydrate-ce.test.ts`).
 * A root file is deliberate: the public-export guard forbids an exported file
 * from naming a private documentation path, so the marker the hook itself uses
 * is not one this file is allowed to mention.
 */
const IS_PRIVATE_MONOREPO = existsSync(join(REPO_ROOT, 'package.pro.json'));

describe.skipIf(!IS_PRIVATE_MONOREPO)('pre-push hook', () => {
  it('exists in the private monorepo', () => {
    expect(
      existsSync(HOOK_PATH),
      '.githooks/pre-push is missing from the private tree — the push gate is gone'
    ).toBe(true);
  });

  it('runs npm run build before npm test', () => {
    const cmds = hookCommands();
    const build = cmds.indexOf('npm run build');
    const test = cmds.indexOf('npm test');

    expect(
      build,
      'the hook must run `npm run build`; without it tests/spec/* skip'
    ).toBeGreaterThan(-1);
    expect(test, 'the hook must run `npm test`').toBeGreaterThan(-1);
    expect(
      build,
      'BUILD MUST PRECEDE TEST. tests/spec/* gate on the go-core binary and skip ' +
        'silently when it is absent, so testing first drops the ExtendScript golden ' +
        'checks while still exiting 0 — the exact bug fixed on 2026-08-06.'
    ).toBeLessThan(test);
  });

  it('still runs the fast checks', () => {
    const cmds = hookCommands();
    for (const required of ['npm run format:check', 'npm run lint', 'npm run typecheck']) {
      expect(cmds, `the hook dropped ${required}`).toContain(required);
    }
  });
});

describe('core-binary-guard helpers: gate detection', () => {
  it('selects only files carrying the gate idiom, and never the guard itself', () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, 'gated.test.ts'), `describe.${GATE_IDIOM}('x', () => {});`);
    writeFileSync(join(dir, 'ungated.test.ts'), `describe('x', () => {});`);
    writeFileSync(join(dir, GUARD_FILENAME), `describe.${GATE_IDIOM}('guard', () => {});`);
    writeFileSync(join(dir, 'notatest.ts'), `describe.${GATE_IDIOM}('x', () => {});`);

    expect(gatedSpecFiles(dir)).toEqual(['gated.test.ts']);
  });

  it('reports the real spec files rather than "0 skipped" when the idiom stops matching', () => {
    // The rot case: Prettier wraps the call, or a file aliases the import, so
    // the substring no longer matches anything. Reporting an empty list would
    // tell the reader the opposite of the truth.
    const dir = fixtureDir();
    writeFileSync(join(dir, 'a.test.ts'), `describe.skipIf(\n  !goCoreBinaryAvailable\n)('x')`);
    writeFileSync(join(dir, 'b.test.ts'), `describe.skipIf(!available)('x')`);

    expect(gatedSpecFiles(dir)).toEqual([]);
    const { files, degraded } = gatedSpecFilesOrAll(dir);
    expect(degraded).toBe(true);
    expect(files).toEqual(['a.test.ts', 'b.test.ts']);
  });

  it('does not degrade when the idiom matches normally', () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, 'a.test.ts'), `describe.${GATE_IDIOM}('x', () => {});`);
    writeFileSync(join(dir, 'b.test.ts'), `describe('plain', () => {});`);

    const { files, degraded } = gatedSpecFilesOrAll(dir);
    expect(degraded).toBe(false);
    expect(files).toEqual(['a.test.ts']);
  });

  it('matches the live tests/spec directory, which must have gated files', () => {
    // Guards the guard against the fixture-only illusion: the helpers could be
    // correct in isolation and still not match how the real directory is written.
    const { files, degraded } = gatedSpecFilesOrAll(join(REPO_ROOT, 'tests', 'spec'));
    expect(degraded, 'no live spec file matched the gate idiom — GATE_IDIOM has rotted').toBe(
      false
    );
    expect(files.length).toBeGreaterThan(0);
    expect(files).not.toContain(GUARD_FILENAME);
    // registry-integrity runs unconditionally; listing it would name a file
    // that did not actually skip.
    expect(files).not.toContain('registry-integrity.test.ts');
  });
});

describe('core-binary-guard helpers: staleness inputs', () => {
  it('counts sources and module files, but not Go test files', () => {
    expect(isBinaryInput('registry.go')).toBe(true);
    expect(isBinaryInput('go.mod')).toBe(true);
    expect(isBinaryInput('go.sum')).toBe(true);
    // Compiled only by `go test`, never linked into the shipped binary —
    // counting it would report a stale binary when nothing shipped changed.
    expect(isBinaryInput('edition_test.go')).toBe(false);
    expect(isBinaryInput('README.md')).toBe(false);
    expect(isBinaryInput('templates.enc')).toBe(false);
  });

  it('finds the newest mtime recursively', () => {
    const dir = fixtureDir();
    mkdirSync(join(dir, 'nested', 'deep'), { recursive: true });
    const old = join(dir, 'old.go');
    const recent = join(dir, 'nested', 'deep', 'recent.go');
    writeFileSync(old, 'package main');
    writeFileSync(recent, 'package main');

    const t1 = new Date('2020-01-01T00:00:00Z');
    const t2 = new Date('2030-01-01T00:00:00Z');
    utimesSync(old, t1, t1);
    utimesSync(recent, t2, t2);

    expect(newestSourceMtimeMs(dir)).toBe(t2.getTime());
  });

  it('ignores a Go test file even when it is the newest thing present', () => {
    const dir = fixtureDir();
    const src = join(dir, 'registry.go');
    const tst = join(dir, 'registry_test.go');
    writeFileSync(src, 'package main');
    writeFileSync(tst, 'package main');

    const t1 = new Date('2020-01-01T00:00:00Z');
    const t2 = new Date('2030-01-01T00:00:00Z');
    utimesSync(src, t1, t1);
    utimesSync(tst, t2, t2);

    expect(newestSourceMtimeMs(dir)).toBe(t1.getTime());
  });

  it('returns 0 for a missing directory instead of throwing', () => {
    // A trimmed export without go-core/ should not crash the guard with ENOENT.
    expect(newestSourceMtimeMs(join(fixtureDir(), 'does-not-exist'))).toBe(0);
  });

  it('detects a dependency bump that touches no .go file', () => {
    const dir = fixtureDir();
    const src = join(dir, 'main.go');
    const mod = join(dir, 'go.mod');
    writeFileSync(src, 'package main');
    writeFileSync(mod, 'module x');

    const t1 = new Date('2020-01-01T00:00:00Z');
    const t2 = new Date('2030-01-01T00:00:00Z');
    utimesSync(src, t1, t1);
    utimesSync(mod, t2, t2);

    expect(newestSourceMtimeMs(dir)).toBe(t2.getTime());
  });
});
