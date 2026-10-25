import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildPackageJson,
  checkBundledLicenses,
  type BundledPackage,
  type SourcePackageJson,
} from '../../scripts/lib/build-common.js';

// The CE tarball bundles its runtime dependency tree, so an install resolves
// nothing from the registry and runs exactly what the release gate tested.
// Bundling also makes Editmamei the redistributor of every package in that
// tree, which is what the license checks below guard.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as SourcePackageJson;
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const notices = readFileSync(join(ROOT, 'NOTICES.md'), 'utf8');

const clean = (over: Partial<BundledPackage> = {}): BundledPackage => ({
  name: 'a',
  license: 'MIT',
  hasLicenseFile: true,
  ...over,
});

describe('bundled dependencies', () => {
  it('the CE manifest bundles every runtime dependency', () => {
    const published = buildPackageJson('community', '9.9.9', pkg);
    expect(published.bundleDependencies).toEqual(Object.keys(pkg.dependencies));
  });

  it('the Pro manifest bundles nothing, since npm never installs it', () => {
    expect(buildPackageJson('pro', '9.9.9', pkg)).not.toHaveProperty('bundleDependencies');
  });

  it('pins each runtime dependency to an exact version', () => {
    for (const [name, spec] of Object.entries(pkg.dependencies)) {
      expect(spec, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lock.packages[`node_modules/${name}`].version, name).toBe(spec);
    }
  });

  it('the production tree in the lockfile can be redistributed as NOTICES.md describes', () => {
    // The root install holds the same production entries the build bundles, so
    // a dependency bump that brings in an uncleared license fails here, at PR
    // time, instead of at the release build.
    const packages: BundledPackage[] = Object.entries(
      lock.packages as Record<string, { dev?: boolean }>
    )
      .filter(([path, entry]) => path !== '' && entry.dev !== true)
      .map(([path]) => {
        const dir = join(ROOT, path);
        expect(existsSync(join(dir, 'package.json')), `${path} is not installed`).toBe(true);
        const installed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        return {
          name: installed.name,
          license: installed.license,
          hasLicenseFile: readdirSync(dir).some((f) => /^(licen[cs]e|copying)/i.test(f)),
        };
      });
    expect(packages.length).toBeGreaterThan(0);
    expect(checkBundledLicenses(packages, notices)).toEqual([]);
  });
});

describe('checkBundledLicenses', () => {
  it('passes a permissive package that ships its license file', () => {
    expect(checkBundledLicenses([clean()], '')).toEqual([]);
  });

  it('refuses a license outside the cleared set', () => {
    expect(checkBundledLicenses([clean({ license: 'GPL-3.0' })], '')).toEqual([
      'a: license "GPL-3.0" is not cleared for bundling',
    ]);
  });

  it('refuses a license field that is not a plain SPDX id', () => {
    expect(checkBundledLicenses([clean({ license: { type: 'MIT' } })], '')).toHaveLength(1);
    expect(checkBundledLicenses([clean({ license: undefined })], '')).toHaveLength(1);
  });

  it('needs a NOTICES.md heading for a package with no license file', () => {
    const bare = clean({ name: '@x/b.c', hasLicenseFile: false });
    expect(checkBundledLicenses([bare], '')).toHaveLength(1);
    // A passing mention is not a reproduction of the terms.
    expect(checkBundledLicenses([bare], 'uses `@x/b.c` at runtime')).toHaveLength(1);
    expect(checkBundledLicenses([bare], '### `@x/b.c`\n\nMIT terms')).toEqual([]);
    // The dot is literal, not a regex wildcard.
    expect(checkBundledLicenses([bare], '### `@x/bxc`')).toHaveLength(1);
  });
});
