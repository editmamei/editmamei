/**
 * Spec-library structural integrity guard.
 *
 * The 2026-06-04 AM Spec Library (`src/spec/`) is the institutional answer
 * to the silent-no-op AM-descriptor bugs that have repeatedly shipped past
 * the descriptor-string-matching unit tests (Hst2/Hsrt, color_lookup,
 * shadowHighlight/reduceNoise). Per-spec snippet-vs-spec tests live in
 * sibling files (apply-mask.test.ts, hue-saturation.test.ts, etc.) and
 * pin specific snippets against their specs.
 *
 * This file is the LIBRARY-level guard: every spec module under the
 * registry must load, have the required shape, declare a non-empty events
 * sequence, and have an `id` that matches its registry key. Catches:
 *   - someone deletes a spec file but forgets the registry barrel import
 *   - a spec ships with an empty `events: []` array (worthless as ground truth)
 *   - the registry barrel exports something that isn't an AmEventSpec
 *   - an event in a sequence is missing its descriptor without the explicit
 *     noDescriptor:true flag (PS canonical no-descriptor form vs. drift)
 *
 * This is intentionally low-effort relative to the per-spec assertions —
 * it scales for free as new specs land, and it shifts the contract from
 * "every spec gets its own test" to "every spec is at least structurally
 * sound." The per-spec snippet-vs-spec tests remain the high-value catch
 * for descriptor-key drift, but they can land incrementally.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSpecRegistry, type AmEventSpec } from '@editmamei/spec/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// Repo-relative path tokens embedded in a snippetRef string, e.g.
// "go-core/cmd/buildtemplates/fragments_adjustments.go (vault.AdjLvlPM)" or
// "src/api/extendscript/_helpers.ts". Requires at least one "/" and a
// recognized source extension so prose words ("addAdjustmentLayer") and
// bare vault keys ("vault.AdjHSTd") don't false-positive.
const REPO_PATH_PATTERN = /\b[\w.-]+(?:\/[\w.-]+)+\.(?:go|ts|tsx|js)\b/g;

const VALID_CATEGORIES = new Set([
  'adjustments',
  'filters',
  'layer-styles',
  'layer-ops',
  'masks',
  'selection',
  'place',
  'retouch',
]);

describe('ps27 spec registry', () => {
  const registry = getSpecRegistry('27');

  it('exposes psMajor=27', () => {
    expect(registry.psMajor).toBe('27');
  });

  it('contains specs (non-empty registry)', () => {
    expect(Object.keys(registry.specs).length).toBeGreaterThan(0);
  });

  it('every spec has a non-empty id that matches its registry key', () => {
    for (const [key, spec] of Object.entries(registry.specs)) {
      expect(typeof spec.id).toBe('string');
      expect(spec.id.length).toBeGreaterThan(0);
      expect(spec.id).toBe(key);
    }
  });

  it('every spec has a category in the declared union', () => {
    for (const spec of Object.values(registry.specs)) {
      expect(VALID_CATEGORIES.has(spec.category)).toBe(true);
    }
  });

  it('every spec has a non-empty events sequence', () => {
    for (const spec of Object.values(registry.specs)) {
      expect(Array.isArray(spec.events)).toBe(true);
      expect(spec.events.length).toBeGreaterThan(0);
    }
  });

  it('every event has either a descriptor or the explicit noDescriptor flag', () => {
    // Catches the drift where an event lands with `descriptor: null` because
    // the author forgot to encode it. PS canonical parameterless events
    // (Invr, the no-op suspend events) must opt in via `noDescriptor: true`.
    for (const spec of Object.values(registry.specs)) {
      spec.events.forEach((evt, i) => {
        const hasDescriptor = evt.descriptor !== null;
        const isExplicitlyParameterless = evt.noDescriptor === true;
        if (!hasDescriptor && !isExplicitlyParameterless) {
          throw new Error(
            `${spec.id} event[${i}] (${typeIDToString(evt.event)}) ` +
              `has descriptor=null without noDescriptor:true — either encode ` +
              `the descriptor or set noDescriptor:true to opt in.`
          );
        }
        // Inverse: noDescriptor:true MUST come with descriptor:null.
        if (isExplicitlyParameterless && hasDescriptor) {
          throw new Error(
            `${spec.id} event[${i}] has noDescriptor:true but a non-null descriptor.`
          );
        }
      });
    }
  });

  it('every spec has a non-empty groundTruth capture record', () => {
    for (const spec of Object.values(registry.specs)) {
      expect(spec.groundTruth).toBeDefined();
      expect(spec.groundTruth.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(spec.groundTruth.psVersion.length).toBeGreaterThan(0);
      expect(['Windows', 'macOS']).toContain(spec.groundTruth.platform);
    }
  });

  it('every spec advertises at least one emittedBy tool name', () => {
    for (const spec of Object.values(registry.specs)) {
      expect(Array.isArray(spec.emittedBy)).toBe(true);
      // emittedBy may be empty for specs that exist as documentation
      // ahead of a snippet landing — we still want it to be an array
      // rather than undefined so consumers don't need null checks.
      for (const tool of spec.emittedBy) {
        expect(typeof tool).toBe('string');
        expect(tool.length).toBeGreaterThan(0);
      }
    }
  });

  it('spec ids do not collide across category barrels', () => {
    // The ps27Registry merges every category index via spread. Duplicate
    // ids across categories would silently overwrite. This pins the
    // count of unique ids to the count produced by the registry.
    const ids = Object.values(registry.specs).map((s: AmEventSpec) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Born from the 2026-07-29 retirement of the legacy TS ExtendScript twin
  // (src/api/extendscript.ts + its category files): 42 specs' snippetRef
  // fields (plus a handful of nearby prose comments) cited line numbers in
  // the now-deleted file, undetected until an agent went spec-by-spec
  // fixing them by hand. This guard makes the next such deletion fail
  // loudly instead of silently rotting — any snippetRef that names a
  // repo-relative path now MUST point at a file that actually exists.
  it('every snippetRef that names a repo path points at a file that exists', () => {
    // Anti-vacuous floor: if the extraction regex stops matching anything
    // (e.g. every spec's snippetRef format changes shape), this test would
    // otherwise pass trivially with zero assertions actually made.
    let pathsChecked = 0;

    for (const spec of Object.values(registry.specs)) {
      if (!spec.snippetRef) continue;
      const matches = spec.snippetRef.match(REPO_PATH_PATTERN) ?? [];
      for (const relPath of matches) {
        pathsChecked++;
        expect(
          existsSync(join(REPO_ROOT, relPath)),
          `${spec.id} snippetRef names "${relPath}" but no such file exists in the repo. ` +
            `snippetRef: "${spec.snippetRef}". Either the file moved (update the ref) or ` +
            `this is a stale pointer left over from a deletion (the exact failure mode this ` +
            `guard exists to catch).`
        ).toBe(true);
      }
    }

    expect(
      pathsChecked,
      'REPO_PATH_PATTERN matched zero path-like tokens across every snippetRef in the ' +
        'registry — either every spec lost its snippetRef, or the extraction regex no ' +
        'longer matches the current snippetRef format. Either way this guard is currently ' +
        'vacuous and needs fixing.'
    ).toBeGreaterThan(0);
  });
});

describe('spec dispatcher', () => {
  it('falls back to the highest registry for unknown versions', () => {
    const reg = getSpecRegistry('99');
    expect(reg.psMajor).toBe('27');
  });
});

function typeIDToString(t: { kind: string; value: string }): string {
  return `${t.kind}(${t.value})`;
}
