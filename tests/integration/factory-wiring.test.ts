/**
 * Factory-wiring guard (derived-list invariant).
 *
 * build-output.test.ts and readme-leak-guard.test.ts both glob
 * `src/tools/*.ts`, but only to cross-check things that are ALREADY
 * registered somewhere (prune paths, tier leaks). Neither one — nor the
 * `tool-tiers.test.ts` orphan check, which only iterates `TOOL_TIERS`
 * keys — would catch a `create*Tools` factory that's authored in
 * `src/tools/` but never imported into `ceFactories` (src/modules/ce/index.ts)
 * or the Pro `defs` array (src/modules/pro/index.ts). Such a factory ships
 * invisibly: the server boot assertion only iterates tools that already
 * got registered, so an entirely-unwired factory trips no alarm anywhere.
 *
 * This test derives the factory-export set straight from `src/tools/*.ts`
 * source (the same glob-and-parse style as build-output.test.ts) and
 * asserts every one is referenced by one of the two module index files.
 * A new tool file whose factory is never imported into either module
 * fails this test the moment it's added — closing the last gap in the
 * derived-list invariant for the tool-factory surface.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const TOOLS_DIR = join(REPO_ROOT, 'src', 'tools');
const CE_INDEX = join(REPO_ROOT, 'src', 'modules', 'ce', 'index.ts');
const PRO_INDEX = join(REPO_ROOT, 'src', 'modules', 'pro', 'index.ts');

// Source of truth: every `src/tools/*.ts` file, derived from disk (not a hand
// list) so a new tool file is picked up automatically.
const TOOL_SRC_FILES = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));
if (TOOL_SRC_FILES.length === 0) {
  // Mirror the zero-yield guard build-output.test.ts uses for its *-pro.ts
  // derivation — an empty glob would turn every assertion below vacuous.
  throw new Error(
    'factory-wiring.test.ts derived zero src/tools/*.ts files — the derivation glob is broken'
  );
}

/**
 * Every exported tool-factory function, keyed by its declaring file.
 *
 * `metadata-tools.ts` is a real, deliberate exception: `get_metadata` was
 * folded into `ps_inspect(what='metadata')` (Phase 1b, 2026-06-26) and the
 * file no longer exports a `create*Tools` factory at all — it exports the
 * handler + schema that `inspect-tools.ts` dispatches to directly. It simply
 * produces no match below, so it needs no special-casing here.
 */
const factories: Array<{ name: string; file: string }> = [];
for (const file of TOOL_SRC_FILES) {
  const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
  // Matches the observed convention across every module in src/tools/:
  // `export function createXxxTools(...)` / `export function createXxxToolsPro(...)`.
  const matches = src.matchAll(/export function (create\w*Tools\w*)\s*\(/g);
  for (const m of matches) {
    factories.push({ name: m[1], file });
  }
}

const ceIndexSrc = readFileSync(CE_INDEX, 'utf8');
// Pro's module index isn't part of every checkout of this repo (Pro ships as
// a separate module) — when it's absent there are no Pro-only factories to
// find wiring for anyway, so treat it as contributing no wired names rather
// than failing to read a file that doesn't exist here.
const proIndexSrc = existsSync(PRO_INDEX) ? readFileSync(PRO_INDEX, 'utf8') : '';

/**
 * A factory is "wired" if its exact identifier appears as a whole word
 * (import + array/call reference) in either module index file. Word-boundary
 * matching (not plain `.includes`) avoids a false negative/positive between
 * near-identical names — e.g. `createWarpTools` is a substring-adjacent
 * neighbor of `createWarpToTools` / `createWarpToolsPro`-shaped names.
 */
function isWired(factoryName: string): boolean {
  const re = new RegExp(`\\b${factoryName}\\b`);
  return re.test(ceIndexSrc) || re.test(proIndexSrc);
}

describe('every src/tools/*.ts factory export is wired into a module factory list', () => {
  // Anti-silent-pass floor — if the regex or the glob breaks, factories.length
  // would collapse toward 0 and every assertion below would pass vacuously.
  // 44 real factories exist today; 20 is a conservative floor well below that.
  it('finds a healthy number of tool factories (sanity check the derivation)', () => {
    expect(factories.length).toBeGreaterThan(20);
  });

  it('no factory is authored but never imported into ce/index.ts or pro/index.ts', () => {
    const orphans = factories.filter((f) => !isWired(f.name));
    expect(
      orphans,
      orphans
        .map(
          (o) =>
            `\`${o.name}\` in src/tools/${o.file} is wired into no module factory list ` +
            `(neither src/modules/ce/index.ts nor src/modules/pro/index.ts references it) — ` +
            `it ships invisibly: no boot assertion and no tool-tiers orphan check catches this.`
        )
        .join('\n')
    ).toEqual([]);
  });
});
