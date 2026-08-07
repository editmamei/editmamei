/**
 * Layer/group-name lookup tolerance guard.
 *
 * Regression pin for the 2026-07-29 strict-vs-tolerant layer-name-lookup
 * fix. `findLayerByName` / `findGroupByName` exist as hand-maintained
 * copies across go-core/cmd/buildtemplates/fragments_*.go and
 * src/tools/preview-tools.ts. The canonical (tolerant) shape compares
 * `normName(l.name) === <normalized target>` — dash/whitespace/case
 * tolerant, so an LLM that sends a hyphen-minus where the layer was
 * actually created with an em-dash or en-dash (Bug I, see the 2026-05-30
 * PS 27.x cross-platform bug roster) still resolves. A STRICT copy
 * (`l.name === name`, raw equality) silently 404s on that exact input
 * while every tolerant sibling tool resolves it fine — the same layer name
 * works in ps_select_layer but 404s in ps_move_layer_to_position.
 *
 * A 2026-07-28 repo review flagged one known strict survivor
 * (moveLayerToPosition); auditing every fragments_*.go file for the same
 * shape turned up three more (deleteGroup / setGroupBlendMode / ungroup in
 * fragments_groups.go) plus two inline TS copies in preview-tools.ts (the
 * annotated-preview `layer:` annotation resolver, get_layer_bounds_diff) —
 * six total, all converted to the tolerant shape.
 *
 * This guard fails the build if the strict shape ever comes back, in
 * either source tree. Scoped to the EXACT `l.name === name` comparison —
 * the consistent loop-variable/parameter naming (`l`, `name`) every
 * layer/group name-lookup loop in this codebase uses — so it can't
 * false-positive on unrelated `.name ===` comparisons elsewhere: font
 * lookups in fragments_text.go (`app.fonts[k].name === requested`),
 * path-item lookups in fragments_paths.go (`doc.pathItems[__dj].name ===
 * __dname`), channel lookups in fragments_selections_advanced.go
 * (`ch.name === chName`) all use different variable names and are not
 * layer/group lookups.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const FRAGMENTS_DIR = join(REPO_ROOT, 'go-core', 'cmd', 'buildtemplates');
const FRAGMENT_FILES = readdirSync(FRAGMENTS_DIR).filter((f) => /^fragments.*\.go$/.test(f));

const PREVIEW_TOOLS_FILE = join(REPO_ROOT, 'src', 'tools', 'preview-tools.ts');

// The forbidden shape: a raw `l.name === name` comparison inside a
// layer/group name-lookup loop. Whitespace-tolerant (also catches a
// reformatted variant of the same strict comparison).
const STRICT_LOOKUP_PATTERN = /\bl\.name\s*===\s*name\b/;

describe('layer/group name-lookup tolerance guard (regression pin, 2026-07-29)', () => {
  it('finds fragment files to scan (sanity check the scan itself works)', () => {
    expect(FRAGMENT_FILES.length).toBeGreaterThan(0);
  });

  it('no fragments_*.go source contains a strict (non-normName) layer/group-name comparison', () => {
    const violations: Array<{ file: string; line: number }> = [];
    for (const file of FRAGMENT_FILES) {
      const contents = readFileSync(join(FRAGMENTS_DIR, file), 'utf8');
      contents.split(/\r?\n/).forEach((lineText, idx) => {
        if (STRICT_LOOKUP_PATTERN.test(lineText)) {
          violations.push({ file, line: idx + 1 });
        }
      });
    }
    expect(
      violations,
      `Strict (non-dash-tolerant) layer/group-name lookup found:\n` +
        violations.map((v) => `  ${v.file}:${v.line}`).join('\n') +
        `\nUse normName(l.name) === <normalized target> instead (see fragments_layers.go's ` +
        `deleteLayer / fragments_layer_properties.go's selectLayer for the canonical tolerant ` +
        `shape) — see Bug I in the 2026-05-30 PS 27.x cross-platform bug roster.`
    ).toEqual([]);
  });

  it('preview-tools.ts does not contain a strict (non-normName) layer-name comparison', () => {
    const contents = readFileSync(PREVIEW_TOOLS_FILE, 'utf8');
    expect(contents).not.toContain('l.name === name');
    expect(contents).not.toMatch(STRICT_LOOKUP_PATTERN);
    // Both inline findLayerByName copies (the annotated-preview `layer:`
    // resolver, get_layer_bounds_diff) must go through normName.
    expect(contents).toContain('normName(l.name) === wantedNorm');
    expect(contents).toContain('normName(l.name) === targetNorm');
    // ...and each copy must bring the helper into scope: calling normName
    // without interpolating normNameHelper throws "normName is not a
    // function" at runtime in Photoshop while every string-level test stays
    // green (the retired helperFunctions-guard failure class).
    const interpolations = contents.match(/\$\{normNameHelper\}/g) ?? [];
    expect(interpolations.length).toBeGreaterThanOrEqual(2);
  });

  // The go-core side of the same failure class: golden.json pins the emitted
  // JSX for representative params, so any golden entry that CALLS normName(
  // must also CONTAIN the helper's definition. An emitter that forgets to
  // slot normNameHelper() re-goldens cleanly (goldens are a drift gate, not
  // a correctness gate) and ships "normName is not a function" to live PS —
  // this assertion is what turns that into a build failure.
  it('every golden entry calling normName( also embeds the normName helper definition', () => {
    const goldenPath = join(REPO_ROOT, 'go-core', 'testdata', 'golden.json');
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, unknown>;
    const entries = Object.entries(golden).filter(
      (e): e is [string, string] => typeof e[1] === 'string'
    );
    expect(entries.length).toBeGreaterThan(0); // anti-vacuous floor

    const callers = entries.filter(([, body]) => /\bnormName\s*\(/.test(body));
    // The tolerant-lookup fix put normName into at least the moveLayerToPosition
    // and group-tool goldens — if this floor trips, the goldens were regenerated
    // without the tolerant lookup at all.
    expect(callers.length).toBeGreaterThanOrEqual(4);

    const missingHelper = callers
      .filter(([, body]) => !body.includes('function normName'))
      .map(([key]) => key);
    expect(
      missingHelper,
      `Golden entries call normName( without embedding the helper definition ` +
        `(the emitter forgot to interpolate normNameHelper()): ${missingHelper.join(', ')}`
    ).toEqual([]);
  });
});
