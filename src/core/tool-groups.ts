/**
 * Single source of truth for which capability GROUP each registered tool
 * belongs to. Groups are the companion axis to `tool-tiers.ts`:
 *
 *  - `tool-tiers.ts`  → which EDITION a tool ships in (community/pro/dev/none).
 *  - `tool-groups.ts` → how the flat tool surface is ORGANIZED.
 *
 * A group is NOT a tier. A single group can contain tools of different tiers
 * (e.g. `select_ai` mixes tiers: select_subject/select_sky are community,
 * select_subject_instance/select_object are pro — grouped together because
 * they're all AI-backed selection, gated separately for the Pro-module
 * boundary).
 *
 * **What consumes this.** `ps_list_capabilities` surfaces the taxonomy
 * live (each group's purpose + the tools registered in it) as a compact
 * "what exists" map, complementing `ps_overview` ("how to work") and
 * `tools/list` (full schemas). (An earlier capability-gating mechanism that
 * hid tools from `tools/list` was removed 2026-06-26 — both target clients
 * defer schemas via native tool-search, so server-side gating was redundant.)
 *
 * **The classification is explicit.** Every registered tool MUST appear here.
 * `groupOf()` throws for unknown names and `EditmameiServer` runs that check
 * at startup (alongside the tier check) so a newly-added tool that was never
 * grouped fails fast at boot rather than silently landing ungrouped. The
 * drift guard `tests/integration/tool-groups.test.ts` pins both directions:
 * every registered tool is grouped, and every grouped name is a real tool.
 *
 * The altitude rule for whether a new operation is a NEW tool or a new
 * discriminator on an existing one lives in `docs/engineering/tool-design.md`
 * § "Tool consolidation — the altitude rule".
 */

export type ToolGroup =
  | 'core'
  | 'inspect'
  | 'verify'
  | 'document'
  | 'select'
  | 'select_ai'
  | 'adjust'
  | 'filter'
  | 'retouch'
  | 'layers'
  | 'masks'
  | 'type'
  | 'perception'
  | 'face'
  | 'templates'
  | 'automation';

export interface GroupInfo {
  /** Stable id (matches the `ToolGroup` literal). */
  id: ToolGroup;
  /** Short human label for `ps_list_capabilities` / UI grouping. */
  label: string;
  /** One line: what this group is for. Shown by `ps_list_capabilities`. */
  purpose: string;
}

/**
 * The group catalog — the organizing taxonomy for the tool surface, surfaced
 * live by `ps_list_capabilities` (group purpose + the tools in each).
 */
export const GROUPS: Record<ToolGroup, GroupInfo> = {
  core: {
    id: 'core',
    label: 'Core',
    purpose: 'Session liveness, orientation, undo/redo, and problem reporting — always available.',
  },
  inspect: {
    id: 'inspect',
    label: 'Inspect',
    purpose: 'Read document/layer/selection/history/smart-object state and render previews.',
  },
  verify: {
    id: 'verify',
    label: 'Verify',
    purpose:
      'Measurement primitives — histogram, region compare, bounds diff, selection preview — to check work instead of eyeballing.',
  },
  document: {
    id: 'document',
    label: 'Document & canvas',
    purpose:
      'Open/create/save/export documents; resize/crop/convert/rotate the canvas; place images; guides.',
  },
  select: {
    id: 'select',
    label: 'Selection',
    purpose: 'Manual selections, selection edits, and alpha-channel save/load/duplicate/delete.',
  },
  select_ai: {
    id: 'select_ai',
    label: 'AI selection',
    purpose:
      'Sensei/CV-backed selection: select_subject and select_sky (community), plus subject-instance selection and named-object selection (Pro).',
  },
  adjust: {
    id: 'adjust',
    label: 'Adjustments',
    purpose:
      'Non-destructive adjustment layers + the destructive tonal bakes with no layer equivalent.',
  },
  filter: {
    id: 'filter',
    label: 'Filters',
    purpose:
      'Blur/sharpen/noise/stylize filters (auto-duplicate-first by default) and the Camera Raw develop surface, plus managing the re-editable Smart Filter stack on a Smart Object.',
  },
  retouch: {
    id: 'retouch',
    label: 'Retouch',
    purpose: 'Content-aware fill, patch, and move.',
  },
  layers: {
    id: 'layers',
    label: 'Layers',
    purpose: 'Layer lifecycle, properties, transforms, ordering, groups, and styles.',
  },
  masks: {
    id: 'masks',
    label: 'Masks & paths',
    purpose:
      'Layer masks, clipping masks, vector masks, work paths, and channel compositing (apply image / calculations).',
  },
  type: {
    id: 'type',
    label: 'Type',
    purpose: 'Create and style text layers.',
  },
  perception: {
    id: 'perception',
    label: 'Perception',
    purpose:
      'On-device CV that gives the model real coordinates/selections — detection, scene read, and detection-driven edits.',
  },
  face: {
    id: 'face',
    label: 'Face mesh',
    purpose:
      'Face-landmark perception and mesh-aimed feature selection / contour strokes. Pro in shipped builds.',
  },
  templates: {
    id: 'templates',
    label: 'Templates (Pro)',
    purpose: 'Save, recall, apply, and verify reproducible aesthetic recipes (Pro).',
  },
  automation: {
    id: 'automation',
    label: 'Automation (Pro)',
    purpose: 'Batch files, play recorded Actions, and the ExtendScript escape hatch (Pro).',
  },
};

/**
 * Tool name → group. Every name MUST also appear in `TOOL_TIERS`; the boot
 * assertion + the drift-guard test enforce both directions. Keep this grouped
 * by group id (mirrors the order of `GROUPS`) for scan-ability.
 */
export const TOOL_GROUPS: Record<string, ToolGroup> = {
  // core
  ps_ping: 'core',
  ps_overview: 'core',
  ps_undo: 'core',
  ps_redo: 'core',
  // live "what exists" map over this taxonomy (read-only)
  ps_list_capabilities: 'core',
  // anonymized diagnostic-bundle writer for bug reports (meta tool)
  ps_report_problem: 'core',

  // inspect (read-only state + previews — never gates)
  ps_inspect: 'inspect',
  ps_get_preview: 'inspect',

  // verify (measurement primitives — never gates; the steering surface)
  ps_get_histogram: 'verify',
  ps_compare_regions: 'verify',
  ps_get_layer_bounds_diff: 'verify',
  ps_get_selection_preview: 'verify',

  // document & canvas
  ps_create_document: 'document',
  ps_open_document: 'document',
  ps_close_document: 'document',
  ps_save_psd: 'document',
  ps_export: 'document',
  ps_place_image: 'document',
  ps_resize_image: 'document',
  ps_crop_document: 'document',
  ps_convert_image_mode: 'document',
  ps_transform_canvas: 'document',
  ps_guides: 'document',

  // selection (manual)
  ps_select: 'select',
  ps_modify_selection: 'select',
  ps_selection_channel: 'select',

  // selection (AI — Pro)
  ps_select_subject: 'select_ai',
  ps_select_sky: 'select_ai',
  ps_select_subject_instance: 'select_ai',
  ps_select_object: 'select_ai',

  // adjustments
  ps_add_adjustment_layer: 'adjust',
  ps_apply_adjustment: 'adjust',

  // filters — consolidated into ps_filter (2026-08-09); the pre-merge name
  // stays registered as a deprecated alias for one release.
  ps_filter: 'filter',
  ps_apply_filter: 'filter',
  ps_apply_camera_raw: 'filter',

  // retouch
  ps_retouch: 'retouch',
  ps_apply_brush_stroke: 'retouch',

  // layers (lifecycle / props / transform / ordering / groups / styles)
  ps_create_layer: 'layers',
  ps_delete_layer: 'layers',
  ps_fill_layer: 'layers',
  ps_add_fill_layer: 'layers',
  ps_select_layer: 'layers',
  ps_move_layer_to_position: 'layers',
  ps_duplicate_layer: 'layers',
  ps_copy_to_new_layer: 'layers',
  ps_convert_to_smart_object: 'layers',
  ps_rasterize_layer: 'layers',
  ps_set_layer: 'layers',
  ps_merge: 'layers',
  ps_bake_layer: 'layers',
  ps_add_layer_style: 'layers',
  ps_transform_layer: 'layers',
  ps_warp_layer: 'layers',
  ps_warp_layer_mesh: 'layers',
  ps_warp_layer_along: 'layers',
  ps_warp_layer_region: 'layers',
  ps_warp_layer_to: 'layers',
  // group lifecycle/membership — consolidated into ps_group (2026-08-13); the
  // five names below stay registered as deprecated aliases for one release.
  ps_group: 'layers',
  ps_create_group: 'layers',
  ps_move_layer_to_group: 'layers',
  ps_set_group_blend_mode: 'layers',
  ps_ungroup: 'layers',
  ps_delete_group: 'layers',
  // vector shape layers — creates a new vector layer
  ps_shape: 'layers',

  // masks & paths
  ps_layer_mask: 'masks',
  ps_clipping_mask: 'masks',
  ps_path: 'masks',
  ps_vector_mask: 'masks',
  // channel-compose (Apply Image / Calculations) — channel math feeding blends + masks
  ps_apply_image: 'masks',
  ps_calculations: 'masks',

  // type — consolidated into ps_text (2026-08-13); the two names below stay
  // registered as deprecated aliases for one release.
  ps_text: 'type',
  ps_create_text_layer: 'type',
  ps_set_text: 'type',

  // perception (CE-destined local CV + detection-driven orchestrations)
  ps_detect: 'perception',
  ps_read_scene: 'perception',
  ps_select_by_reference: 'perception',
  ps_edit_object: 'perception',
  ps_portrait_touchup: 'perception',
  ps_add_text_to_object: 'perception',
  ps_resolve_placement: 'perception',

  // face mesh (Pro perception)
  ps_detect_landmarks: 'face',
  ps_select_face_feature: 'face',
  ps_stroke_face_contour: 'face',

  // templates (Pro)
  ps_template_create_evidence: 'templates',
  ps_template_save: 'templates',
  ps_template_list: 'templates',
  ps_template_apply: 'templates',
  ps_template_verify: 'templates',
  ps_template_recall: 'templates',
  ps_template_delete: 'templates',

  // automation (Pro)
  ps_list_actions: 'automation',
  ps_play_action: 'automation',
  ps_execute_script: 'automation',
  ps_batch: 'automation',
};

/**
 * Throws if the name is not grouped. Used at server boot (alongside `tierOf`)
 * to refuse to start with an ungrouped tool registered.
 */
export function groupOf(toolName: string): ToolGroup {
  const group = TOOL_GROUPS[toolName];
  if (!group) {
    throw new Error(
      `Tool '${toolName}' has no entry in src/core/tool-groups.ts. ` +
        `Every registered tool must be assigned a capability group.`
    );
  }
  return group;
}

/** All tool names belonging to a given group. */
export function toolsInGroup(group: ToolGroup): string[] {
  return Object.entries(TOOL_GROUPS)
    .filter(([, g]) => g === group)
    .map(([name]) => name);
}
