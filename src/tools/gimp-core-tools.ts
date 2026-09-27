import { basename } from 'node:path';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { GimpError } from '../backends/gimp/errors.js';

/**
 * gimp_ping / gimp_overview — the GIMP-editor twins of ps_ping / ps_overview.
 *
 * gimp_ping never returns isError, connected or not — same posture ps_ping
 * takes (`server.ts`'s buildLicenseAdvisoryNote comment): it is the discovery
 * primitive, and a failed connection is content the caller needs, not an
 * exception to unwind. It answers with whatever the bridge's own `ping` op
 * gives it (`ops.py`'s `op_ping`), which reports open image IDS only — the
 * bridge has no per-image describe op, so an image's name and size come from
 * `gimp_open_document`'s own result at open time.
 */

/**
 * `message` with every occurrence of the install's full path (and launch
 * command) cut down to its basename: a start failure names the binary, and
 * the full path carries the username.
 */
function redactInstallPaths(message: string, gimp: GimpBackend): string {
  const full = [gimp.install?.path, gimp.install?.launch.command].filter(
    (p): p is string => typeof p === 'string' && p.length > 0 && basename(p) !== p
  );
  let out = message;
  for (const p of full) out = out.split(p).join(basename(p));
  return out;
}

const pingSchema = { type: 'object' as const, properties: {} };

interface PingBridgeResult {
  major: number;
  minor: number;
  micro: number;
  images: number[];
}

async function gimpPing(gimp: GimpBackend): Promise<ToolResult> {
  const priorState = gimp.state;
  const installBasename = gimp.install ? basename(gimp.install.path) : null;
  try {
    const result = await gimp.call<PingBridgeResult>('ping', {});
    // The bridge's own state was 'idle' (never started), 'dead' (crashed,
    // timed-out-killed, or a first launch that failed), or 'starting' (a
    // background start already under way, joined by this very call) the
    // instant BEFORE this call — #dispatch's lazy #startFresh/#joinOrStart is
    // what just took it to 'ready'. 'idle' -> cold start; 'dead'/'starting'
    // -> defer to the ORIGIN of the attempt that just connected
    // (`gimp.startOrigin`: 'restarted' only if the session had been ready
    // before, so a first launch that failed and was retried still reads
    // 'cold'); anything else ('ready', a session already warm before this
    // call) -> warm.
    const sessionState: 'cold' | 'warm' | 'restarted' =
      priorState === 'idle'
        ? 'cold'
        : priorState === 'dead' || priorState === 'starting'
          ? (gimp.startOrigin ?? 'restarted')
          : 'warm';
    const version = `${result.major}.${result.minor}.${result.micro}`;
    const openImages = (result.images ?? []).map((image) => ({ image }));
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Connected to GIMP ${version} (session ${sessionState}). ` +
            `${openImages.length} image(s) open in this headless session.`,
        },
      ],
      structuredContent: {
        connected: true,
        gimp_version: version,
        session_state: sessionState,
        open_images: openImages,
        install_path_basename: installBasename,
      },
    };
  } catch (error) {
    const message = redactInstallPaths(
      error instanceof Error ? error.message : String(error),
      gimp
    );
    // `gimp_starting` is not a failed connection — it's still starting, and
    // the caller should just ask again shortly. Reported distinctly (but
    // still never isError, and still connected: false — nothing is ready to
    // dispatch ops against yet) so the caller can tell "come back later"
    // from "actually broken".
    const isStarting = error instanceof GimpError && error.code === 'gimp_starting';
    return {
      content: [
        { type: 'text' as const, text: isStarting ? message : `Not connected to GIMP: ${message}` },
      ],
      structuredContent: {
        connected: false,
        gimp_version: null,
        // Origin-aware even here: a `gimp_starting` thrown while RECOVERING
        // from a crash is still 'restarted', not 'cold' — same reasoning as
        // the success branch above.
        session_state: isStarting ? (gimp.startOrigin ?? 'cold') : 'cold',
        open_images: [],
        install_path_basename: installBasename,
        ...(isStarting ? { starting: true } : {}),
      },
    };
  }
}

/**
 * The GIMP workflow-contract text — same skeleton as `OVERVIEW_MARKDOWN`
 * (`overview-tools.ts`), with GIMP-specific semantics swapped in. Keep this
 * the canonical home for gimp_* workflow guidance; don't duplicate it into
 * per-tool descriptions.
 */
export const GIMP_OVERVIEW_MARKDOWN = `# Editmamei — driving headless GIMP with this MCP

This is the second-editor beta surface: a headless \`gimp_*\` tool set
alongside (or instead of) the Photoshop \`ps_*\` surface, depending on
what this build's boot detected. When both \`ps_*\` and \`gimp_*\` tools
are registered, use \`gimp_*\` only when the user asked for GIMP or
Photoshop is unavailable. Discovery chain: \`gimp_ping\`
(liveness + session state) -> this overview (workflow) ->
\`ps_list_capabilities\` (a live map of every tool, grouped) ->
\`tools/list\` (full schemas). If a tool named here isn't in your
\`tools/list\`, work around it rather than assuming it exists.

## Headless framing

There is no visible GIMP window. Your edits happen inside a background
\`gimp-console\` process this MCP started; the GIMP GUI (if the user has
one open) is a SEPARATE, independent process and does not update. Watch
progress via \`gimp_get_preview\`'s returned image (also written to
\`latest-preview.jpg\` in the session folder), or open the saved \`.xcf\`
in the real GIMP GUI afterward to see it directly.

## The workflow contract

1. **Assess** — \`gimp_open_document\` + \`gimp_inspect\` +
   \`gimp_get_preview\`.
2. **Plan** — name the intent, the filters/masks involved, and the exit
   criteria before executing.
3. **Enact** — call the tools.
4. **Check** — \`gimp_get_preview\` after a visual change,
   \`gimp_get_histogram\` (\`exact: true\`) as the final clipping check
   before export, \`gimp_filter\` (op=list) to confirm the filter stack.
5. **Iterate** — re-edit a filter by its \`filter_id\` rather than
   stacking a second one for the same correction (see "Curve laws"
   below).
6. **Finish** — \`gimp_save_xcf\` keeps every filter live and
   re-editable; \`gimp_export\` writes a flattened deliverable. Do both
   when the user wants to keep working on it later AND ship a JPEG/PNG
   now.

## Curve laws (gimp_add_adjustment type=curves)

ONE \`gimp:curves\` filter carries exactly ONE channel's curve — setting
red then blue on the SAME filter only keeps blue. To grade multiple
channels, add ONE filter per channel. Points are \`[input, output]\`
pairs on a 0-255 scale, ascending input, and should include the
endpoints (e.g. \`[[0,0],[64,90],[255,255]]\` lifts shadows). To
re-edit a curve, pass its \`filter_id\` back — this REPLACES that
filter's curve in place; it does not stack a second correction on top
of the first. Check the live stack any time with
\`gimp_filter\` (op=list).

## Ledger truth vs. readback

Every filter this server creates is tracked in a persistent ledger
saved inside the \`.xcf\`. \`gimp_filter\` (op=list) reports
\`source: "editmamei"\` for those — exact, trustworthy parameters, in
\`gimp_add_adjustment\`'s own field names and units, so a listed value
can be passed straight back on a re-edit. A filter the GIMP GUI (or a
different tool) created independently reports \`source: "readback"\` —
raw GEGL property names and units, not tool fields. GIMP's own config
readback is LOSSY for per-channel curves/levels after a reload (it
silently reports only the \`value\` channel), so treat a readback
record as approximate, not ground truth. Because its current values
can't be read back exactly, a readback filter can't be re-edited by
\`filter_id\` — that is refused; delete it and re-create it, or edit it
in the GIMP GUI.

## .xcf vs export

\`gimp_save_xcf\` saves the live GIMP document — filters stay in place
and re-editable, matching \`ps_save_psd\`'s framing. \`gimp_export\`
flattens a duplicate first — the deliverable, with every filter baked
and ALL metadata (EXIF/XMP/IPTC/GPS) stripped unconditionally, never
carried over.

Opening a file clears any selection saved in it: every \`gimp_*\` op
works on the whole canvas (a selection would confine a rotate to the
selected pixels). A later \`gimp_save_xcf\` therefore does not keep that
selection.

## Precision for aggressive tone moves

\`gimp_open_document\`'s \`precision\` option (\`'16'\` or \`'32'\`)
promotes bit depth before grading. Do this before a large exposure/
levels/curves move on an 8-bit source — skipping it risks visible
banding in smooth gradients (sky, skin) that a develop-then-grade
workflow avoids.

## Masks

\`gimp_create_mask\` builds a geometric mask (rectangle / ellipse /
gradient) into a NAMED channel. Pass that name as \`mask\` when you
CREATE a filter with \`gimp_add_adjustment\` to confine it. A filter's
mask is fixed at creation — re-editing it by \`filter_id\` cannot
change which mask it uses; delete and re-create it with a new mask
instead.

## Order matters: geometry before masked adjustments

Straighten / flip / resize the canvas FIRST, then crop, then add any
MASKED adjustment. Rotate, flip, and resize all REFUSE outright when
the image already has a masked filter, or any filter not created by
Editmamei (for example one added in the GIMP GUI — whether it is masked
can't be checked) — GIMP has no way to keep a filter's own baked-in mask
confinement aligned with those transforms (a masked filter drawn at the
old geometry would silently render in the wrong place). Crop is the one
exception: cropping preserves every filter, mask, and channel correctly,
so it's safe at any point in the sequence. Unmasked filters survive
every geometry op.

## No undo: geometry is permanent, adjustments are not

Crop, resize, rotate, and flip are IRREVERSIBLE in this session — there
is no undo. \`gimp_save_xcf\` first when in doubt, and reopen that file
to go back. Adjustments are reversible: \`gimp_filter\` (op=delete)
removes one, and a re-edit by \`filter_id\` changes it in place.

## Previews are proxy renders

\`gimp_get_preview\` and the default (non-\`exact\`) \`gimp_get_histogram\`
render a downscaled proxy with live filters re-applied. Per-pixel and
proportional filters (curves, levels, color balance, vignette, black &
white) are EXACT on the proxy; spatial filters (sharpen, gaussian blur,
shadows/highlights, noise reduction, motion blur, lens blur, drop
shadow) are approximate — their radius/length/std-dev is scaled to the
proxy size, not rendered at native resolution. \`gimp_get_histogram\`'s
\`exact: true\` (full-resolution) is the trustworthy final check before
export, especially for a spatial filter or a masked crop.

## Raw files need a raw-develop plug-in

GIMP core has no raw-camera loader. \`gimp_open_document\` always tries
the load: an install with a raw-develop plug-in (darktable, RawTherapee,
or ART) opens DNG/CR2/CR3/NEF/ARW/... directly. Without one, the load
fails with a named error pointing at those developers — develop the
file there first and open the resulting JPEG/TIFF/PNG here.

## Re-orienting mid-session

Call \`ps_list_capabilities\` — it is a shared, editor-agnostic meta
tool that lists every tool currently registered (both \`ps_*\` and
\`gimp_*\`, whichever this boot has), grouped by capability.
`;

const overviewSchema = { type: 'object' as const, properties: {} };

function gimpOverview(): ToolResult {
  const sections = GIMP_OVERVIEW_MARKDOWN.split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.replace(/^##\s+/, ''));
  return {
    content: [{ type: 'text' as const, text: GIMP_OVERVIEW_MARKDOWN }],
    structuredContent: {
      sections,
      bytes: GIMP_OVERVIEW_MARKDOWN.length,
    },
  };
}

export function createGimpCoreTools(gimp: GimpBackend): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'gimp_ping',
        description:
          'Headless GIMP: test connection to the GIMP session and report session-start discovery ' +
          'signals. Starts the session on the FIRST call if it is not already running — this cold ' +
          'start is usually just a few seconds (about 10 seconds on macOS), so expect the first ' +
          'gimp_ping (or any first gimp_* call) in a session to be a bit slow; every call after ' +
          'that is fast. The VERY FIRST launch on a machine can instead take a few minutes (GIMP ' +
          'building its font cache, scanning plug-ins, macOS Gatekeeper) — during that window ' +
          'gimp_ping reports `starting: true` in structuredContent rather than failing; call it ' +
          'again in about 30 seconds. Read-only and idempotent. Call this once at the start of a ' +
          'GIMP-editing task to confirm liveness before invoking any other gimp_* tool. **Also ' +
          'call `gimp_overview` after this** — it returns the headless workflow contract (curve ' +
          'laws, ledger vs. readback, geometry-before-masks ordering) so you can plan well; GIMP ' +
          'semantics differ from Photoshop in ways that matter. Never returns an error — a failed ' +
          'connection (or one still starting) is reported via `connected: false` plus an ' +
          'explanatory message, the same posture ps_ping takes.',
        inputSchema: pingSchema,
        outputSchema: {
          type: 'object',
          properties: {
            connected: { type: 'boolean' },
            gimp_version: { type: ['string', 'null'] },
            session_state: { type: 'string', enum: ['cold', 'warm', 'restarted'] },
            open_images: {
              type: 'array',
              items: { type: 'object', properties: { image: { type: 'number' } } },
            },
            install_path_basename: { type: ['string', 'null'] },
            starting: {
              type: 'boolean',
              description:
                'Present and true only when the session is still on its very first launch — ' +
                'call gimp_ping again in about 30 seconds.',
            },
          },
        },
        annotations: {
          title: 'Ping GIMP',
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      handler: async () => gimpPing(gimp),
    },
    {
      tool: {
        name: 'gimp_overview',
        description:
          'Headless GIMP: orientation brief for the gimp_* tool surface — the headless workflow ' +
          "contract, curve laws (one filter per channel; re-edit by filter_id, don't stack), " +
          'ledger-truth vs. readback, .xcf-vs-export, precision guidance, mask/geometry ordering, ' +
          'no undo for geometry, proxy-preview caveats, raw-file handling, and when to prefer ' +
          "gimp_* over ps_*. READ THIS FIRST when you're given an " +
          'open-ended GIMP editing task. Read-only, idempotent, no document required, no GIMP ' +
          'round trip (returns a static markdown brief). Skip it for a trivial single-tool request ' +
          'where you already know which tool fits.',
        inputSchema: overviewSchema,
        outputSchema: {
          type: 'object',
          properties: {
            sections: { type: 'array', items: { type: 'string' } },
            bytes: { type: 'number' },
          },
        },
        annotations: {
          title: 'GIMP Overview',
          readOnlyHint: true,
          idempotentHint: true,
        },
      },
      handler: async () => gimpOverview(),
    },
  ];
}
