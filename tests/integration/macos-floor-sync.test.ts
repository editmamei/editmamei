import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The minimum macOS we support is not a policy choice — it is whatever the Go
// toolchain stamps into the cross-compiled darwin binaries as
// LC_BUILD_VERSION.minos. Raising the `go` directive silently raises that floor,
// and the docs do not follow on their own: before this guard existed the shipped
// binary accepted macOS 11 while both docs claimed 12, and nothing noticed.
//
// So this is a sync guard over a derived value: the Go version is the source of
// truth, the documented floor is the mirror, and a bump that moves one without
// the other fails here rather than in a user's dyld error.
//
// The floors below are MEASURED from the produced binaries, not read off release
// notes — cross-compile go-core and check LC_BUILD_VERSION. A Go version with no
// entry is a deliberate failure: measure it and add it. We do not inspect a real
// binary here because that would need a darwin cross-compile, which the unit
// suite does not produce; `npm run build:ce` is where the artifacts exist.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Go minor version -> the macOS major its darwin binaries declare as minos. */
const DARWIN_FLOOR_BY_GO: Record<string, number> = {
  '1.23': 11,
  '1.27': 13,
};

function goDirective(): string {
  const goMod = readFileSync(join(ROOT, 'go-core', 'go.mod'), 'utf8');
  const match = /^go (\d+\.\d+)/m.exec(goMod);
  if (!match) throw new Error('go-core/go.mod has no parseable `go` directive');
  return match[1];
}

/** Every documented statement of the macOS floor, as `macOS <major>+`. */
function documentedFloors(): { file: string; floor: number }[] {
  return ['README.md', join('docs', 'installation.md')].map((file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const match = /macOS (\d+)\+/.exec(text);
    if (!match) throw new Error(`${file} no longer states a "macOS <n>+" requirement`);
    return { file, floor: Number(match[1]) };
  });
}

describe('macOS floor sync', () => {
  it('the go.mod Go version has a measured darwin floor on record', () => {
    const go = goDirective();
    expect(
      DARWIN_FLOOR_BY_GO[go],
      `No measured macOS floor for go ${go}. Cross-compile go-core for darwin, read ` +
        `LC_BUILD_VERSION.minos, and add it to DARWIN_FLOOR_BY_GO.`
    ).toBeDefined();
  });

  it('every doc states the floor the toolchain actually produces', () => {
    const expected = DARWIN_FLOOR_BY_GO[goDirective()];
    for (const { file, floor } of documentedFloors()) {
      expect(floor, `${file} claims macOS ${floor}+ but the binary requires ${expected}+`).toBe(
        expected
      );
    }
  });

  it('the docs agree with each other', () => {
    const floors = documentedFloors();
    const distinct = new Set(floors.map((f) => f.floor));
    expect(
      distinct.size,
      `docs disagree: ${floors.map((f) => `${f.file}=${f.floor}`).join(', ')}`
    ).toBe(1);
  });
});
