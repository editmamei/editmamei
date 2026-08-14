import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { HYDRATE_SCRIPT_MARKER, PRO_SOURCES_MARKER } from '../helpers/overlay-tree.ts';

/**
 * Meta-guard for the overlay detection in tests/helpers/overlay-tree.ts.
 *
 * The docs/-wide guards are the one place that detection is used to turn a
 * check OFF rather than on, so a wrong answer is silent in the direction that
 * matters: a stray `src/modules/pro/index.ts` in this tree — a stub, a type
 * shim, a leftover — would disarm both docs sweeps and let a dev-tier tool name
 * reach the published docs with CI green.
 *
 * Cross-checking a second, independent marker closes that. The two paths are
 * created by different things and always travel together, so a disagreement
 * means the detection has stopped describing reality and must be fixed before
 * anything is allowed to depend on it again. Deliberately ungated: it has to
 * run in both trees, and it fails in either direction.
 */
describe('overlay tree detection', () => {
  it('both overlay markers agree', () => {
    const proSources = existsSync(PRO_SOURCES_MARKER);
    const hydrateScript = existsSync(HYDRATE_SCRIPT_MARKER);
    expect(
      hydrateScript,
      `Overlay markers disagree: src/modules/pro/index.ts is ${proSources ? 'present' : 'absent'} ` +
        `but scripts/hydrate-ce.ts is ${hydrateScript ? 'present' : 'absent'}. ` +
        `Tests gate on the first to decide whether docs/ here is the published ` +
        `user documentation; while the two disagree that gate is guessing, and ` +
        `the docs/-wide leak and tier sweeps may be skipping on a false signal.`
    ).toBe(proSources);
  });
});
