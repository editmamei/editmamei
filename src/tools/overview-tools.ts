import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';

/**
 * ps_overview.
 *
 * `tools/list` gives the LLM every tool's name + description + schema at
 * session start, but that's an inventory, not an orientation. Tool
 * descriptions tell you what one tool does; they can't tell you how to
 * combine them, when to reach for the verification loop, which patterns
 * belong together (place → preview → bounds_diff → adjust), or which
 * escape hatches to avoid. That knowledge used to live only in
 * the test corpus, which is human-facing — the LLM running an actual
 * edit never saw it.
 *
 * This tool returns one markdown brief in `content[0].text`. CE tier,
 * no doc required, read-only. Referenced from `ps_ping`'s
 * description so the discovery hits at session boot.
 *
 * Content evolves with the codebase. Keep it lean so the LLM
 * doesn't have to skim — every line should change behavior. Current
 * body is just under the 10 KB test ceiling. If a section grows
 * past one screen, split it into a sub-tool or trim back to a
 * pointer + link to the canonical doc.
 *
 * IMPORTANT: this is the source-of-truth for workflow guidance. The
 * test corpus references concepts from this brief, NOT the other way
 * around. If you update this, also check the corpus for drift.
 */

/**
 * The overview markdown body. Exported for the leak-guard test in
 * `tests/integration/readme-leak-guard.test.ts`. Production code reads
 * the same const via the tool handler below; do not import this from
 * other app code.
 */
export const OVERVIEW_MARKDOWN = `# Editmamei — How to drive Photoshop with this MCP

This brief tells you HOW to combine the tools available in this MCP.
The per-tool schemas in \`tools/list\` tell you WHAT each tool does,
and \`tools/list\` is the authoritative inventory of which tools exist
in this session. Read this once at session start when you have an
open-ended editing task; skip it for single-tool requests where you
already know which tool fits.

If you reference a tool by name that isn't in your \`tools/list\`,
work around it — don't speculate that it's there. The discovery chain
is \`ps_ping\` (liveness) → this overview (workflow) →
\`ps_list_capabilities\` (a compact, live map of what exists,
grouped by capability) → \`tools/list\` (full schemas).

## The workflow contract

Every non-trivial edit follows the same six phases:

1. **Assess** — \`ps_inspect\` (what=metadata / layer_tree / history /
   selection_info) + \`ps_get_preview\` to understand what you're working with.
   If \`ps_open_document\` reported \`is_raw_source: true\`, see
   "Raw-sourced documents" below.
2. **Plan** — name the intent, the layers/regions involved, and the
   exit criteria. Tell the user before you execute.
3. **Enact** — call the tools.
4. **Check** — \`ps_get_preview\` after every load-bearing change.
   For spatial questions ("is this aligned?"), use annotations or
   \`ps_get_layer_bounds_diff\` — see Verification below.
5. **Iterate** — up to 3 correction loops. If the third attempt still
   misses, surface the gap to the user instead of looping further.
6. **Finish** — \`ps_export\` (format jpeg/png) /
   \`ps_save_psd\`. Confirm the user wants to flatten before
   destructive saves.

## Raw-sourced documents

\`ps_open_document\` reports \`is_raw_source: true\` for raw captures
(DNG, NEF, CR3, ARW, …) — the open applied last-used/default Camera
Raw settings, so no deliberate develop has happened yet. When
\`tools/list\` includes a camera-raw develop tool, the FIRST enacting
step on a raw document is that develop pass on the base smart object —
NOT stacked Levels/Curves adjustment layers. The develop pass owns
global tone and color; adjustment layers come after, for local/masked
corrections and finishing moves.

Make the first develop pass a complete grade in ONE call, not a timid
nudge: tone endpoints (exposure, contrast, highlights/shadows AND
whites/blacks), presence (texture, clarity, dehaze), a parametric
curve, white balance + vibrance + per-channel HSL where colors need
steering, color grading, capture sharpening + noise reduction (raws
get none by default), optics/vignette where they serve the image.
Three sliders at small values reads as "untouched." Large moves are
safe — the develop is a re-editable smart filter, nothing bakes:
start bold, check preview + histogram, ease off.

To refine, call the develop tool again in its adjust-existing mode —
it preserves every slider you don't pass. Never add a second
camera-raw filter. If no camera-raw develop tool is in \`tools/list\`,
say so in one sentence and build global tone with adjustment layers.
Explicit user instructions always win.

## Capabilities map

This map covers the workflow categories. For specific tool names and
schemas in this session, consult \`tools/list\`.

- **Adjustments (non-destructive)** — \`ps_add_adjustment_layer\`
  covers brightness/contrast, levels, curves, hue/sat, color balance,
  photo filter, vibrance, channel mixer, selective color, black & white,
  gradient map, exposure, color lookup, invert. Always prefer this over
  destructive filters for tone/color work — except raw-sourced
  documents: the camera-raw develop pass goes first (see above).
- **Filters (destructive)** — \`ps_apply_filter\` with a
  \`type\` (gaussian_blur, motion_blur, lens_blur, radial_blur, sharpen,
  smart_sharpen, noise, reduce_noise, high_pass, pixelate, distort,
  displace, oil_paint). Auto-duplicates the active layer by default so
  the original is preserved (\`target_was_copy: true\` in the response);
  pass \`apply_to_active_layer: true\` only when the user explicitly
  wants to bake into the original. Destructive tonal bakes with no
  adjustment-layer equivalent live in \`ps_apply_adjustment\`
  (type shadows_highlights / equalize / color_lookup).
- **Layers** — create / delete / duplicate / select / rasterize /
  convert-to-smart-object / add layer style, plus \`ps_set_layer\`
  (property opacity / blend_mode / visibility / locked / name),
  \`ps_merge\` (mode visible / stamp / flatten), and
  \`ps_transform_layer\` (op move / rotate / scale / fit / flip —
  auto-promotes the background layer, so you don't have to duplicate
  first).
- **Masks** — \`ps_layer_mask\` (op create / delete / apply).
  \`op: "create"\` automatically uses the current selection if one is
  active (reveals selection, hides outside); with no selection it
  creates a reveal-all mask. This is the right tool for "mask the placed
  image to the frame opening" — make the selection first, then call it.
  Don't write \`Mk Chnl At=Msk\` AM scripts for this — it's a one-call
  native. For VECTOR masks + work paths, see \`ps_vector_mask\`
  (op add / delete / link / unlink) and \`ps_path\`
  (selection↔path round-trip, stroke / fill / clip).
- **Selection** — \`ps_select\` (mode rectangle / color_range /
  luminance_range / magic_wand / all / none / inverse),
  \`ps_modify_selection\` (op feather / refine_edge),
  \`ps_selection_channel\` (op save / load),
  \`ps_inspect\` (what=selection_info), \`ps_get_selection_preview\`.
  Smart-selection (AI subject / sky) helpers may be available in
  \`tools/list\` — check there.
- **Perception (on-device CV)** — \`ps_detect\` (faces +
  COCO-80 objects → real document-pixel boxes), \`ps_read_scene\`
  (a structured read of subjects / horizon / tonal zones), and
  \`ps_select_by_reference\` (a NAMED target → a real pixel
  selection instead of a guessed rectangle). The image is analyzed
  locally. Reach for these to get REAL coordinates rather than
  estimating from the preview — they're the antidote to spatial
  guessing.
- **Text** — \`ps_create_text_layer\`, then \`ps_set_text\`
  (property font / color / alignment / content; font resolves family
  names to PostScript).
- **Image** — \`ps_place_image\` (links external files as smart
  objects), \`ps_resize_image\`, \`ps_crop_document\`,
  \`ps_convert_image_mode\`, open / close / save_psd, and
  \`ps_export\` (format jpeg/png).
- **Groups** — \`ps_create_group\`,
  \`ps_move_layer_to_group\`, \`ps_set_group_blend_mode\`,
  \`ps_ungroup\`, \`ps_delete_group\`.
- **Verification** — see below; this is the most underused part of
  the surface.
- **Templates** — when template tools are present in \`tools/list\`,
  they apply reproducible aesthetic recipes. A template binds
  OUTCOMES, not steps: assess the target photo first, re-derive every
  value and geometry from THIS image, skip steps whose objective the
  source already meets, and re-check the recipe's exit criteria before
  declaring done. Read the inventory for the apply / list tool names;
  authoring is a separate workflow with its own tools.

## The verification primitives — use these, not your spatial intuition

Vision-language models are bad at fine spatial estimation. You will
hallucinate "looks good" when reviewing your own output. The fix is
to convert spatial questions into semantic ones:

- **\`ps_get_preview\`** with the \`annotations\` array — draw
  rectangles (by explicit bounds OR by layer name), guides, points,
  or selection markers ON the preview. "Is the placed image aligned
  with the frame?" becomes "Is the red wireframe touching the frame
  edges?" — a question you can answer reliably.
- **\`ps_get_layer_bounds_diff\`** — pass a target rectangle
  + a layer name + a tolerance. Returns a one-word verdict
  ("aligned" / "shifted right" / "layer too small") and numeric
  deltas. Use this when you need a yes/no on placement accuracy,
  not a visual judgment.
- **\`ps_compare_regions\`** — per-channel histogram stats
  for two rectangles. Reach for this when you need a numeric diff
  (matched tones across two crops, before/after for an adjustment).
- **\`ps_get_histogram\`** — full-image or per-channel. Reach
  for this for clipping detection, exposure verification, or "is
  this image neutral-gray?" — \`get_preview\` + eyeballing doesn't
  surface clipping reliably.

## When typed tools aren't enough

Before assuming an operation requires custom scripting, decompose.
Many "I need to script this" tasks are actually compositions of three
native tools in your \`tools/list\` — make a selection, create a mask,
fill black, for example. Re-read your inventory first.

Common false escape-hatch reaches we want you to avoid:
- "Add a layer mask from the current selection" →
  \`ps_layer_mask\` (op create) does this automatically when a
  selection is live.
- "Move the layer so its center is at (x, y)" →
  \`ps_transform_layer\` (op move) with \`center_on_x\` /
  \`center_on_y\`.
- "Rotate this background layer" → \`ps_transform_layer\`
  (op rotate); it auto-promotes the background layer.

If no typed tool fits AND the operation isn't a composition, surface
the gap to the user rather than fabricating a workaround.

## Known gaps

- Frame opening / arbitrary edge detection — no general primitive.
  Best path: \`ps_select\` (mode magic_wand) inside the dark
  interior + read the selection bounds via \`get_selection_info\`.
- Smart Object editing — no native tool to enter / exit smart-object
  edit mode from outside the document. Plan around it.
- Generative AI (Generative Fill, Generative Expand) — gated by
  Photoshop's cloud client. Not exposed by this MCP today.

## Re-orienting mid-session

If you've lost track of what's available — this brief scrolled out of
context, or you're not sure which tool exists for a job — call
\`ps_list_capabilities\`. It returns a compact, live map of every
tool grouped by capability (each group's purpose + the tool names in
it). It's cheaper than re-reading this overview and more current than
any static list. Use it to find the right tool name, then \`tools/list\`
for that tool's full schema.

## When in doubt

Re-read \`tools/list\`. It reports every tool available in this
session with full descriptions and schemas. The overview shows you
the patterns; the inventory shows you the levers.
`;

const overviewSchema = {
  type: 'object' as const,
  properties: {},
};

// connection is unused — the tool is pure-static markdown — but the
// factory signature is fixed for consistency with every other tool
// factory in server.ts.
export function createOverviewTools(
  _connection: PhotoshopConnection,
  _snippetClient: SnippetClient
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'ps_overview',
        description:
          'Orientation brief for the entire MCP — workflow contract, capabilities map by category, verification primitives, escape-hatch policy, known gaps. READ THIS FIRST when the user gives you an open-ended editing task. Read-only, idempotent, no document required, no Photoshop call (returns a static markdown brief). Skip it for trivial single-tool requests where you already know which tool fits.',
        inputSchema: overviewSchema,
        outputSchema: {
          type: 'object',
          properties: {
            sections: { type: 'array', items: { type: 'string' } },
            bytes: { type: 'number' },
          },
        },
        annotations: {
          title: 'MCP Overview',
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      handler: async (): Promise<ToolResult> => {
        // Surface section headings in structuredContent so a downstream
        // client can render a table of contents without re-parsing the
        // markdown. Source of truth is the markdown body — the heading
        // list is derived.
        const sections = OVERVIEW_MARKDOWN.split('\n')
          .filter((line) => line.startsWith('## '))
          .map((line) => line.replace(/^##\s+/, ''));
        return {
          content: [{ type: 'text' as const, text: OVERVIEW_MARKDOWN }],
          structuredContent: {
            sections,
            bytes: OVERVIEW_MARKDOWN.length,
          },
        };
      },
    },
  ];
}
