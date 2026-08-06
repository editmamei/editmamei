/**
 * Pins src/version.ts against package.json so a release bump that updates
 * one without the other fails the test suite before the MCP server boots
 * with a stale identifier. The 2026-06-07 audit caught this drift in the
 * field — server reported '0.2.0' while package.json read '0.5.0'.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '@editmamei/version.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('VERSION constant', () => {
  it('matches package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });

  it('is a valid SemVer-shaped string', () => {
    // Pre-v1.0 we use plain `0.X.Y` — anchor the regex to the current shape
    // rather than full SemVer so a typo (extra char, missing dot) fails.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });
});
