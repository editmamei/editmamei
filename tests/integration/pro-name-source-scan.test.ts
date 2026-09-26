/**
 * Source-level twin of the CE-dist Pro-name scan in build-output.test.ts.
 *
 * That test inspects the built CE bundle, which only exists where both editions are built,
 * so public CI never runs it: a Pro tool name added to a CE-shipped file passes here and
 * fails at the release cut. This scan reads CE source instead, so the same rule fails in
 * every checkout. Both use the one allowlist in tests/helpers/pro-name-allowlist.ts.
 *
 * "CE-shipped" = everything under src/ except what the CE build prunes: CE_PRUNE_DIRS and
 * every tools/*-pro.ts (the source side of pruneProFromCE's `tools/*-pro.js` derivation).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { toolsInTier } from '@editmamei/core/tool-tiers.ts';
import { CE_PRUNE_DIRS } from '../../scripts/lib/build-common.ts';
import { isProNameAllowed } from '../helpers/pro-name-allowlist.ts';

const SRC = resolve(import.meta.dirname, '..', '..', 'src');
const PRO_TOOL_NAMES = toolsInTier('pro');

function walk(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

function isPruned(rel: string): boolean {
  return (
    CE_PRUNE_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`)) ||
    /^tools\/[a-z0-9-]+-pro\.ts$/.test(rel)
  );
}

describe('Pro tool names in CE source', () => {
  it('the scan has something to check', () => {
    expect(PRO_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it('no Pro tool name appears as a string literal in CE-shipped source outside the allowlist', () => {
    const files = walk(SRC).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !isPruned(f)
    );
    const leaks: string[] = [];
    for (const rel of files) {
      const contents = readFileSync(join(SRC, rel), 'utf8');
      const distRel = rel.replace(/\.ts$/, '.js');
      for (const name of PRO_TOOL_NAMES) {
        if (isProNameAllowed(distRel, name)) continue;
        if (contents.includes(`'${name}'`) || contents.includes(`"${name}"`)) {
          leaks.push(`  src/${rel}: ${name}`);
        }
      }
    }
    expect(
      leaks,
      'Pro tool name string literals in CE-shipped source (they ship in the CE build; import ' +
        'the name from an inventory file such as core/tool-activity.ts, or add a scoped ' +
        'exemption in tests/helpers/pro-name-allowlist.ts with its reason):\n' +
        leaks.join('\n')
    ).toEqual([]);
  });
});
