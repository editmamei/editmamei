/**
 * The cross-boundary guard: no Pro or private path may exist in the public tree.
 *
 * This is the OUTCOME check. `public-export-guard.test.ts` verifies the export
 * script's derivation predicates — that the allowlist it computes excludes the
 * right things — which is only meaningful while this repo is the source of the
 * public tree. Once CE owns its own source there is no manifest to derive, so
 * those assertions describe a component that no longer exists. What still
 * matters is whether the published tree actually contains Pro code. Different
 * question, and the only one that survives the split.
 *
 * Per the migration plan's guard-relocation map this runs on BOTH sides:
 * authoritative here (the private repo can see the public one — one-way
 * visibility) and as a self-check in the public repo. One file serves both,
 * because the question is identical; only the tree it points at differs.
 *
 *  - private repo: checks the CE checkout (`.ce`, or the staging clone)
 *  - public repo:  checks itself
 *
 * It reads git-tracked files rather than the filesystem: an untracked stray is
 * a local accident, whereas a tracked one is what actually publishes.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CE_PRUNE_DIRS } from '../../scripts/lib/build-common.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `package.pro.json` exists only in the private tree (pinned by hydrate-ce.test.ts). */
const IS_PRIVATE = existsSync(join(REPO_ROOT, 'package.pro.json'));

/** Where a CE checkout may be found when running from the private repo. */
const CE_CANDIDATES = ['.ce', join('packages', 'public-export')];

function resolvePublicTree(): string | null {
  if (!IS_PRIVATE) return REPO_ROOT;
  for (const c of CE_CANDIDATES) {
    const p = join(REPO_ROOT, c);
    if (existsSync(join(p, '.git'))) return p;
  }
  return null;
}

const publicTree = resolvePublicTree();

function trackedFiles(root: string): string[] {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

/**
 * Directories whose presence in the public tree is a Pro-code leak.
 *
 * Mirrors the build's `CE_PRUNE_DIRS`, pinned against it below. The copy exists
 * because these are SOURCE paths (`src/…`) while the build prunes paths inside a
 * compiled bundle, so neither list is literally the other; the pin is what keeps
 * them from drifting. `scripts/lib/build-common.ts` is itself public, so the
 * import works in both repositories.
 */
const PRO_TREE_DIRS = ['src/modules/pro', 'src/templates', 'models/pro'];

/** Build and release scripts that must never publish. */
const PRIVATE_SCRIPT_NAMES = [
  'build-pro.ts',
  'build-pro-module.ts',
  'export-public.ts',
  'verify-export.ts',
  'hydrate-ce.ts',
  'gen-surface-map.ts',
];

describe('public-tree guard', () => {
  it('can see a public tree to check, or says so instead of passing vacuously', () => {
    // The failure this prevents is the worst kind: a guard that finds nothing
    // because it was looking nowhere, and reports that as success.
    expect(
      publicTree,
      IS_PRIVATE
        ? `No CE checkout found at any of: ${CE_CANDIDATES.join(', ')}. This guard cannot ` +
            `verify the public tree without one, and passing would mean nothing. ` +
            `Fix: run \`npm run hydrate:ce\` (which clones CE to .ce), then re-run.`
        : 'the public repo is its own tree, so this cannot be null'
    ).not.toBeNull();
  });

  it('the tree is non-trivially large, so an empty checkout cannot pass', () => {
    if (!publicTree) return;
    // Same class as the check above: a checkout with no files satisfies every
    // "does not contain" assertion below.
    expect(trackedFiles(publicTree).length).toBeGreaterThan(100);
  });

  it('contains no Pro directory', () => {
    if (!publicTree) return;
    const offenders = trackedFiles(publicTree).filter((f) =>
      PRO_TREE_DIRS.some((d) => f === d || f.startsWith(`${d}/`))
    );
    expect(
      offenders,
      `Pro directories present in the public tree: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('contains no *-pro source or test file', () => {
    if (!publicTree) return;
    const offenders = trackedFiles(publicTree).filter(
      (f) => /(^|\/)[^/]*-pro\.(ts|js)$/.test(f) || /(^|\/)[^/]*-pro\.test\.ts$/.test(f)
    );
    expect(offenders, `Pro-suffixed files in the public tree: ${offenders.join(', ')}`).toEqual([]);
  });

  it('contains no go-core file carrying an unnegated pro build constraint', () => {
    if (!publicTree) return;
    // The Go edition split is `//go:build pro`. `!pro` is the CE stub and must
    // stay. Matching the constraint text rather than the filename is what
    // catches a Pro file that was renamed without its tag changing.
    const offenders: string[] = [];
    for (const f of trackedFiles(publicTree).filter((f) => f.endsWith('.go'))) {
      const head = execFileSync('git', ['show', `HEAD:${f}`], {
        cwd: publicTree,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      })
        .split(/\r?\n/)
        .slice(0, 15)
        .join('\n');
      const m = head.match(/^\/\/go:build\s+(.+)$/m);
      if (m && /(^|[\s(|,])pro([\s)|,]|$)/.test(m[1]) && !/!pro/.test(m[1])) offenders.push(f);
    }
    expect(offenders, `pro-tagged Go files in the public tree: ${offenders.join(', ')}`).toEqual(
      []
    );
  });

  it('contains no private build or release script', () => {
    if (!publicTree) return;
    const offenders = trackedFiles(publicTree).filter((f) =>
      PRIVATE_SCRIPT_NAMES.some((n) => f === `scripts/${n}` || f.endsWith(`/${n}`))
    );
    expect(offenders, `private scripts in the public tree: ${offenders.join(', ')}`).toEqual([]);
  });

  it('PRO_TREE_DIRS still covers what the build prunes from a CE bundle', () => {
    // The derived-list invariant: a copied list needs a sync test, or it drifts
    // the first time the original changes.
    for (const d of CE_PRUNE_DIRS) {
      expect(
        PRO_TREE_DIRS,
        `the build prunes "${d}" from CE bundles, but this guard would not flag src/${d} ` +
          `in the public SOURCE tree — the two lists have drifted`
      ).toContain(`src/${d}`);
    }
  });
});
