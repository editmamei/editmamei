import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TOOL_TIERS } from '@editmamei/core/tool-tiers.js';

// docs/pro-features.md is the canonical Community/Pro split. It used to be
// wiki-tier-drift-guard.test.ts, checked against a sibling editmamei-ce wiki
// checkout, and skipped in CI whenever that checkout was missing. The
// 2026-08-07 split archived the wiki and migrated its docs in-repo, so the
// doc this guard checks now lives right here — it runs unconditionally,
// everywhere. Two rules, preserved from the wiki-era guard:
//   1. Every ps_* identifier the doc mentions must be a real, shipped
//      community/pro tool (dev/none-tier and unknown names must not appear).
//   2. A tool listed under a tier-labeled section must match its tier table
//      entry — "## Community: what's included free" and "## What Pro adds to
//      Editmamei" are the canonical split.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = join(ROOT, 'docs', 'pro-features.md');

const PS_NAME = /\bps_[a-z0-9_]+\b/g;

describe('pro-features drift guard', () => {
  it('every ps_* identifier in pro-features.md is a shipped community/pro tool', () => {
    const offenders: string[] = [];
    const source = readFileSync(DOC, 'utf8');
    const names = source.match(PS_NAME) ?? [];
    // Anti-vacuous-pass guard: a doc restructure that strips the ps_* names
    // (or a stale DOC path) must fail here, not silently disarm the check.
    expect(new Set(names).size).toBeGreaterThanOrEqual(10);
    for (const name of names) {
      const tier = TOOL_TIERS[name];
      if (tier !== 'community' && tier !== 'pro') {
        offenders.push(`${name} (tier: ${tier ?? 'UNKNOWN'})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lists each tool under the section matching its tier', () => {
    const source = readFileSync(DOC, 'utf8');
    const offenders: string[] = [];
    const seen = { community: 0, pro: 0 };
    let expected: 'community' | 'pro' | null = null;
    for (const line of source.split('\n')) {
      if (/^## Community\b/.test(line)) expected = 'community';
      else if (/^## What Pro adds\b/.test(line)) expected = 'pro';
      else if (/^## /.test(line)) expected = null;
      if (!expected) continue;
      for (const name of line.match(PS_NAME) ?? []) {
        seen[expected] += 1;
        if (TOOL_TIERS[name] !== expected) {
          offenders.push(`${name} listed under the ${expected} section but is ${TOOL_TIERS[name]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Anti-vacuous-pass guard: renaming either canonical heading would leave
    // `expected` forever null and this test checking nothing. Each section
    // must have been entered and contributed at least one tool.
    expect(seen.community).toBeGreaterThan(0);
    expect(seen.pro).toBeGreaterThan(0);
  });
});
