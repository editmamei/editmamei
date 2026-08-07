/**
 * No commercial code in this repository.
 *
 * Editmamei is open core: the Community Edition is developed here in the open,
 * and the paid module is built elsewhere. The two are separated by directory
 * and by Go build tag rather than by anything subtle, which makes the boundary
 * cheap to check — and worth checking, because a leak is easy to cause (one
 * misplaced file) and impossible to take back once published.
 *
 * So this asserts the outcome rather than trusting the process: no commercial
 * directory, no `-pro` suffixed file, no Go file carrying an unnegated `pro`
 * build constraint, and no private build script. If you are contributing, you
 * should never trip this; if you do, a file has ended up somewhere it does not
 * belong.
 *
 * It reads git-tracked files rather than walking the filesystem: an untracked
 * stray is a local accident, whereas a tracked one is what actually publishes.
 *
 * The same file runs on the commercial side against a checkout of this
 * repository, so the check is applied from both directions.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CE_PRUNE_DIRS } from '../../scripts/lib/build-common.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Which tree to check.
 *
 * In this repository that is simply itself. The commercial build runs the same
 * file against a checkout of this repository placed in one of the locations
 * below, so one implementation covers both directions and cannot drift.
 */
const CHECKOUT_CANDIDATES = ['.ce', join('packages', 'public-export')];

/** A marker that exists only in the commercial tree. */
const COMMERCIAL_MARKER = 'package.pro.json';

function resolvePublicTree(): string | null {
  if (!existsSync(join(REPO_ROOT, COMMERCIAL_MARKER))) return REPO_ROOT;
  for (const c of CHECKOUT_CANDIDATES) {
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
      `No tree to check. Expected either this repository itself, or a checkout at one of: ` +
        `${CHECKOUT_CANDIDATES.join(', ')}. Verifying nothing and reporting success would be ` +
        `worse than failing here.`
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
