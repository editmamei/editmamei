/**
 * Small, pure helpers for the telemetry client's wire fields: mapping the connected MCP
 * client's self-reported name to a fixed enum, coercing a semver-ish version string to its
 * leading major, bounding a parsed major to a wire-safe range, and reading the boot-time
 * platform facts (Node major, CPU arch, OS major). Also the shared tool-activity
 * classification used for `edits_ok` / `kept_work` in the session summary.
 *
 * Content-free by construction: every value here is an enum token or a small integer, never
 * a free-text string.
 *
 * The telemetry aggregation service applies the SAME classification for its own rollups — the
 * two must change together whenever either changes. All three lists below must also be
 * reconciled against `src/core/tool-tiers.ts` whenever the tool roster changes: a tool added
 * there and forgotten here silently falls through to the DEFAULT classification, not a
 * neutral one. An edit is a successful call to a tool that changes the open document's state
 * (pixels, layers, selection, guides); everything else is not an edit. READ_ONLY_TOOLS /
 * KEPT_WORK_TOOLS / MUTATING_TOOLS together must be EXHAUSTIVE, because any tool absent from
 * all three counts as an edit (`edits_ok`) the moment it succeeds, whether or not it actually
 * reads-only. `activity.test.ts` enforces the exhaustiveness against the live tool-tiers
 * roster, so an unclassified new tool fails the suite until it's assigned to one of the three.
 */

/**
 * Tools whose successful call reads state without changing the document — used to decide
 * `edits_ok` (a successful call outside this set). See the module doc comment above for the
 * server-sync + exhaustiveness discipline this list is held to.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Orchestration wrappers. NOT reads — but neutral for edits_ok, which counts
  // any successful call OUTSIDE this set. Their steps dispatch through
  // host.invokeTool into registry.execute, whose `finally` fires onCall for
  // nested dispatches too, so every inner step is already counted on its own.
  // Counting the wrapper as well added one phantom edit per call, inflating by
  // an amount that scaled with step count rather than a constant offset.
  // The telemetry aggregation service mirrors this list and must carry the same
  // two entries, or the session summary and the server-side rollups disagree.
  'ps_sequence',
  'ps_batch',
  'ps_ping',
  'ps_overview',
  'ps_list_capabilities',
  'ps_get_preview',
  'ps_get_selection_preview',
  'ps_get_histogram',
  'ps_inspect',
  'ps_read_scene',
  'ps_compare_regions',
  'ps_get_layer_bounds_diff',
  'ps_template_list',
  'ps_template_recall',
  'ps_list_actions',
  'ps_report_problem',
  'ps_detect',
  'ps_detect_landmarks',
  // ps_document — only op=list/activate reach telemetry as this tool name; neither
  // touches pixels (list reads state, activate just switches the active document).
  'ps_document',
  'ps_template_verify',
  'ps_resolve_placement',
  // The template trio: each writes a template FILE to disk (save / delete / evidence
  // capture) but never touches the open document's pixels, layers, selection, or guides.
  'ps_template_save',
  'ps_template_delete',
  'ps_template_create_evidence',
]);

/**
 * Tools whose successful call writes the result to disk outside the open document — used to
 * decide `kept_work` (a successful call in this set). Mirrored on the server; keep in sync
 * the same way as READ_ONLY_TOOLS above.
 */
export const KEPT_WORK_TOOLS: ReadonlySet<string> = new Set(['ps_export', 'ps_save_psd']);

/**
 * Every other registered tool — a successful call to one of these is an edit (`edits_ok`).
 * Explicit rather than left implicit so the exhaustiveness test can catch a newly-added tool
 * that was never classified at all: without this list, an unclassified tool would silently
 * fall through to the (correct, fail-open) edit default with no test ever failing.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  // action / batch / scripting. KNOWN BIAS, same shape as ps_develop_raw below: both of
  // these run caller-supplied work, so a script or action that only reads still counts as
  // an edit. Name-shaped classification cannot see inside them.
  'ps_play_action',
  'ps_execute_script',

  // adjustment
  'ps_add_adjustment_layer',
  'ps_apply_adjustment',

  // document lifecycle (ps_document's list/activate ops are read-only — see READ_ONLY_TOOLS)
  'ps_create_document',
  'ps_close_document',
  'ps_open_document',
  // Develops a raw FILE and then opens it — document lifecycle, same as the
  // line above. KNOWN BIAS: classification is per tool NAME, but this tool's
  // mode='read' only inspects a sidecar and develops nothing, so a read-probe
  // counts as an edit. The server's pending-develop flag already discriminates
  // on `opened === true`; this set cannot, being name-shaped.
  'ps_develop_raw',

  // filter / group / clipping. ps_filter also has a read-only `list` op — SAME KNOWN BIAS
  // as ps_play_action/ps_execute_script above: classification is per tool NAME, so a
  // list-only call still counts as an edit.
  'ps_filter',
  'ps_group',
  'ps_clipping_mask',

  // history. These move the document, so they are edits by this set's test, but they
  // move it BACKWARD as often as forward — an undo-heavy session inflates edits_ok
  // without producing more finished work. kept_work is the counter to trust there.
  'ps_undo',
  'ps_redo',

  // placement / image
  'ps_place_image',
  'ps_resize_image',
  'ps_crop_document',
  'ps_convert_image_mode',

  // layer ordering / properties / lifecycle
  'ps_move_layer_to_position',
  'ps_convert_to_smart_object',
  'ps_rasterize_layer',
  'ps_set_layer',
  'ps_duplicate_layer',
  'ps_copy_to_new_layer',
  'ps_merge',
  'ps_bake_layer',
  'ps_add_layer_style',
  'ps_create_layer',
  'ps_delete_layer',
  'ps_fill_layer',
  'ps_add_fill_layer',
  'ps_select_layer', // a selection tool — see the ps_select* group below
  'ps_transform_layer',

  // warp / canvas / guides
  'ps_warp_layer',
  'ps_warp_layer_mesh',
  'ps_warp_layer_along',
  'ps_warp_layer_region',
  'ps_warp_layer_to',
  'ps_apply_camera_raw',
  'ps_transform_canvas',
  'ps_guides',

  // retouch / brush / detection-driven edits
  'ps_retouch',
  'ps_apply_brush_stroke',
  'ps_edit_object',
  'ps_portrait_touchup',
  'ps_add_text_to_object',
  'ps_select_face_feature',
  'ps_stroke_face_contour',

  // selection tools — every ps_select* variant, plus modify/save-load-channel and layer
  // masks, changes the document's selection state even when nothing else about the
  // pixels/layers moves.
  'ps_select_by_reference',
  'ps_select',
  'ps_select_subject',
  'ps_select_sky',
  'ps_select_subject_instance',
  'ps_select_object',
  'ps_replace_sky',
  'ps_modify_selection',
  'ps_selection_channel',
  'ps_layer_mask',

  // path / vector mask / channel compose / shape. ps_path also has a read-only `list` op —
  // same KNOWN BIAS as ps_filter above.
  'ps_path',
  'ps_vector_mask',
  'ps_apply_image',
  'ps_calculations',
  'ps_shape',

  // ps_template_apply — the one template-* tool that actually touches the open document
  'ps_template_apply',

  // text
  'ps_text',
]);

/**
 * Map the MCP client's self-reported `name` (from the `initialize` handshake) to a fixed
 * enum. Lowercase substring rules, first match wins — order matters: `claude-code` must be
 * checked before the bare `claude` fallback, or Claude Code would misclassify as Desktop.
 * Calibrated against the `mcp_client` names these clients actually report: Claude Desktop
 * sends `"claude-ai"` (caught by the generic `claude` rule) and Claude Code sends
 * `"claude-code"` (caught by the specific rule first).
 */
export function mapClientName(
  name: string | undefined
): 'claude_desktop' | 'claude_code' | 'cursor' | 'windsurf' | 'vscode' | 'other' {
  if (name === undefined) return 'other';
  const n = name.toLowerCase();
  if (n.includes('claude-code') || n.includes('claude_code') || n.includes('claudecode')) {
    return 'claude_code';
  }
  if (n.includes('claude')) return 'claude_desktop';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('windsurf')) return 'windsurf';
  if (n.includes('vscode') || n.includes('visual studio') || n.includes('code-oss')) {
    return 'vscode';
  }
  return 'other';
}

/** The leading integer of a semver-ish string ("2.1.170" -> 2), or null when unparseable. */
export function parseMajor(version: string | undefined): number | null {
  if (version === undefined) return null;
  const m = /^(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Clamp a parsed major version to a plausible, wire-safe range, discarding anything outside
 * it. The server's field specs (NODE_MAJOR/OS_MAJOR: 0..999; CLIENT_MAJOR: 0..9999) reject an
 * out-of-range int outright and 400 the whole batch — a garbled or hostile input must never
 * reach the wire as a huge or negative integer that could take a batch down with it. Returns
 * null when `n` is null or falls outside `[0, max]`.
 */
export function boundMajor(n: number | null, max: number): number | null {
  return n !== null && Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

/** The running Node.js major version, from `process.versions.node`, or `null` when unparseable. */
export function nodeMajor(): number | null {
  return parseMajor(process.versions.node);
}

/** `process.arch`, narrowed to the three buckets telemetry cares about. */
export function archToken(): 'x64' | 'arm64' | 'other' {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  return 'other';
}

/**
 * Coerce a platform + `os.release()` string to a human OS major version. `platform` and
 * `release` are passed in (rather than read from `node:os` directly) so tests can inject
 * both without depending on the test host's real OS.
 *
 *   - win32: `os.release()` is `<major>.<minor>.<build>` (e.g. "10.0.22631"). Windows 11
 *     reports the SAME major.minor as Windows 10 and is distinguished only by build number
 *     — build >= 22000 means 11, otherwise the leading major (10) stands.
 *   - darwin: `os.release()` is the Darwin kernel version. Through Darwin 24 (macOS 13-15)
 *     the marketing major is the Darwin major minus 9 (24 -> 15, 23 -> 14, 22 -> 13); Apple
 *     broke that mapping at Darwin 25 (macOS 26 "Tahoe"), so from there it's Darwin major
 *     plus 1 instead (25 -> 26).
 *   - other: the leading integer of `release` (e.g. a Linux kernel version).
 *
 * Returns null when `release` doesn't parse.
 */
export function osMajor(platform: string, release: string): number | null {
  if (platform === 'win32') {
    const parts = release.split('.');
    const major = Number(parts[0]);
    if (!Number.isFinite(major)) return null;
    const build = Number(parts[2]);
    return Number.isFinite(build) && build >= 22000 ? 11 : major;
  }
  if (platform === 'darwin') {
    const m = /^(\d+)/.exec(release);
    if (!m) return null;
    const darwinMajor = Number(m[1]);
    return darwinMajor <= 24 ? darwinMajor - 9 : darwinMajor + 1;
  }
  const m = /^(\d+)/.exec(release);
  return m ? Number(m[1]) : null;
}
