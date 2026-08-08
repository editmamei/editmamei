/**
 * Pins src/version.ts and server.json against package.json so a release bump
 * that updates one without the others fails the test suite before the MCP
 * server boots with a stale identifier. The 2026-06-07 audit caught the
 * src/version.ts drift in the field — server reported '0.2.0' while
 * package.json read '0.5.0'. A 2026-08-08 audit flagged server.json as the
 * same risk, unpinned: it carries the version twice (top-level and the npm
 * package entry) and nearly went stale at the 1.0.1 cut.
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

describe('server.json', () => {
  it('every version field matches package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const server = JSON.parse(readFileSync(join(REPO_ROOT, 'server.json'), 'utf8'));
    expect(server.version).toBe(pkg.version);
    // Iterate rather than index: a future second package entry (e.g. the
    // .mcpb) must be pinned the moment it appears, not silently skipped.
    expect(server.packages.length).toBeGreaterThanOrEqual(1);
    for (const entry of server.packages) {
      expect(entry.version).toBe(pkg.version);
    }
  });
});

describe('package-lock.json', () => {
  it('both lockfile version fields match package.json version', () => {
    // A desync here fails `npm ci` inside the release workflow — it has
    // happened at a real RC cut. Cheap to pin, expensive to rediscover.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });
});
