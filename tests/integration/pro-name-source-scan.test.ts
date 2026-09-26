/**
 * Source-level twin of the CE-dist Pro-name scan in build-output.test.ts.
 *
 * That test inspects the built CE bundle, which only exists where both editions are built,
 * so public CI never runs it: a Pro tool name added to a CE-shipped file would pass here and
 * fail at the release cut. This scan reads CE source instead, so the same rule fails in
 * every checkout. Both use the helpers in tests/helpers/pro-name-allowlist.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { toolsInTier } from '@editmamei/core/tool-tiers.ts';
import {
  isProNameAllowed,
  isPrunedFromCE,
  proNameLiteralsIn,
  proNamesInCodeLines,
} from '../helpers/pro-name-allowlist.ts';

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

/** Every CE-shipped source file, relative to src/. */
function ceShippedSources(): string[] {
  return walk(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !isPrunedFromCE(f));
}

it('there are Pro tool names to scan for', () => {
  expect(PRO_TOOL_NAMES.length).toBeGreaterThan(0);
});

describe('Pro-name scan helpers', () => {
  const pro = PRO_TOOL_NAMES[0] ?? 'ps_placeholder_tool';

  it('finds a quoted Pro name, but not a longer name or a doc-comment code span', () => {
    expect(proNameLiteralsIn(`x === '${pro}'`, [pro])).toEqual([pro]);
    expect(proNameLiteralsIn(`x === "${pro}"`, [pro])).toEqual([pro]);
    expect(proNameLiteralsIn(`x === '${pro}_v2'`, [pro])).toEqual([]);
    expect(proNameLiteralsIn(`// mentions ${pro} in prose only`, [pro])).toEqual([]);
    expect(proNameLiteralsIn('/** see `' + pro + '` */', [pro])).toEqual([]);
  });

  it('the code-line check finds a name inside a longer string, a template, or a call', () => {
    expect(proNamesInCodeLines(`const s = 'consider ${pro} first';`, [pro])).toEqual([pro]);
    expect(proNamesInCodeLines('const s = `use ' + pro + ' now`;', [pro])).toEqual([pro]);
    expect(proNamesInCodeLines(`f(${pro});`, [pro])).toEqual([pro]);
  });

  it('the code-line check skips comments and longer identifiers', () => {
    expect(proNamesInCodeLines(`// ${pro} is described here`, [pro])).toEqual([]);
    expect(proNamesInCodeLines(` * see ${pro}`, [pro])).toEqual([]);
    expect(proNamesInCodeLines(`/* ${pro} */`, [pro])).toEqual([]);
    expect(proNamesInCodeLines(`call(); // ${pro} trailing note`, [pro])).toEqual([]);
    expect(proNamesInCodeLines(`const s = '${pro}_v2';`, [pro])).toEqual([]);
  });

  it('exempts the inventory files wholesale and spec/ metadata', () => {
    for (const f of ['core/tool-tiers.js', 'core/tool-groups.js', 'core/tool-activity.js']) {
      expect(isProNameAllowed(f, pro)).toBe(true);
    }
    expect(isProNameAllowed('spec/events/foo.js', pro)).toBe(true);
  });

  it('exempts per-name files only for their named tools', () => {
    expect(isProNameAllowed('tools/scene-tools.js', 'ps_select_face_feature')).toBe(true);
    expect(isProNameAllowed('tools/scene-tools.js', 'ps_develop_raw')).toBe(false);
    expect(isProNameAllowed('tools/brush-tools.js', 'ps_resolve_placement')).toBe(true);
    expect(isProNameAllowed('tools/brush-tools.js', 'ps_play_action')).toBe(false);
  });

  it('exempts nothing else: a planted Pro name in an ordinary CE file is a leak', () => {
    expect(isProNameAllowed('core/server.js', 'ps_develop_raw')).toBe(false);
    expect(isProNameAllowed('core/server.js', 'ps_apply_camera_raw')).toBe(false);
    expect(isProNameAllowed('telemetry/activity.js', pro)).toBe(false);
    expect(isProNameAllowed('tools/gimp-adjustment-tools.js', pro)).toBe(false);
  });

  it('treats exactly what the CE build prunes as out of scope', () => {
    expect(isPrunedFromCE('modules/pro/index.ts')).toBe(true);
    expect(isPrunedFromCE('templates/lint.ts')).toBe(true);
    expect(isPrunedFromCE('tools/warp-tools-pro.ts')).toBe(true);
    expect(isPrunedFromCE('tools/warp-tools.ts')).toBe(false);
    expect(isPrunedFromCE('tools/nested/x-pro.ts')).toBe(false);
    expect(isPrunedFromCE('core/server.ts')).toBe(false);
    expect(isPrunedFromCE('modules/professional.ts')).toBe(false);
  });
});

describe('Pro tool names in CE source', () => {
  it('the scan reads real files, and finds the names the inventory legitimately holds', () => {
    // Positive control: without it, a broken walk or filter would scan nothing and pass.
    const files = ceShippedSources();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('core/tool-activity.ts');
    const inventory = readFileSync(join(SRC, 'core', 'tool-activity.ts'), 'utf8');
    const found = proNameLiteralsIn(inventory, PRO_TOOL_NAMES);
    expect(found.length).toBeGreaterThan(0);
    expect(proNamesInCodeLines(inventory, PRO_TOOL_NAMES).length).toBeGreaterThan(0);
    expect(found.every((name) => isProNameAllowed('core/tool-activity.js', name))).toBe(true);
  });

  it('no Pro tool name appears anywhere in CE-shipped code outside the allowlist', () => {
    const leaks: string[] = [];
    for (const rel of ceShippedSources()) {
      const distRel = rel.replace(/\.ts$/, '.js');
      const contents = readFileSync(join(SRC, rel), 'utf8');
      const found = new Set([
        ...proNameLiteralsIn(contents, PRO_TOOL_NAMES),
        ...proNamesInCodeLines(contents, PRO_TOOL_NAMES),
      ]);
      for (const name of found) {
        if (!isProNameAllowed(distRel, name)) leaks.push(`  src/${rel}: ${name}`);
      }
    }
    expect(
      leaks,
      'Pro tool names in CE-shipped code (they ship in the CE build; import the name from an ' +
        'inventory file such as core/tool-activity.ts, or add a scoped exemption in ' +
        'tests/helpers/pro-name-allowlist.ts with its reason):\n' +
        leaks.join('\n')
    ).toEqual([]);
  });
});
