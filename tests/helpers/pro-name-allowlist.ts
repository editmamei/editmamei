/**
 * Where a Pro tool name may legitimately appear as a string literal in CE-shipped code.
 *
 * Shared by the two Pro-name scans so they can never disagree:
 *   - `tests/integration/build-output.test.ts` scans the built CE bundle (`packages/ce/dist`),
 *     which exists only where both editions are built (the private tree, at release).
 *   - `tests/integration/pro-name-source-scan.test.ts` scans CE source (`src/`) and runs in
 *     every checkout, so a leak fails public CI instead of surfacing at the release cut.
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
 *    mutating) and the raw-develop tool name the host tracks. Same whole-inventory shape as
 *    the two above; it exists so no other CE file needs a Pro name of its own.
 *  - `spec/**` — the AmEventSpec library cross-references each Pro tool by name in the
 *    `emittedBy: [...]` metadata field so the descriptor-vs-snippet tests can map specs back to
 *    their consumers. Specs are static data shipped to both editions (they're audit /
 *    documentation infrastructure), and dropping them from CE would weaken the runtime spec
 *    lookup. The reference is harmless — it doesn't register a tool or carry an implementation.
 *  - `tools/scene-tools.js` — the CE Scene tools (ps_read_scene / select_by_reference)
 *    reference the Pro tool names `ps_select_subject_instance` and `ps_select_face_feature` as
 *    host.invokeTool DELEGATION targets: when the host is Pro-entitled the CE Scene flow routes
 *    through those Pro tools, else it uses a CE fallback (the CE-loads-Pro-module broker
 *    pattern, scene-model-v2). Those are name strings for runtime delegation, NOT Pro
 *    implementation — the Pro source stays in the pruned `*-pro.js` files.
 *  - `core/server.js` — the raw-develop advisory tracker names `ps_apply_camera_raw` twice: a
 *    `this.toolRegistry.get(...)` existence check (is a camera-raw develop tool registered in
 *    this session?) and a `name === ...` check on the tool that just ran. Both read the live
 *    registry to decide whether to set or clear the pending flag — runtime delegation /
 *    entitlement checks, not Pro implementation.
 *  - `perception/grounding-locate.js` + `tools/{brush,image,layer-transform,selection,shape}-
 *    tools.js` — these carry `'ps_resolve_placement'` in their `placement`-param DESCRIPTIONS:
 *    a delegation/vocabulary REFERENCE, not an implementation. The locator TOOL is Pro (its
 *    factory lives in the pruned grounding-tools-pro.js), but the grounding ENGINE stays
 *    CE-host-shipped so the community tools keep their placement params.
 */

/** Whole-file: these enumerate the tool inventory by construction. */
const ENUMERATES_EVERY_PRO_NAME = new Set([
  'core/tool-tiers.js',
  'core/tool-groups.js',
  'core/tool-activity.js',
]);

/** Per-name: file → the exact Pro names it may reference, and no others. */
const ALLOWED_PRO_NAMES: Record<string, string[]> = {
  'tools/scene-tools.js': ['ps_select_subject_instance', 'ps_select_face_feature'],
  'core/server.js': ['ps_apply_camera_raw'],
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
