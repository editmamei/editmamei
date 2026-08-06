import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TOOL_TIERS } from '@editmamei/core/tool-tiers.js';

// The editmamei-ce wiki's leak review is manual (its CI guard was removed
// 2026-06-19), and manual review missed the 2026-07-07 pro→community re-tier:
// getting-started.md kept calling ps_select_subject / ps_select_sky "Pro
// tools" and presented Pro-only ps_execute_script as generally available.
// This guard machine-checks the wiki docs against TOOL_TIERS from the side
// that owns the table. Two rules:
//   1. Every ps_* identifier in the wiki must be a real community/pro tool
//      (dev/none names and unknown names must not be documented at all).
//   2. A tool mentioned in an edition-labeled context must match its tier —
//      section-scoped in pro-features.md (the canonical split), and
//      keyword-window elsewhere.
// The wiki is a sibling repo that isn't present in the release-CI checkout,
// so the whole suite skips when it's missing (it always exists on the dev
// machines where pre-push runs).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIKI = join(ROOT, '..', 'editmamei-ce');

const PS_NAME = /\bps_[a-z0-9_]+\b/g;

// ps_-prefixed identifiers that are settings/telemetry keys, not tools —
// legitimately documented in privacy.md.
const NON_TOOL_PS_NAMES = new Set(['ps_version', 'ps_path']);

function wikiFiles(): string[] {
  const files = [join(WIKI, 'README.md')];
  for (const entry of readdirSync(join(WIKI, 'docs'))) {
    if (entry.endsWith('.md')) files.push(join(WIKI, 'docs', entry));
  }
  return files;
}

describe.skipIf(!existsSync(WIKI))('wiki tier drift guard', () => {
  it('every ps_* identifier in the wiki is a shipped community/pro tool', () => {
    const offenders: string[] = [];
    for (const file of wikiFiles()) {
      for (const name of readFileSync(file, 'utf8').match(PS_NAME) ?? []) {
        if (NON_TOOL_PS_NAMES.has(name)) continue;
        const tier = TOOL_TIERS[name];
        if (tier !== 'community' && tier !== 'pro') {
          offenders.push(`${file}: ${name} (tier: ${tier ?? 'UNKNOWN'})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('pro-features.md lists each tool under the section matching its tier', () => {
    const source = readFileSync(join(WIKI, 'docs', 'pro-features.md'), 'utf8');
    const offenders: string[] = [];
    let expected: 'community' | 'pro' | null = null;
    for (const line of source.split('\n')) {
      if (/^## Community\b/.test(line)) expected = 'community';
      else if (/^## What Pro adds\b/.test(line)) expected = 'pro';
      else if (/^## /.test(line)) expected = null;
      if (!expected) continue;
      for (const name of line.match(PS_NAME) ?? []) {
        if (TOOL_TIERS[name] !== expected) {
          offenders.push(`${name} listed under the ${expected} section but is ${TOOL_TIERS[name]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('edition-labeled mentions elsewhere match the tier table', () => {
    const offenders: string[] = [];
    for (const file of wikiFiles()) {
      if (file.endsWith('pro-features.md')) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const names = line.match(PS_NAME);
        if (!names) return;
        const window = [lines[i - 1] ?? '', line, lines[i + 1] ?? ''].join('\n');
        const hasPro = /\bPro\b/.test(window);
        const hasCommunity = /\bCommunity\b/.test(window);
        if (hasPro === hasCommunity) return; // both or neither: no edition claim to check
        const expected = hasPro ? 'pro' : 'community';
        for (const name of names) {
          if (TOOL_TIERS[name] !== expected) {
            offenders.push(
              `${file}:${i + 1}: ${name} described as ${expected} but is ${TOOL_TIERS[name]}`
            );
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
