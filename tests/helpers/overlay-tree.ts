import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * This source is also compiled inside a larger tree that overlays it with the
 * Pro module. A handful of tests need to know which of the two they are running
 * in — the docs/-wide guards most of all, because only this repo's `docs/` is
 * the published user documentation.
 *
 * Two independent paths mark the overlay, and neither can exist here:
 *   - `src/modules/pro/index.ts`, the Pro module's entrypoint;
 *   - `scripts/hydrate-ce.ts`, the script that copies this source into it.
 *
 * `HYDRATED_OVERLAY` reads the first. The second exists so a meta-guard can
 * cross-check it: see tests/integration/overlay-detection-guard.test.ts.
 */
export const PRO_SOURCES_MARKER = join(REPO_ROOT, 'src', 'modules', 'pro', 'index.ts');
export const HYDRATE_SCRIPT_MARKER = join(REPO_ROOT, 'scripts', 'hydrate-ce.ts');

export const HYDRATED_OVERLAY = existsSync(PRO_SOURCES_MARKER);
