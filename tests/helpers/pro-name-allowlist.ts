/**
 * Where a Pro tool name may legitimately appear as a string literal in CE-shipped code, and
 * the matching helpers both Pro-name scans use, so they can never disagree:
 *   - `tests/integration/build-output.test.ts` scans the built CE bundle (`packages/ce/dist`),
 *     which exists only where both editions have been built.
 *   - `tests/integration/pro-name-source-scan.test.ts` scans CE source (`src/`) and runs in
 *     every checkout, so a leak fails CI instead of surfacing at the release cut.
 *
 * Paths are dist-relative `.js` paths (`core/tool-tiers.js`); the source scan maps `.ts` to
 * `.js` before asking.
 *
 * Exemptions, scoped as tightly as each file allows: the inventory files name every Pro
 * tool by construction, so they are exempt wholesale, and everything else is exempt for the
 * NAMED tools it references and nothing more — an unrelated Pro name turning up in one of
 * them is still a leak and still fails.
 *
 *  - `core/tool-tiers.js` — the TOOL_TIERS classification dictionary has every name
 *    (community + pro + dev + none) as a key. That's how tier classification works at runtime.
 *  - `core/tool-groups.js` — the capability-group table, keyed by every tool the same way.
 *  - `core/tool-activity.js` — the telemetry activity classification (read-only / kept-work /
 *    mutating) plus the few tool names the host tracks by behaviour. Same whole-inventory
 *    shape as the two above; it exists so no other CE file needs a Pro name of its own. Its
 *    exports are pinned (`tests/core/tool-activity.test.ts`) so the exemption can't become a
 *    place to park arbitrary names.
 *  - `spec/**` — the AmEventSpec library cross-references each Pro tool by name in the
 *    `emittedBy: [...]` metadata field so the descriptor-vs-snippet tests can map specs back to
 *    their consumers. Specs are static data shipped to both editions (they're audit /
 *    documentation infrastructure), and dropping them from CE would weaken the runtime spec
 *    lookup. The reference is harmless — it doesn't register a tool or carry an implementation.
 *  - `tools/scene-tools.js` — the CE Scene tools (ps_read_scene / select_by_reference)
 *    reference the Pro tool names `ps_select_subject_instance` and `ps_select_face_feature` as
 *    host.invokeTool DELEGATION targets: the CE Scene flow routes through those tools when they
 *    are registered, else it uses a CE fallback. Those are name strings for runtime
 *    delegation, not implementation — the implementations stay in the pruned `*-pro.js` files.
 *  - `perception/grounding-locate.js` + `tools/{brush,image,layer-transform,selection,shape}-
 *    tools.js` — these carry `'ps_resolve_placement'` in their `placement`-param DESCRIPTIONS:
 *    a delegation/vocabulary REFERENCE, not an implementation. The locator TOOL is Pro (its
 *    factory lives in the pruned grounding-tools-pro.js), but the grounding ENGINE stays
 *    CE-host-shipped so the community tools keep their placement params.
 */

import { CE_PRUNE_DIRS } from '../../scripts/lib/build-common.ts';

/** Whole-file: these enumerate the tool inventory by construction. */
const ENUMERATES_EVERY_PRO_NAME = new Set([
  'core/tool-tiers.js',
  'core/tool-groups.js',
  'core/tool-activity.js',
]);

/** Per-name: file → the exact Pro names it may reference, and no others. */
const ALLOWED_PRO_NAMES: Record<string, string[]> = {
  'tools/scene-tools.js': ['ps_select_subject_instance', 'ps_select_face_feature'],
  'perception/grounding-locate.js': ['ps_resolve_placement'],
  'tools/brush-tools.js': ['ps_resolve_placement'],
  'tools/image-tools.js': ['ps_resolve_placement'],
  'tools/layer-transform-tools.js': ['ps_resolve_placement'],
  'tools/selection-tools.js': ['ps_resolve_placement'],
  'tools/shape-tools.js': ['ps_resolve_placement'],
};

/** Whether `tool` may appear as a string literal in the CE file at dist-relative path `rel`. */
export function isProNameAllowed(rel: string, tool: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  if (ENUMERATES_EVERY_PRO_NAME.has(norm) || norm.startsWith('spec/')) return true;
  return ALLOWED_PRO_NAMES[norm]?.includes(tool) ?? false;
}

/**
 * Whether a source path (relative to `src/`, `.ts`) is removed from the CE build: under one of
 * `CE_PRUNE_DIRS`, or a `tools/*-pro.ts` file — the source side of `pruneProFromCE`, which
 * removes every `dist/tools/*-pro.js`.
 */
export function isPrunedFromCE(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  if (CE_PRUNE_DIRS.some((dir) => norm === dir || norm.startsWith(`${dir}/`))) return true;
  return (
    norm.startsWith('tools/') &&
    !norm.slice('tools/'.length).includes('/') &&
    norm.endsWith('-pro.ts')
  );
}

/**
 * The names in `names` that appear in `contents` as a single- or double-quoted string literal.
 *
 * Backticks are deliberately NOT matched: doc comments name tools as Markdown code spans
 * (`ps_x`), and telling those apart from template literals needs a parser. A name built in a
 * template literal or by concatenation therefore escapes both scans; review catches those.
 */
export function proNameLiteralsIn(contents: string, names: readonly string[]): string[] {
  return names.filter((name) => contents.includes(`'${name}'`) || contents.includes(`"${name}"`));
}

/**
 * The names in `names` that appear anywhere in a line of CODE (comment lines skipped, and a
 * trailing ` // ...` comment cut off), as a whole identifier. This catches what the exact-
 * literal check above cannot: a name inside a longer string (`'consider ps_x first'`), a
 * template literal, or a concatenation. Comments are skipped because the build strips them.
 */
export function proNamesInCodeLines(contents: string, names: readonly string[]): string[] {
  const code = contents
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .map((line) => line.replace(/\s\/\/\s.*$/, ''))
    .join('\n');
  return names.filter((name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(code));
}
