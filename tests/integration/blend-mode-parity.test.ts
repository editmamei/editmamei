/**
 * Derived-list invariant (PR-1) for the blend-mode vocabulary.
 *
 * The same 27 blend modes are written down in three places:
 *
 *   1. `LAYER_BLEND_MODES`  — src/utils/blend-modes.ts, the surface enum every
 *      blend-mode-taking tool schema advertises.
 *   2. `layerBlendModeSet`  — go-core/layer_properties.go, the Go-side validator
 *      that guards the raw `BlendMode.<NAME>` interpolation.
 *   3. `__SF_MODES`         — the smart-filter fragment's DOM-name -> Action-
 *      Manager-stringID translation table.
 *
 * (2) and (3) are pinned to each other by
 * go-core/smart_object_test.go:TestSmartFilterBlendModeTableMatchesValidator.
 * This test pins (1) to (2), which closes the triangle.
 *
 * Without this, adding a mode to the TS enum ships a value the Go validator
 * rejects — the tool advertises a mode that always errors — and dropping one
 * from the enum leaves dead validator entries. That gap was real and unguarded
 * before the smart-filter work added the third copy; the invariant says the
 * conversion IS the task, so it lands here rather than as a follow-up.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LAYER_BLEND_MODES } from '@editmamei/utils/blend-modes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const layerPropertiesGo = resolve(here, '../../go-core/layer_properties.go');

/** Parse the `layerBlendModeSet` map literal out of the Go source. */
function goValidatorModes(): string[] {
  const src = readFileSync(layerPropertiesGo, 'utf8');
  const start = src.indexOf('var layerBlendModeSet = map[string]bool{');
  expect(start, 'layerBlendModeSet not found — did it move or get renamed?').toBeGreaterThan(-1);
  const end = src.indexOf('}', start);
  expect(end, 'layerBlendModeSet literal is not terminated').toBeGreaterThan(start);
  const body = src.slice(start, end);
  return [...body.matchAll(/"([A-Z]+)":\s*true/g)].map((m) => m[1]);
}

describe('blend-mode vocabulary parity (TS enum ↔ Go validator)', () => {
  it('every TS surface mode is accepted by the Go validator', () => {
    const go = new Set(goValidatorModes());
    const missing = LAYER_BLEND_MODES.filter((m) => !go.has(m));
    expect(
      missing,
      `these modes are advertised in LAYER_BLEND_MODES but rejected by layerBlendModeSet, so every call using them fails: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('the Go validator has no modes the TS surface cannot reach', () => {
    const ts = new Set<string>(LAYER_BLEND_MODES);
    const orphans = goValidatorModes().filter((m) => !ts.has(m));
    expect(
      orphans,
      `these modes are in layerBlendModeSet but absent from LAYER_BLEND_MODES, so nothing can send them: ${orphans.join(', ')}`
    ).toEqual([]);
  });

  it('parses a non-trivial set (guards against a regex that silently matches nothing)', () => {
    expect(goValidatorModes().length).toBe(LAYER_BLEND_MODES.length);
    expect(goValidatorModes()).toContain('COLORBLEND');
  });
});
