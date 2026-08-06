import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const FRAGMENTS_DIR = join(REPO_ROOT, 'go-core', 'cmd', 'buildtemplates');
// The community fragment corpus was split from one 8k-line fragments.go into
// per-family fragments_<family>.go files (S2, 2026-07-28), all using the
// `vault.X: \`...\`` map-literal form this scan segments by. Scan every such
// file so a literal is never missed just because it moved. The edition files
// (fragments_pro/sensei/nonpro.go) are EXCLUDED — this guard has always scoped
// to the community base, and those files use the `fragments[vault.X] = ...`
// assignment form (no scannable marker) anyway; expanding coverage to them is a
// separate decision, not a side effect of the decomposition.
const EDITION_FILES = new Set(['fragments_pro.go', 'fragments_sensei.go', 'fragments_nonpro.go']);
const FRAGMENT_FILES = readdirSync(FRAGMENTS_DIR).filter(
  (f) => /^fragments.*\.go$/.test(f) && !EDITION_FILES.has(f)
);

/**
 * Fix 6 (Phase 2, 2026-07) — the systemic hardcoded-success-literal pattern,
 * converted into tracked debt.
 *
 * Root cause of the ps_set_layer bug this phase fixed: a fragment writes a
 * property, then returns a hardcoded `updated: true` (or similar) literal
 * instead of checking a post-condition. Auditing fragments.go turned up
 * ~53 more of the same shape across other fragments (creates, deletes,
 * selections, moves, applies, file I/O) — none of them checked either.
 * Fixing all of them is out of scope for one phase; this guard makes the
 * remainder an explicit, reviewable burn-down list instead of an invisible
 * debt. Any NEW hardcoded literal (or a literal moved to a new fragment)
 * fails the build until it's either fixed for real or added here with a
 * reason. Any allowlist entry that no longer matches reality (fixed and
 * not pruned, or a fragment renamed) also fails — the list must track the
 * source exactly, in both directions.
 *
 * Scan approach: every `vault.<Key>:` in fragments.go marks the start of
 * one fragment's raw JSX string in the `fragments` map literal (verified:
 * every `vault.\w+` occurrence in this file is immediately followed by
 * `:` — i.e. is a map key, never a value reference inside a fragment
 * body — so segmenting the file by marker byte-offset reliably attributes
 * a literal to its owning fragment without needing a full JS/comment-aware
 * lexer).
 */

const LITERAL_PATTERN = /(applied|created|selected|deleted|success|moved|updated):\s*true/g;
const KEY_MARKER_PATTERN = /vault\.(\w+):/g;

interface ScannedLiteral {
  key: string;
  literal: string;
}

type AllowedLiteral = ScannedLiteral & { reason: string };

function scanFragments(src: string): ScannedLiteral[] {
  const markers: { key: string; offset: number }[] = [];
  for (const m of src.matchAll(KEY_MARKER_PATTERN)) {
    markers.push({ key: m[1], offset: m.index ?? 0 });
  }
  markers.sort((a, b) => a.offset - b.offset);

  function keyAt(offset: number): string {
    let owner = '(before first fragment)';
    for (const m of markers) {
      if (m.offset > offset) break;
      owner = m.key;
    }
    return owner;
  }

  const found: ScannedLiteral[] = [];
  for (const m of src.matchAll(LITERAL_PATTERN)) {
    found.push({ key: keyAt(m.index ?? 0), literal: m[0] });
  }
  return found;
}

function sortKey(l: ScannedLiteral): string {
  return `${l.key}::${l.literal}`;
}

function toCountMap(items: ScannedLiteral[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = sortKey(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function literalsFor(reason: string, entries: Array<[string, string]>): AllowedLiteral[] {
  return entries.map(([key, literal]) => ({ key, literal, reason }));
}

// Seeded 2026-07 (Phase 2) with the current set MINUS the six fragments
// fixed this phase (SetFillOp/SetOpacity/SetBlend's hardcoded
// `updated: true` — all three replaced by a real `verified` post-condition
// check; SetVis/SetLock/Rename never hardcoded a literal here at all).
// Whoever picks up the next entry: add a genuine post-condition check
// (independent re-resolve + compare, same shape as Fix 1-3) and DELETE the
// row below — don't just silence the test.
const ALLOWED: AllowedLiteral[] = [
  ...literalsFor(
    'Filter bake (auto-duplicate-first pixel ops) — no post-apply pixel/descriptor check.',
    [
      ['GBlur', 'applied: true'],
      ['USharp', 'applied: true'],
      ['ANoise', 'applied: true'],
      ['MBlur', 'applied: true'],
      ['LensBlur', 'applied: true'],
      ['SmartShrp', 'applied: true'],
      ['RedNoise', 'applied: true'],
      ['Displace', 'applied: true'],
      ['HighPass', 'applied: true'],
      ['RadialBlur', 'applied: true'],
      ['Pixelate', 'applied: true'],
      ['Distort', 'applied: true'],
      ['FilterMulti', 'applied: true'],
      ['OilPaint', 'applied: true'],
    ]
  ),
  ...literalsFor('Apply (layer style / channel compose) — no post-apply descriptor check.', [
    ['AddLayerStyle', 'applied: true'],
    ['AddLayerStyle2', 'applied: true'],
    ['ApplyImage', 'applied: true'],
  ]),
  ...literalsFor('Creation — no post-create existence check.', [
    ['CreateText', 'created: true'],
    ['CreateGroup', 'created: true'],
    ['NewLayer', 'created: true'],
    ['AddFillLayer', 'created: true'],
    ['AdjLOuter', 'created: true'], // named branch
    ['AdjLOuter', 'created: true'], // unnamed/default branch
    ['PathCreate', 'created: true'],
    ['PathFromPts', 'created: true'],
    // The scan matches on the bare word boundary-free substring, so
    // `shape_created: true` / `guide_layout_created: true` are captured as
    // just `created: true` (the regex has no word-boundary anchor — see
    // `deselected: true` below for the same effect on `selected`).
    ['CreateShape', 'created: true'],
    ['GuideLayout', 'created: true'],
  ]),
  ...literalsFor('Selection — no post-select selection-state check.', [
    ['SelectLayer', 'selected: true'],
    ['ColorRange', 'selected: true'],
    ['SelClrPre', 'selected: true'],
    ['SelPolygon', 'selected: true'],
    ['LumRange', 'selected: true'],
    ['MagicWand', 'selected: true'],
    ['SelEllipse', 'selected: true'],
    ['GrowSel', 'selected: true'],
    // `deselected: true` is captured as `selected: true` (no word-boundary
    // anchor on the literal-pattern regex — intentional, so a rename to
    // e.g. `reselected: true` doesn't slip past unnoticed either).
    ['Deselect', 'selected: true'],
  ]),
  ...literalsFor('Delete — no post-delete existence check.', [
    ['DeleteGroup', 'deleted: true'],
    ['DelLayerNamed', 'deleted: true'],
    ['DelLayerActive', 'deleted: true'],
    ['ChanDel', 'deleted: true'],
    ['PathDelete', 'deleted: true'],
    // `vector_mask_deleted: true` is captured as `deleted: true` (same
    // no-word-boundary effect).
    ['VMDel', 'deleted: true'],
  ]),
  ...literalsFor('File I/O — no post-write file-exists/size check.', [
    ['OpenDoc', 'success: true'],
    ['SavePsd', 'success: true'],
    ['ExportJpg', 'success: true'],
    ['ExportPng', 'success: true'],
  ]),
  // ProbeOpenDoc is the ONE justified case in this list, not a deferral.
  // Its `success: true` is unreachable unless __mcpFound is non-null — i.e.
  // the document was actually located in app.documents by normalized full
  // path — and it returns `success: false` otherwise. Confirming the file is
  // open IS the post-condition; there is nothing further to verify. Do not
  // "fix" this row by adding a re-resolve; it already is one.
  ...literalsFor('Re-probe — the literal IS the post-condition check.', [
    ['ProbeOpenDoc', 'success: true'],
  ]),
  ...literalsFor('Move — no post-move position check.', [
    ['MoveToGroup', 'moved: true'],
    ['MoveToPos', 'moved: true'], // named-target branch
    ['MoveToPos', 'moved: true'], // active-layer branch
    ['LtMove', 'moved: true'],
  ]),
];

describe('fragments.go hardcoded success-literal guard (Fix 6, Phase 2)', () => {
  const found = FRAGMENT_FILES.flatMap((f) =>
    scanFragments(readFileSync(join(FRAGMENTS_DIR, f), 'utf8'))
  );

  it('finds hardcoded literals to scan (sanity check the scan itself works)', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it('every hardcoded success literal in fragments.go is accounted for by the allowlist (no new, no stale)', () => {
    const foundMap = toCountMap(found);
    const allowedMap = toCountMap(ALLOWED);

    const unexpected: string[] = [];
    for (const [k, count] of foundMap) {
      const allowedCount = allowedMap.get(k) ?? 0;
      if (count > allowedCount) {
        unexpected.push(`${k} (found ${count}, allowlisted ${allowedCount})`);
      }
    }
    expect(
      unexpected,
      `New hardcoded success literal(s) in fragments.go not covered by the Fix 6 allowlist:\n  ${unexpected.join('\n  ')}\n` +
        `Either add a genuine post-condition check (independent re-resolve + compare — see ` +
        `setLayerVisibility's Fix 1-3 pattern), or add a reasoned entry to ALLOWED above.`
    ).toEqual([]);

    const stale: string[] = [];
    for (const [k, count] of allowedMap) {
      const foundCount = foundMap.get(k) ?? 0;
      if (foundCount < count) {
        stale.push(`${k} (allowlisted ${count}, found ${foundCount})`);
      }
    }
    expect(
      stale,
      `Allowlist entries no longer present in fragments.go:\n  ${stale.join('\n  ')}\n` +
        `This list is a burn-down — prune the entry once the literal is fixed (or the ` +
        `fragment renamed/removed) instead of leaving a stale row behind.`
    ).toEqual([]);
  });

  it('the three property setters fixed in Phase 2 no longer hardcode `updated: true`', () => {
    for (const key of ['SetFillOp', 'SetOpacity', 'SetBlend']) {
      expect(
        found.some((f) => f.key === key && f.literal === 'updated: true'),
        `${key} must not hardcode updated: true after Phase 2 — verified should replace it`
      ).toBe(false);
    }
  });
});
