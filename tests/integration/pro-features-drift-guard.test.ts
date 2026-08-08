import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TOOL_TIERS } from '@editmamei/core/tool-tiers.js';

// docs/ is user-facing and edition-labeled, so it gets the same drift guard the
// wiki used to have. This used to be wiki-tier-drift-guard.test.ts, checked
// against a sibling editmamei-ce wiki checkout, and skipped in CI whenever that
// checkout was missing. The 2026-08-07 split archived the wiki and migrated its
// docs in-repo, so the docs this guard checks now live right here — it runs
// unconditionally, everywhere. Rules, preserved from the wiki-era guard:
//   1. Every ps_* identifier in ANY doc must be a real, shipped community/pro
//      tool (dev/none-tier and unknown names must not appear) — the original
//      incident this guard exists for was in getting-started.md, not the
//      pro-features table.
//   2. In pro-features.md, a tool listed under a tier-labeled section must
//      match its tier table entry — "## Community: ..." and "## What Pro
//      adds ..." are the canonical split.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS_DIR = join(ROOT, 'docs');
const PRO_FEATURES = join(DOCS_DIR, 'pro-features.md');

const PS_NAME = /\bps_[a-z0-9_]+\b/g;

// ps_*-shaped identifiers that are legitimately not tools: settings keys the
// privacy doc documents. Anything added here needs the same justification.
const NON_TOOL_PS_NAMES = new Set(['ps_version', 'ps_path']);

function docFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...docFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

describe('docs tier drift guard', () => {
  it('every ps_* identifier across docs/ is a shipped community/pro tool', () => {
    const files = docFiles(DOCS_DIR);
    // Anti-vacuous-pass guard: the docs tree exists and mentions tools. A
    // restructure that empties either must fail here, not disarm the check.
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    let totalNames = 0;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const name of source.match(PS_NAME) ?? []) {
        if (NON_TOOL_PS_NAMES.has(name)) continue;
        totalNames += 1;
        const tier = TOOL_TIERS[name];
        if (tier !== 'community' && tier !== 'pro') {
          offenders.push(`${file}: ${name} (tier: ${tier ?? 'UNKNOWN'})`);
        }
      }
    }
    expect(totalNames).toBeGreaterThanOrEqual(25);
    expect(offenders).toEqual([]);
  });

  it('pro-features.md lists each tool under the section matching its tier', () => {
    const source = readFileSync(PRO_FEATURES, 'utf8');
    const offenders: string[] = [];
    const seen = { community: 0, pro: 0 };
    let expected: 'community' | 'pro' | null = null;
    for (const line of source.split('\n')) {
      if (/^## Community\b/.test(line)) expected = 'community';
      else if (/^## What Pro adds\b/.test(line)) expected = 'pro';
      else if (/^## /.test(line)) expected = null;
      if (!expected) continue;
      for (const name of line.match(PS_NAME) ?? []) {
        if (NON_TOOL_PS_NAMES.has(name)) continue;
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
