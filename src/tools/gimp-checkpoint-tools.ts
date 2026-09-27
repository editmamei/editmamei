import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import type { GimpBackend } from '../backends/gimp/backend.js';
import { validateArgs, type JsonSchemaObject } from '../utils/validate.js';
import { toolGimpErrorResult, unknownDiscriminator } from '../utils/tool-helpers.js';
import { GimpError } from '../backends/gimp/errors.js';
import { GIMP_IMAGE_PROP } from './gimp-shared.js';

/**
 * gimp_checkpoint — the headless substitute for undo.
 *
 * There is no bridge op here: `create` dispatches the SAME `export` op
 * `gimp_save_xcf` uses, to a file under the session's own temp root
 * (`GimpBackend.tempPath`) instead of a caller-supplied path — the `.xcf`
 * branch of the bridge's `op_export` keeps every live filter re-editable via
 * the ledger parasite (`ops.py:1231-1238`), so a restored checkpoint is not
 * just pixels. `restore` dispatches `open` on that file, then `close` on the
 * image the checkpoint is replacing. `list`/`delete` touch only the registry
 * below and (for delete) the filesystem — no bridge round trip beyond an
 * occasional `ping` (see `refreshOpenness`).
 *
 * Disk-backed on purpose, not an in-memory duplicate: an in-memory copy dies
 * in the exact event checkpoints exist for — a timeout or crash tree-kills
 * the whole GIMP process (`session.ts`'s `gimp_session_restarted`), which
 * would take an in-memory checkpoint down with it. A file on disk survives
 * that, so `restore` still works right after the model sees
 * `gimp_session_restarted` — it just reopens the file; a fresh GIMP session
 * starts under it the same way any other bridge call would restart one.
 *
 * The registry is a plain `Map` living in this factory's closure (one per
 * server process — `gimpModule.register` calls each factory exactly once at
 * boot, and Connect's remote server calls `buildTools`/`gimpFactories` once
 * PER SESSION, so there a registry is already per-client — see this file's
 * git history / the PR handback for the multi-client note). Every record's
 * `image` field tracks the CURRENT image this checkpoint is a snapshot
 * ancestor of: at `create` time it's the source image; after each `restore`
 * it's updated to the freshly reopened image (and every SIBLING record
 * pointing at the same replaced image moves with it — see `repointSiblings`),
 * so a later restore of any of them closes the right (post-restore) image
 * rather than one already gone.
 *
 * KNOWN LIMITATION, not fixed here (see the PR handback report): there is no
 * way to detect, through this backend's allowed surface (`call`, `prepare`,
 * `tempPath`), whether the underlying GIMP PROCESS has restarted since a
 * record's `image` id was last confirmed live. `ping`'s response carries no
 * process identity (no pid, no generation counter), and `GimpSession`'s own
 * internal `deadGeneration` counter — which WOULD serve this purpose — is
 * private and not exposed on `GimpBackend`. After a restart, GIMP's own
 * internal image-id counter restarts too, so a low id can genuinely mean "a
 * different image entirely" rather than "the same image, still open". This
 * file therefore does the one thing it CAN do safely without that signal
 * (never issue a `close` for an id that exactly equals the id `restore` just
 * reopened — see `checkpointRestore`) and no more; `refreshOpenness` below
 * only ever helps within a single, un-restarted GIMP process (detecting a
 * plain `gimp_close_document` elsewhere), not across a restart. The smallest
 * real fix is an engine change: expose a monotonic per-spawn counter (e.g.
 * `GimpSession`'s existing `deadGeneration`, already tracked internally) as a
 * new read-only `GimpBackend` getter, so a record could be stamped with it at
 * `create` time and compared at `restore` time.
 *
 * No absolute paths or usernames ever reach a tool result — `record.path`
 * lives under the user's own temp/home directory and is used only to talk to
 * the bridge or the filesystem, never returned in `content` or
 * `structuredContent`, and never appears in an error message either (a
 * removal failure is reported without it — see `checkpointDelete`).
 */

/** Refuse the 6th `create` for one image rather than silently evicting the oldest. */
export const MAX_CHECKPOINTS_PER_IMAGE = 5;

/** A leftover checkpoint file older than this, found on the next server start, is swept — see
 * `sweepStaleCheckpointFiles`. Old enough that a concurrent, still-running server process's own
 * (younger) checkpoints are never touched by this. */
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Exported for `cleanupRegisteredCheckpointFiles` / `sweepStaleCheckpointFiles`'s own unit tests
 * — see tests/tools/gimp-checkpoint-tools.test.ts. */
export interface CheckpointRecord {
  id: string;
  image: number;
  /**
   * Best-effort belief that `image` is still an open GIMP image, refreshed from a live `ping`'s
   * open-images list (`refreshOpenness`) at the start of create/list. Starts `true`; flips to
   * `false` when a refresh confirms the id is gone, or when `restore` confirms (by a successful
   * close, or a "no open image" / session-restarted answer) that it closed. Never flips back to
   * `true` except by `restore` itself assigning a freshly-opened image — a refresh only ever
   * narrows belief, it never un-narrows it, since a reused post-restart id reappearing in a fresh
   * `ping` would otherwise look identical to "still the same image" (see the file header comment).
   * A `false` record is still fully restorable from its file; it just no longer counts toward its
   * own image's create cap or appears under that image's scoped `list` (HIGH #4).
   */
  open: boolean;
  /** Absolute path under the session temp root — never surfaced to the model. */
  path: string;
  bytes: number;
  createdAt: string;
}

const checkpointSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: ['create', 'restore', 'list', 'delete'],
      description:
        "'create' exports the image's current state — every live filter included — to a " +
        "disk-backed snapshot and returns a checkpoint_id. 'restore' reopens that snapshot as a " +
        'NEW image and closes the old one (replace semantics, not a copy: the old image id stops ' +
        "working the moment restore succeeds). 'list' reports every checkpoint (optionally scoped " +
        'to one image): checkpoint_id, the image it currently belongs to (open: false if that ' +
        'image is confirmed gone — still restorable), created_at, bytes — never a file path. ' +
        "'delete' removes one, freeing its slot.",
    },
    image: {
      ...GIMP_IMAGE_PROP,
      description:
        (GIMP_IMAGE_PROP.description ?? '') +
        ' Required for create. Optional for list (omit to list checkpoints for every image).',
    },
    checkpoint_id: {
      type: 'string',
      description:
        'Required for restore / delete. The id create (or a prior list) reported for this checkpoint.',
    },
  },
  required: ['op'],
};

/** True only for the bridge's own explicit "the session restarted" classification (session.ts's
 * `#send`, matched by CODE, not by scanning message text for a phrase that could appear for an
 * unrelated reason). */
function isSessionRestartedError(error: unknown): boolean {
  return error instanceof GimpError && error.code === 'gimp_session_restarted';
}

/** True for the bridge's OWN plain "no open image with id N" answer — the image was closed
 * (by an earlier `gimp_close_document`, or an earlier restore's own close) with no restart
 * involved. `invalid_argument` alone is too broad a code to treat every instance as this case
 * (e.g. a missing `checkpoint_id` is also `invalid_argument`), so within that one code a message
 * check narrows to the specific bridge wording — there is no dedicated code for this in
 * `GIMP_ERROR_CODES` today. */
function isImageAlreadyClosedError(error: unknown): boolean {
  return (
    error instanceof GimpError &&
    error.code === 'invalid_argument' &&
    /no open image with id/i.test(error.message)
  );
}

/**
 * Refreshes every record's `open` belief from a live `ping`'s open-images list. A no-op when the
 * registry is empty (skips the round trip entirely) or when the bridge's answer carries no
 * `images` array at all (leaves every belief exactly as it was, rather than treating an absent
 * field as "nothing is open"). See `CheckpointRecord.open`'s own doc comment for why this only
 * ever narrows belief (`true` -> `false`), never widens it.
 */
async function refreshOpenness(
  gimp: GimpBackend,
  registry: Map<string, CheckpointRecord>
): Promise<void> {
  if (registry.size === 0) return;
  const ping = await gimp.call<{ images?: number[] }>('ping', {});
  if (!Array.isArray(ping.images)) return;
  const openIds = new Set(ping.images);
  for (const record of registry.values()) {
    if (record.open && !openIds.has(record.image)) record.open = false;
  }
}

/** After a CONFIRMED close of `from` (restore's own `close` call actually succeeded — proof, not
 * a guess, that no restart raced it), every OTHER checkpoint still pointing at `from` is a
 * snapshot of the same now-transformed lineage, so it moves to `to` right along with the one
 * being restored (HIGH #3 — "sibling re-pointing"). */
function repointSiblings(registry: Map<string, CheckpointRecord>, from: number, to: number): void {
  for (const sibling of registry.values()) {
    if (sibling.image === from) {
      sibling.image = to;
      sibling.open = true;
    }
  }
}

/** After `from` is confirmed gone WITHOUT a fresh image to move sibling records to (a tolerated
 * "already gone" close, whether from a plain prior close or a session restart), every OTHER
 * checkpoint still pointing at `from` is marked gone too — its own file is still fully
 * restorable, but its bookkeeping no longer claims a specific live image. Deliberately NOT
 * re-pointed to the just-opened image: that image is a live continuation of the ONE checkpoint
 * actually being restored, not of these unrelated siblings' own (different) file content. */
function markSiblingsGone(registry: Map<string, CheckpointRecord>, image: number): void {
  for (const sibling of registry.values()) {
    if (sibling.image === image) sibling.open = false;
  }
}

async function checkpointCreate(
  gimp: GimpBackend,
  args: Record<string, unknown>,
  registry: Map<string, CheckpointRecord>
): Promise<ToolResult> {
  const image = args.image;
  if (typeof image !== 'number') {
    throw new GimpError('invalid_argument', '"image" is required for op=create.');
  }
  await gimp.prepare(); // a late-found install must be in place before tempPath runs
  await refreshOpenness(gimp, registry);
  // ---- Synchronous from here to the reservation below: no `await` runs between the cap check
  // and placing the reservation in the registry, so two concurrent creates for the same image
  // can never both pass the check before either one counts against the cap (HIGH #7). ----
  const existingOpen = [...registry.values()].filter((r) => r.image === image && r.open);
  if (existingOpen.length >= MAX_CHECKPOINTS_PER_IMAGE) {
    throw new GimpError(
      'invalid_argument',
      `image ${image} already has ${MAX_CHECKPOINTS_PER_IMAGE} checkpoints, the maximum per image. ` +
        `Delete one first — gimp_checkpoint op=delete, checkpoint_id one of: ` +
        `${existingOpen.map((r) => r.id).join(', ')} — or list them with op=list.`
    );
  }
  const id = randomUUID();
  const path = gimp.tempPath(`checkpoint-${id}.xcf`);
  const createdAt = new Date().toISOString();
  registry.set(id, { id, image, path, bytes: 0, createdAt, open: true });
  // ---- async again: the reservation above is what makes this safe to await ----
  try {
    const result = await gimp.call<{ bytes: number }>('export', { image, path });
    const record = registry.get(id)!;
    record.bytes = result.bytes;
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Checkpoint "${id}" created from image ${image} (${result.bytes.toLocaleString()} bytes). ` +
            `Restore it later with gimp_checkpoint op=restore, checkpoint_id: "${id}".`,
        },
      ],
      structuredContent: { checkpoint_id: id, image, bytes: result.bytes, created_at: createdAt },
    };
  } catch (error) {
    // (c) a failed export leaves nothing behind: no registry entry, and no partial file.
    registry.delete(id);
    try {
      await rm(path, { force: true });
    } catch {
      /* best effort — the export failure itself is what the caller needs to see */
    }
    throw error;
  }
}

async function checkpointList(
  gimp: GimpBackend,
  args: Record<string, unknown>,
  registry: Map<string, CheckpointRecord>
): Promise<ToolResult> {
  await refreshOpenness(gimp, registry);
  const image = args.image;
  const scoped = typeof image === 'number';
  const filtered = [...registry.values()].filter((r) => {
    if (!scoped) return true;
    // A gone record's CURRENT `.image` number no longer denotes a live document, so it does not
    // belong under a scoped-by-image listing (HIGH #4) — it still appears in the unscoped list
    // below, marked open: false.
    return r.image === image && r.open;
  });
  const checkpoints = filtered.map((r) => ({
    checkpoint_id: r.id,
    image: r.image,
    open: r.open,
    bytes: r.bytes,
    created_at: r.createdAt,
  }));
  const goneCount = checkpoints.filter((c) => !c.open).length;
  const scopedNote = scoped ? ` for image ${image}` : '';
  const goneNote =
    goneCount > 0
      ? ` (${goneCount} for an image that is now gone — still restorable by checkpoint_id)`
      : '';
  return {
    content: [
      {
        type: 'text' as const,
        text: `${checkpoints.length} checkpoint(s)${scopedNote}.${goneNote}`,
      },
    ],
    structuredContent: { checkpoints },
  };
}

/** Shared by restore/delete: both require a `checkpoint_id` naming a KNOWN record. */
function requireKnownCheckpoint(
  args: Record<string, unknown>,
  op: string,
  registry: Map<string, CheckpointRecord>
): CheckpointRecord {
  const checkpointId = args.checkpoint_id;
  if (typeof checkpointId !== 'string' || checkpointId.length === 0) {
    throw new GimpError('invalid_argument', `"checkpoint_id" is required for op=${op}.`);
  }
  const record = registry.get(checkpointId);
  if (!record) {
    const known = [...registry.keys()];
    throw new GimpError(
      'invalid_argument',
      `unknown checkpoint_id "${checkpointId}". ` +
        (known.length > 0
          ? `Known checkpoint ids: ${known.join(', ')}.`
          : 'No checkpoints exist yet.')
    );
  }
  return record;
}

async function checkpointDelete(
  args: Record<string, unknown>,
  registry: Map<string, CheckpointRecord>
): Promise<ToolResult> {
  const record = requireKnownCheckpoint(args, 'delete', registry);
  try {
    await rm(record.path, { force: true });
  } catch {
    // (HIGH #6) Node's own error names the absolute path (EPERM/EBUSY carry it in `.message`) —
    // never let that reach the model; the checkpoint_id is the only identifier it needs anyway.
    throw new GimpError(
      'gimp_op_failed',
      `could not delete checkpoint "${record.id}" — its file may still be open elsewhere.`
    );
  }
  registry.delete(record.id);
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Deleted checkpoint "${record.id}" (was from image ${record.image}, ` +
          `${record.bytes.toLocaleString()} bytes).`,
      },
    ],
    structuredContent: { checkpoint_id: record.id, deleted: true },
  };
}

async function checkpointRestore(
  gimp: GimpBackend,
  args: Record<string, unknown>,
  registry: Map<string, CheckpointRecord>
): Promise<ToolResult> {
  const record = requireKnownCheckpoint(args, 'restore', registry);
  const opened = await gimp.call<{ image: number; width: number; height: number }>('open', {
    path: record.path,
  });
  const oldImage = record.image;
  let closeNote: string;
  let closeFailed = false;

  if (oldImage === opened.image) {
    // The id GIMP just handed back for the reopened file happens to equal the id this record
    // remembers as "the image to close" — closing it would destroy the image restore just
    // opened. This is the one case this tool can tell apart with certainty without a GIMP
    // process generation signal (not reachable through call/prepare/tempPath today — see this
    // file's header comment); never close here, regardless of whether oldImage is genuinely the
    // same document or an unrelated one that reused its number after a restart.
    closeNote = `image ${oldImage} is the id restore just reopened — nothing to close`;
  } else {
    try {
      await gimp.call('close', { image: oldImage });
      closeNote = `image ${oldImage} closed`;
      repointSiblings(registry, oldImage, opened.image);
    } catch (closeError) {
      if (isSessionRestartedError(closeError)) {
        closeNote = `image ${oldImage} was already gone (the GIMP session had restarted)`;
        markSiblingsGone(registry, oldImage);
      } else if (isImageAlreadyClosedError(closeError)) {
        // Genuinely just closed (by gimp_close_document, or an earlier restore) — no restart
        // implied, so say so plainly rather than reusing the restart wording (HIGH #8).
        closeNote = `image ${oldImage} was already closed`;
        markSiblingsGone(registry, oldImage);
      } else {
        // (HIGH #5) An unrelated close failure must not swallow the fact that restore itself
        // DID succeed — the new image is open and the model needs its id regardless. Leave
        // every sibling's bookkeeping untouched: this failure gives no information about
        // whether oldImage is actually still open or not.
        closeFailed = true;
        const msg = closeError instanceof Error ? closeError.message : String(closeError);
        closeNote = `image ${oldImage} could not be closed (${msg}) — it is still open`;
      }
    }
  }

  // Unconditional: whatever happened to the old image, THIS record now describes the freshly
  // opened one.
  record.image = opened.image;
  record.open = true;
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `${closeNote}; restored as image ${opened.image} ` +
          `(${opened.width}x${opened.height}) — use ${opened.image} from now on.`,
      },
    ],
    structuredContent: {
      checkpoint_id: record.id,
      old_image: oldImage,
      image: opened.image,
      width: opened.width,
      height: opened.height,
      close_failed: closeFailed,
    },
  };
}

async function gimpCheckpoint(
  gimp: GimpBackend,
  rawArgs: Record<string, unknown>,
  registry: Map<string, CheckpointRecord>
): Promise<ToolResult> {
  try {
    const args = validateArgs(checkpointSchema, rawArgs);
    const op = args.op as string;
    // Unreachable while the schema's own enum stands (validateArgs already
    // refused anything outside it) — kept as defense-in-depth, the same
    // posture every other consolidated dispatcher takes.
    if (op !== 'create' && op !== 'restore' && op !== 'list' && op !== 'delete') {
      return unknownDiscriminator('op', op, ['create', 'restore', 'list', 'delete']);
    }
    if (op === 'create') return await checkpointCreate(gimp, args, registry);
    if (op === 'list') return await checkpointList(gimp, args, registry);
    if (op === 'delete') return await checkpointDelete(args, registry);
    return await checkpointRestore(gimp, args, registry);
  } catch (error) {
    return toolGimpErrorResult('Error managing GIMP checkpoint', error);
  }
}

// ---- file lifecycle (HIGH #1) -----------------------------------------------------------------

/**
 * Removes every checkpoint file this registry still references. Used both directly by
 * `createGimpCheckpointTools`'s `process.once('exit', ...)` hook and by tests — synchronous
 * because an `exit` handler cannot await, and because a test asserting "the files are gone
 * afterward" wants that to already be true the moment this call returns. Swallows a per-file
 * removal failure (EPERM/EBUSY — a file another process still has open) rather than throwing,
 * the same posture `GimpSession`'s own `#removeSessionDir` takes for its session directories.
 */
export function cleanupRegisteredCheckpointFiles(registry: Map<string, CheckpointRecord>): void {
  for (const record of registry.values()) {
    try {
      rmSync(record.path, { force: true });
    } catch {
      /* best effort — the process is on its way out either way */
    }
  }
}

/** Every registry `createGimpCheckpointTools` has ever created, module-scoped so the actual
 * `process.once('exit', ...)` listener below is registered exactly ONCE per process no matter how
 * many times the factory itself runs (Connect's remote server calls it once per session; this
 * test file's own suite calls it dozens of times) — see `registerForExitCleanup`. */
const trackedRegistries = new Set<Map<string, CheckpointRecord>>();
let exitCleanupRegistered = false;

/** Tracks `registry` for the shared exit-time sweep, registering the ONE process-wide listener
 * the first time this runs and never again — avoids accumulating one `exit` listener per factory
 * call (Node's own `MaxListenersExceededWarning` past 10). */
function registerForExitCleanup(registry: Map<string, CheckpointRecord>): void {
  trackedRegistries.add(registry);
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once('exit', () => {
    for (const tracked of trackedRegistries) cleanupRegisteredCheckpointFiles(tracked);
  });
}

/**
 * Removes `checkpoint-*.xcf` files older than `CHECKPOINT_MAX_AGE_MS` from `dir` — leftovers from
 * an earlier process that crashed or was killed before its own exit hook
 * (`cleanupRegisteredCheckpointFiles`) could run. The age floor, not an unconditional sweep, is
 * what keeps this from touching a DIFFERENT, still-running server process's own live checkpoint
 * files in the same shared directory — as long as those stay younger than the floor, they are
 * never a target. `now` is injectable for tests, mirroring `GimpSession`'s own `#sweepOrphans`.
 */
export function sweepStaleCheckpointFiles(dir: string, now: () => number = Date.now): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = now() - CHECKPOINT_MAX_AGE_MS;
  for (const name of entries) {
    if (!/^checkpoint-.*\.xcf$/.test(name)) continue;
    const path = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= cutoff) continue;
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
  }
}

export function createGimpCheckpointTools(gimp: GimpBackend): ToolDefinition[] {
  // One Map per factory call — one per server process for the local host
  // (`gimpModule.register` calls each factory exactly once at boot); Connect's remote server
  // calls `buildTools`/`gimpFactories` once PER SESSION (`sessions.ts`), so there this registry
  // is already isolated per client. Checkpoints persist across calls for the life of whichever
  // process/session constructed this factory, per the tool's own contract.
  const registry = new Map<string, CheckpointRecord>();
  // No shutdown hook is exposed through the allowed backend surface (call/prepare/tempPath), so
  // this is the documented fallback. `registerForExitCleanup` tracks this registry in a
  // MODULE-level set and registers the actual `process.once('exit', ...)` listener only ONCE for
  // the whole process (not once per factory call) — Connect's remote server calls this factory
  // once per session, and a long-lived remote server creating many sessions must not accumulate
  // one listener per session (Node's own MaxListenersExceededWarning past 10). One shared
  // listener sweeps every tracked registry at actual process exit; per-session file cleanup
  // there still only happens at whole-process exit, not at individual session teardown — a
  // Connect worklist item, not something fixable from here.
  registerForExitCleanup(registry);
  let sweepDone = false;

  async function ensureSwept(): Promise<void> {
    if (sweepDone) return;
    sweepDone = true;
    await gimp.prepare();
    const dir = dirname(gimp.tempPath('checkpoint-sweep-probe.xcf'));
    sweepStaleCheckpointFiles(dir);
  }

  return [
    {
      tool: {
        name: 'gimp_checkpoint',
        description:
          'Headless GIMP: disk-backed checkpoints — the substitute for undo in a session that has ' +
          "none. op=create exports the image's CURRENT state, every live filter included, to a " +
          'snapshot file and returns a checkpoint_id. op=restore reopens that snapshot as a NEW ' +
          'image and closes the old one — replace semantics, not a copy, so the old image id stops ' +
          'working the moment restore succeeds; it returns the new image id and says so plainly, ' +
          'e.g. "image N closed; restored as image M — use M from now on". A checkpoint survives a ' +
          'GIMP crash or timeout: restore reopens the FILE, not anything the crashed process held, ' +
          'so it still works right after a gimp_session_restarted error — that is the whole point ' +
          "of keeping it on disk instead of in GIMP's own memory. Each image holds at most " +
          `${MAX_CHECKPOINTS_PER_IMAGE} checkpoints (an image whose earlier checkpoints' image ` +
          "has since closed doesn't count against a NEW image reusing that number): a 6th " +
          'op=create for the same still-open image REFUSES outright rather than silently evicting ' +
          'the oldest — delete one first (op=delete) or list them (op=list) to see what exists. ' +
          'Every checkpoint file is removed when this MCP server process shuts down, not merely ' +
          'abandoned; a leftover from an earlier process that crashed before it could clean up is ' +
          'swept the next time this tool runs, once it is more than 24 hours old. op=list reports ' +
          'checkpoint_id, the image it currently belongs to, created_at, and its size in bytes — ' +
          'never a file path (a full path carries the username) — plus open: false for a ' +
          'checkpoint whose image has since closed (still restorable; just excluded from that ' +
          "image's own scoped list and cap). An unknown checkpoint_id on restore or delete is " +
          'refused, naming every checkpoint_id that IS known.',
        inputSchema: checkpointSchema,
        outputSchema: {
          type: 'object',
          properties: {
            checkpoint_id: { type: 'string' },
            image: { type: 'number' },
            old_image: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            bytes: { type: 'number' },
            created_at: { type: 'string' },
            deleted: { type: 'boolean' },
            close_failed: { type: 'boolean' },
            checkpoints: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  checkpoint_id: { type: 'string' },
                  image: { type: 'number' },
                  open: { type: 'boolean' },
                  bytes: { type: 'number' },
                  created_at: { type: 'string' },
                },
              },
            },
          },
        },
        annotations: {
          title: 'Manage GIMP Checkpoints',
          readOnlyHint: false,
          // op=restore permanently closes the image it replaces; op=delete permanently removes a
          // checkpoint file — either can happen from this one tool, same posture gimp_filter takes.
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      handler: async (args) => {
        await ensureSwept();
        return gimpCheckpoint(gimp, args, registry);
      },
    },
  ];
}
