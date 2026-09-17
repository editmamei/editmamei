import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isArchived } from '../helpers/archived-docs.ts';

// The minimum macOS we support is not a policy choice — it is whatever the Go
// toolchain stamps into the cross-compiled darwin binaries as
// LC_BUILD_VERSION.minos. Raising the toolchain silently raises that floor, and
// the docs do not follow on their own: before this guard existed the shipped
// binary accepted macOS 11 while both docs claimed 12, and nothing noticed.
//
// So this is a sync guard over a derived value. The relation is deliberately
// `documented >= produced`, not equality: claiming a HIGHER floor than the
// binary needs is a valid choice (Photoshop's own requirement, or declining to
// support an OS we cannot test on), while claiming a LOWER one is the dangerous
// direction — it tells users an install will work when the binary will not even
// load.
//
// The floors below are MEASURED from the produced binaries, not read off release
// notes: cross-compile go-core for darwin and read LC_BUILD_VERSION.minos. Both
// darwin targets (arm64 and amd64) were checked and agree, so one entry per Go
// version is enough. A Go version with no entry fails deliberately — measure it
// and add it. We do not inspect a binary here because that needs a darwin
// cross-compile the unit suite does not produce; `npm run build:ce` is where
// those artifacts exist.
//
// Granularity is the Go MINOR version. CI resolves the newest patch of that
// minor (there is deliberately no `toolchain` directive pinning it), so this
// assumes patch releases never move the floor — true so far, and the kind of
// thing to re-measure if it ever changes.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Go minor version -> the macOS major its darwin binaries declare as minos. */
const DARWIN_FLOOR_BY_GO: Record<string, number> = {
  '1.23': 11,
  '1.27': 13,
};

/**
 * README.md is repo-owned rather than hydrated: the Pro tree keeps its own copy,
 * which legitimately differs from this one. Asserting against it there would fail
 * on a file this repo does not control, so the README check runs only in the CE
 * tree. `registry_pro.go` is the same Pro-tree marker `buildGoCoreDev` uses.
 */
const IS_PRO_TREE = existsSync(join(ROOT, 'go-core', 'registry_pro.go'));

/** The Go version the build will actually use: `toolchain` wins over `go`. */
function goVersion(): string {
  const goMod = readFileSync(join(ROOT, 'go-core', 'go.mod'), 'utf8');
  const toolchain = /^toolchain go(\d+\.\d+)/m.exec(goMod);
  if (toolchain) return toolchain[1];
  const directive = /^go (\d+\.\d+)/m.exec(goMod);
  if (!directive) throw new Error('go-core/go.mod has no parseable `go` directive');
  return directive[1];
}

/** Every markdown file that could state a floor: the docs tree, plus the README. */
function docFiles(): string[] {
  const files = readdirSync(join(ROOT, 'docs'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !isArchived(f))
    .map((f) => join(ROOT, 'docs', f));
  if (!IS_PRO_TREE) files.push(join(ROOT, 'README.md'));
  return files;
}

/** EVERY `macOS <major>+` claim across those files, not just the first per file. */
function documentedFloors(): { file: string; floor: number }[] {
  const found: { file: string; floor: number }[] = [];
  for (const path of docFiles()) {
    for (const match of readFileSync(path, 'utf8').matchAll(/macOS (\d+)\+/g)) {
      found.push({ file: relative(ROOT, path), floor: Number(match[1]) });
    }
  }
  return found;
}

describe('macOS floor sync', () => {
  it('the Go version in use has a measured darwin floor on record', () => {
    const go = goVersion();
    expect(
      DARWIN_FLOOR_BY_GO[go],
      `No measured macOS floor for go ${go}. Cross-compile go-core for darwin, read ` +
        `LC_BUILD_VERSION.minos, and add it to DARWIN_FLOOR_BY_GO.`
    ).toBeDefined();
  });

  it('the docs state a floor at least as high as the binary requires', () => {
    const produced = DARWIN_FLOOR_BY_GO[goVersion()];
    const claims = documentedFloors();
    expect(claims.length, 'no doc states a "macOS <n>+" requirement any more').toBeGreaterThan(0);
    for (const { file, floor } of claims) {
      expect(
        floor,
        `${file} claims macOS ${floor}+, but binaries built with go ${goVersion()} ` +
          `require ${produced}+. Users on ${floor} would be told an install works ` +
          `that cannot load.`
      ).toBeGreaterThanOrEqual(produced);
    }
  });

  it('the docs agree with each other', () => {
    const claims = documentedFloors();
    const distinct = new Set(claims.map((c) => c.floor));
    expect(
      distinct.size,
      `docs disagree: ${claims.map((c) => `${c.file}=${c.floor}`).join(', ')}`
    ).toBe(1);
  });
});
