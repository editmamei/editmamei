import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['src', 'tests', 'scripts'].map((d) => join(REPO_ROOT, d));

/**
 * Regression guard for the FocalFlux → Editmamei rebrand. If any stray
 * brand string sneaks back in (re-imported file, vendored snippet, etc.)
 * this catches it before it ships.
 *
 * Scope is intentionally narrow: src/, tests/, scripts/. The root markdown
 * files are covered by other checks.
 */
const SELF = fileURLToPath(import.meta.url);

function findOffenders(dir: string, hits: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'packages') continue;
      findOffenders(path, hits);
    } else if (/\.(ts|tsx|js|jsx|json|md)$/.test(entry)) {
      // Skip this file — it contains the brand strings as part of the
      // detection regex itself, so it would always flag itself otherwise.
      if (path === SELF) continue;
      const text = readFileSync(path, 'utf8');
      if (/FocalFlux|focalflux/.test(text)) {
        hits.push(path);
      }
    }
  }
}

describe('no stale FocalFlux/focalflux references in source', () => {
  it('source tree contains no FocalFlux or focalflux strings', () => {
    const hits: string[] = [];
    for (const root of SCAN_ROOTS) {
      findOffenders(root, hits);
    }
    expect(hits, `Stale brand string found in:\n${hits.map((h) => `  - ${h}`).join('\n')}`).toEqual(
      []
    );
  });
});
