import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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
 * `gimp_save_xcf` uses, to a file inside this factory's OWN checkpoint
 * directory (see "Storage" below) instead of a caller-supplied path — the
 * `.xcf` branch of the bridge's `op_export` keeps every live filter
 * re-editable via the ledger parasite (`ops.py:1231-1238`), so a restored
 * checkpoint is not just pixels. `restore` dispatches `open` on that file,
 * then `close` on the image the checkpoint is replacing. `list`/`delete`
 * touch only the in-memory registry and (for delete) the filesystem —
 * `list` never talks to the bridge at all, and `create`'s only bridge calls
 * are an optional `ping` (see `refreshOpenness`) and the `export` itself.
 *
 * Disk-backed on purpose, not an in-memory duplicate: an in-memory copy dies
 * in the exact event checkpoints exist for — a timeout or crash tree-kills
 * the whole GIMP process (`session.ts`'s `gimp_session_restarted`), which
 * would take an in-memory checkpoint down with it. A file on disk survives
 * that, so `restore` still works right after the model sees
 * `gimp_session_restarted` — it just reopens the file; a fresh GIMP session
 * starts under it the same way any other bridge call would restart one.
 *
 * Storage: each factory instance (registry) owns exactly one directory,
 * `checkpoints-<pid>-<uuid>`, created lazily inside `tempPath()` the first
 * time a checkpoint is actually created (never at factory construction —
 * that would need a live GIMP install just to register the tool). Every
 * checkpoint file for this registry lives inside it as `<checkpoint-id>.xcf`.
 * On process exit, this factory's whole directory is removed (one shared
 * `exit` listener across every factory instance, not one per instance — see
 * `registerDirForExitCleanup`). A directory left behind by a process that
 * crashed or was killed before its own exit hook could run is swept the
 * next time a checkpoint is created, matched by name and confirmed dead by
 * pid liveness (never by age) — see `sweepStaleCheckpointDirs`.
 *
 * The registry is a plain `Map` living in this factory's closure. A host
 * that builds this factory once per server process gets one registry for
 * the process's whole lifetime; a host that builds tools fresh per client
 * session gets one registry per session, already isolated — but any
 * per-session file cleanup there still only happens at whole-process exit,
 * not at individual session teardown, since there is no per-session
 * lifecycle hook this factory can hook into today. Every record's `image`
 * field tracks the CURRENT image this checkpoint is a snapshot ancestor of:
 * at `create` time it's the source image; after each `restore` it's updated
 * to the freshly reopened image (and every SIBLING record pointing at the
 * same replaced image moves with it — see `repointSiblings`), so a later
 * restore of any of them closes the right (post-restore) image rather than
 * one already gone.
 *
 * GIMP process restarts are told apart via `GimpBackend.generation` (backed
 * by `GimpSession`'s own restart counter — see session.ts). Every record is
 * stamped with the generation current at `create` time; `restore` compares
 * it against `gimp.generation` at restore time. A DIFFERENT generation means
 * the process that had `record.image` open is confirmed gone — its number,
 * if it refers to anything at all in the new process, belongs to some
 * unrelated image the model may still be using, so restore never issues a
 * `close` for it. `generation` is OPTIONAL on the backend (an older backend
 * that never reports one keeps working): when either side is `undefined`,
 * this file falls back to a baseline — the `oldImage === opened.image` guard
 * in `checkpointRestore`, plus the message-classified tolerance in
 * `isSessionRestartedError` / `isImageAlreadyClosedError` — which is safe
 * but strictly weaker (it cannot tell a genuinely reused id from the same
 * image still open). `refreshOpenness` below uses generation too, for an
 * EXACT across-restart staleness check, ahead of its own same-process `ping`
 * check (itself skipped when GIMP isn't already known to be running, so
 * `list` never cold-starts a GIMP process just to answer a read).
 *
 * No absolute paths or usernames ever reach a tool result — `record.path`
 * lives under the user's own temp/home directory and is used only to talk to
 * the bridge or the filesystem, never returned in `content` or
 * `structuredContent`. A raw filesystem error (mkdir/rm on this factory's own
 * directory) is never forwarded verbatim either — Node's own error text
 * names the absolute path, so every catch here replaces it with a fixed,
 * path-free message instead.
 */

/** Refuse the 6th `create` for one image rather than silently evicting the oldest. */
export const MAX_CHECKPOINTS_PER_IMAGE = 5;

/** Exported for `cleanupCheckpointDirs` / `sweepStaleCheckpointDirs`'s own unit tests — see
 * tests/tools/gimp-checkpoint-tools.test.ts. */
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
   * own image's create cap or appears under that image's scoped `list`.
   */
  open: boolean;
  /** `gimp.generation` at the moment this record's `image` was last (re)assigned — `undefined`
   * when the backend doesn't expose one. Compared against the CURRENT `gimp.generation` at
   * restore time to tell "the same GIMP process, image still open" apart from "a different
   * process that reused this same low integer id" — see this file's header comment. */
  generation: number | undefined;
  /** `true` from the moment `create` reserves this id until its `export` call resolves.
   * `restore`/`delete` refuse a pending id (its file may not exist yet); `list` reports it. */
  pending: boolean;
  /** Absolute path under this factory's own checkpoint directory — never surfaced to the model. */
  path: string;
  bytes: number;
  createdAt: string;
}

/** One factory instance's worth of checkpoint state: the registry plus its (lazily created)
 * storage directory. Tracked at module scope so the exit-time cleanup below can sweep every
 * instance's directory with a single shared listener. */
export interface CheckpointStore {
  registry: Map<string, CheckpointRecord>;
  dir: string | undefined;
  /** Set only once `sweepStaleCheckpointDirs` has run WITHOUT throwing — a thrown sweep leaves
   * this `false` so the next `create` call retries it, rather than silently giving up forever. */
  sweepDone: boolean;
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
        "working once the close succeeds — see 'close_failed' below for when it doesn't). " +
        "'list' reports every checkpoint (optionally scoped to one image): checkpoint_id, the " +
        'image it currently belongs to (open: false if that image is confirmed gone — still ' +
        'restorable; pending: true while still being created), created_at, bytes — never a file ' +
        "path. 'delete' removes one, freeing its slot.",
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
 * Refreshes every record's `open` belief. Two checks:
 *
 * 1. EXACT, across restarts: when both the record's stamped generation and the backend's current
 *    one are known, a mismatch proves the process that had `record.image` open is gone, no matter
 *    what `ping` says now (a reused id can look "open" in a brand-new process too — see this
 *    file's header comment). No round trip needed for this half, so it always runs.
 * 2. Best-effort, within one un-restarted process: a live `ping`'s open-images list catches a
 *    plain `gimp_close_document` elsewhere. Skipped entirely when the registry is empty; when
 *    `requireAlreadyRunning` is set and no GIMP session is currently up (`gimp.state !== 'ready'`),
 *    this never dispatches a call at all — a read (`list`) must never be what cold-starts GIMP.
 *    A failing `ping` is tolerated (caught, not thrown) and re-runs the generation check
 *    afterward, since the failure itself may have discovered (and bumped past) a dead session.
 *
 * See `CheckpointRecord.open`'s own doc comment for why both checks only ever narrow belief
 * (`true` -> `false`), never widen it.
 */
async function refreshOpenness(
  gimp: GimpBackend,
  registry: Map<string, CheckpointRecord>,
  opts: { requireAlreadyRunning: boolean }
): Promise<void> {
  if (registry.size === 0) return;
  const applyGenerationCheck = (): void => {
    const currentGeneration = gimp.generation;
    if (currentGeneration === undefined) return;
    for (const record of registry.values()) {
      if (
        record.open &&
        record.generation !== undefined &&
        record.generation !== currentGeneration
      ) {
        record.open = false;
      }
    }
  };
  applyGenerationCheck();
  if (opts.requireAlreadyRunning && gimp.state !== 'ready') return;
  let ping: { images?: number[] };
  try {
    ping = await gimp.call<{ images?: number[] }>('ping', {});
  } catch {
    applyGenerationCheck();
    return;
  }
  if (!Array.isArray(ping.images)) return;
  const openIds = new Set(ping.images);
  for (const record of registry.values()) {
    if (record.open && !openIds.has(record.image)) record.open = false;
  }
}

/** After a CONFIRMED close of `from` (restore's own `close` call actually succeeded — proof, not
 * a guess, that no restart raced it), every OTHER checkpoint still pointing at `from` is a
 * snapshot of the same now-transformed lineage, so it moves to `to` right along with the one
 * being restored. `generation` scopes this to siblings from the SAME generation as the one just
 * closed — when known, a different-generation record that happens to share the same stale image
 * number is a coincidence, not the same lineage, and must not be re-pointed onto a document it
 * has nothing to do with. When generation is NOT known (the baseline path), a sibling already
 * marked gone for some other reason is left alone too, rather than incorrectly reviving it just
 * because its stale number matches. `newGeneration` is stamped onto every record this moves,
 * since they now describe an image live in THAT generation. */
function repointSiblings(
  registry: Map<string, CheckpointRecord>,
  from: number,
  to: number,
  generation: number | undefined,
  newGeneration: number | undefined
): void {
  for (const sibling of registry.values()) {
    if (sibling.image !== from) continue;
    if (generation !== undefined) {
      if (sibling.generation !== generation) continue;
    } else if (sibling.open === false) {
      continue;
    }
    sibling.image = to;
    sibling.open = true;
    sibling.generation = newGeneration;
  }
}

/** After `from` is confirmed gone WITHOUT a fresh image to move sibling records to (a tolerated
 * "already gone" close, or a confirmed dead generation), every OTHER checkpoint still pointing at
 * `from` (in the same `generation`, when known — see `repointSiblings`'s own comment on why that
 * scoping matters) is marked gone too — its own file is still fully restorable, but its
 * bookkeeping no longer claims a specific live image. Deliberately NOT re-pointed to the
 * just-opened image: that image is a live continuation of the ONE checkpoint actually being
 * restored, not of these unrelated siblings' own (different) file content. */
function markSiblingsGone(
  registry: Map<string, CheckpointRecord>,
  image: number,
  generation: number | undefined
): void {
  for (const sibling of registry.values()) {
    if (sibling.image !== image) continue;
    if (generation !== undefined && sibling.generation !== generation) continue;
    sibling.open = false;
  }
}

/** Matches this factory's own checkpoint-store directory name: `checkpoints-<pid>-<uuid>`,
 * digits then a v4-shaped UUID — strict on purpose, so nothing else in the same parent directory
 * is ever mistaken for one. */
const STORE_DIR_NAME_RE =
  /^checkpoints-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `process.kill(pid, 0)` sends no signal — it only probes whether the pid exists and is
 * signalable. Mirrors `GimpSession`'s own identical liveness check for its session directories. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process — safe to reclaim. Anything else (e.g. EPERM, meaning it exists but
    // we lack permission to signal it) is treated as alive: sweeping is a cleanup convenience,
    // never worth a false positive against a process that's actually still running.
    return (err as { code?: string }).code !== 'ESRCH';
  }
}

/**
 * Removes sibling `checkpoints-<pid>-<uuid>` directories under `parentDir` whose pid is confirmed
 * dead — leftovers from a process that crashed or was killed before its own exit hook could run.
 * Never by age: a directory's pid being this process's own already protects it (this process is
 * definitionally alive), so `ownDir` is an extra, explicit belt-and-suspenders check, not the
 * only one. Matched strictly by name; checked with `lstatSync` (never dereferenced), and anything
 * that isn't a real directory under that lstat — a symlink included — is left untouched.
 */
export function sweepStaleCheckpointDirs(parentDir: string, ownDir: string): void {
  // Deliberately NOT try/caught here: a genuine failure to even list `parentDir` is the caller's
  // (`maybeSweepSiblingDirs`'s) job to catch and retry later — see its own doc comment. Only
  // PER-ENTRY failures below are swallowed, since one bad entry should never stop the rest of the
  // sweep.
  const entries = readdirSync(parentDir);
  for (const name of entries) {
    const match = STORE_DIR_NAME_RE.exec(name);
    if (!match) continue;
    const path = join(parentDir, name);
    if (path === ownDir) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    let isDir: boolean;
    try {
      isDir = lstatSync(path).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (isPidAlive(pid)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Removes every directory in `dirs` outright — used both directly by the shared `exit` listener
 * below and by tests. Synchronous because an `exit` handler cannot await, and because a test
 * asserting "the directory is gone afterward" wants that to already be true the moment this call
 * returns. Swallows a removal failure (EPERM/EBUSY — a file inside it another process still has
 * open) rather than throwing, the same posture `GimpSession`'s own session-directory cleanup
 * takes.
 */
export function cleanupCheckpointDirs(dirs: Iterable<string>): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort — the process is on its way out either way */
    }
  }
}

/** Every checkpoint directory this process has ever created, module-scoped so the actual
 * `process.once('exit', ...)` listener below is registered exactly ONCE per process no matter how
 * many factory instances exist — see `registerDirForExitCleanup`. */
const trackedDirs = new Set<string>();
let exitCleanupRegistered = false;

/** Tracks `dir` for the shared exit-time sweep, registering the ONE process-wide listener the
 * first time this runs and never again — avoids accumulating one `exit` listener per factory
 * instance (Node's own `MaxListenersExceededWarning` past 10, for a host that builds this
 * factory's tools fresh per client session and creates many of them over its lifetime). */
function registerDirForExitCleanup(dir: string): void {
  trackedDirs.add(dir);
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once('exit', () => cleanupCheckpointDirs(trackedDirs));
}

/** Lazily creates (once) and returns this store's own checkpoint directory. Never runs at
 * factory-construction time — that would need a resolved GIMP install just to register the tool
 * — only on the first actual `create`, inside the handler's own try/catch. A raw mkdir failure
 * (permissions, a full disk) is rethrown as a path-free `GimpError` rather than forwarding
 * Node's own message, which would name the absolute path. */
async function ensureStoreDir(gimp: GimpBackend, store: CheckpointStore): Promise<string> {
  if (store.dir !== undefined) return store.dir;
  await gimp.prepare(); // a late-found install must be in place before tempPath runs
  const dir = gimp.tempPath(`checkpoints-${process.pid}-${randomUUID()}`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    throw new GimpError('gimp_op_failed', 'could not create the checkpoint storage directory.');
  }
  store.dir = dir;
  registerDirForExitCleanup(dir);
  return dir;
}

/** Runs `sweepStaleCheckpointDirs` at most once per store, and only once it has ever SUCCEEDED —
 * a thrown sweep (e.g. the parent directory briefly unreadable) leaves `sweepDone` false so the
 * next `create` call retries it, rather than a transient failure permanently disabling cleanup
 * for this process's whole lifetime. Best-effort by design: never lets a sweep failure fail the
 * `create` call it rides along with. */
export function maybeSweepSiblingDirs(store: CheckpointStore, dir: string): void {
  if (store.sweepDone) return;
  try {
    sweepStaleCheckpointDirs(dirname(dir), dir);
    store.sweepDone = true;
  } catch {
    /* best effort — retried on the next create call since sweepDone stays false */
  }
}

async function checkpointCreate(
  gimp: GimpBackend,
  args: Record<string, unknown>,
  store: CheckpointStore
): Promise<ToolResult> {
  const { registry } = store;
  const image = args.image;
  if (typeof image !== 'number') {
    throw new GimpError('invalid_argument', '"image" is required for op=create.');
  }
  const dir = await ensureStoreDir(gimp, store);
  maybeSweepSiblingDirs(store, dir);
  await refreshOpenness(gimp, registry, { requireAlreadyRunning: false });
  // ---- Synchronous from here to the reservation below: no `await` runs between the cap check
  // and placing the reservation in the registry, so two concurrent creates for the same image
  // can never both pass the check before either one counts against the cap. ----
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
  const path = join(dir, `${id}.xcf`);
  const createdAt = new Date().toISOString();
  registry.set(id, {
    id,
    image,
    path,
    bytes: 0,
    createdAt,
    open: true,
    pending: true,
    generation: gimp.generation,
  });
  // ---- async again: the reservation above is what makes this safe to await ----
  try {
    const result = await gimp.call<{ bytes: number }>('export', { image, path });
    const record = registry.get(id);
    if (!record) {
      // Cannot happen in practice — nothing else can remove a still-pending reservation before
      // this resolves — but never crash on a broken invariant.
      throw new GimpError('gimp_op_failed', `checkpoint "${id}" vanished from the registry.`);
    }
    record.bytes = result.bytes;
    record.pending = false;
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
    // A failed export leaves nothing behind: no registry entry, and no partial file — the exit
    // hook and the directory-level sweep would eventually mop up a leftover file too, but a
    // failed create's own file is removed immediately rather than waiting for either.
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
  store: CheckpointStore
): Promise<ToolResult> {
  const { registry } = store;
  // list is registry-only: it must never be what cold-starts a GIMP process just to answer a
  // read, so the ping half of refreshOpenness only runs when a session is already up.
  await refreshOpenness(gimp, registry, { requireAlreadyRunning: true });
  const image = args.image;
  const scoped = typeof image === 'number';
  const filtered = [...registry.values()].filter((r) => {
    if (!scoped) return true;
    // A gone record's CURRENT `.image` number no longer denotes a live document, so it does not
    // belong under a scoped-by-image listing — it still appears in the unscoped list below,
    // marked open: false.
    return r.image === image && r.open;
  });
  const checkpoints = filtered.map((r) => ({
    checkpoint_id: r.id,
    image: r.image,
    open: r.open,
    pending: r.pending,
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

/** Shared by restore/delete: both require a `checkpoint_id` naming a KNOWN, non-pending record. */
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
  if (record.pending) {
    throw new GimpError(
      'invalid_argument',
      `checkpoint "${checkpointId}" is still being created — try again shortly.`
    );
  }
  return record;
}

async function checkpointDelete(
  args: Record<string, unknown>,
  store: CheckpointStore
): Promise<ToolResult> {
  const { registry } = store;
  const record = requireKnownCheckpoint(args, 'delete', registry);
  try {
    await rm(record.path, { force: true });
  } catch {
    // Node's own error names the absolute path (EPERM/EBUSY carry it in `.message`) — never let
    // that reach the model; the checkpoint_id is the only identifier it needs anyway.
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
  store: CheckpointStore
): Promise<ToolResult> {
  const { registry } = store;
  const record = requireKnownCheckpoint(args, 'restore', registry);
  let opened: { image: number; width: number; height: number };
  try {
    opened = await gimp.call<{ image: number; width: number; height: number }>('open', {
      path: record.path,
    });
  } catch (openError) {
    if (openError instanceof GimpError && openError.code === 'file_not_found') {
      // The checkpoint file itself is gone (removed out of band, or a leftover directory this
      // process's own sweep reclaimed) — there is nothing left to ever restore from, so the
      // record is dropped rather than kept around permanently broken.
      registry.delete(record.id);
      throw new GimpError(
        'invalid_argument',
        `checkpoint "${record.id}"'s file is missing; it has been removed and can no longer be restored.`
      );
    }
    throw openError;
  }
  const oldImage = record.image;
  const oldGeneration = record.generation;
  const currentGeneration = gimp.generation;
  const generationsKnown = oldGeneration !== undefined && currentGeneration !== undefined;
  const generationChanged = generationsKnown && oldGeneration !== currentGeneration;
  let closeNote: string;
  let closeFailed = false;

  if (oldImage === opened.image) {
    // The id GIMP just handed back for the reopened file happens to equal the id this record
    // remembers as "the image to close" — closing it would destroy the image restore just
    // opened. Checked first, unconditionally: this stays the last line of defense even when
    // generation is known, since a generation match plus an id match still means "definitely the
    // same image" and closing it would be equally wrong.
    closeNote = `image ${oldImage} is the id restore just reopened — nothing to close`;
    if (generationChanged) {
      // Even though this record itself needs no close, any OTHER sibling still bookkept against
      // the same stale number, from the SAME now-dead generation, is confirmed gone too.
      markSiblingsGone(registry, oldImage, oldGeneration);
    }
  } else if (generationChanged) {
    // EXACT (not a guess): the process that had oldImage open is confirmed gone. Its number, if
    // it refers to anything at all in the CURRENT process, belongs to some entirely unrelated
    // image the model may still be using — never touch it.
    closeNote =
      `image ${oldImage} belonged to a GIMP process that has since restarted — left untouched ` +
      `(its number may now belong to a different, unrelated image)`;
    markSiblingsGone(registry, oldImage, oldGeneration);
  } else {
    // Same generation, or generation isn't reachable on this backend — fall back to attempting
    // the close and classifying the result, same as before generation existed.
    try {
      await gimp.call('close', { image: oldImage });
      closeNote = `image ${oldImage} closed`;
      repointSiblings(registry, oldImage, opened.image, oldGeneration, currentGeneration);
    } catch (closeError) {
      // Whatever the close failed with, check FIRST whether the process that just handed us
      // `opened.image` is ALSO now gone — reporting success (however the failure would otherwise
      // be classified below, including as a normally-tolerated "already gone") would hand the
      // model a new image id that is itself already stale. The checkpoint file is untouched, so
      // a retry against whatever process is running by then still works.
      const generationAfterClose = gimp.generation;
      if (
        currentGeneration !== undefined &&
        generationAfterClose !== undefined &&
        generationAfterClose !== currentGeneration
      ) {
        throw new GimpError(
          'gimp_op_failed',
          `the GIMP process restarted while restoring checkpoint "${record.id}" — the checkpoint ` +
            'file itself is unaffected; retry gimp_checkpoint op=restore with the same checkpoint_id.'
        );
      }
      if (isSessionRestartedError(closeError)) {
        closeNote = `image ${oldImage} was already gone (the GIMP session had restarted)`;
        markSiblingsGone(registry, oldImage, oldGeneration);
      } else if (isImageAlreadyClosedError(closeError)) {
        // Genuinely just closed (by gimp_close_document, or an earlier restore) — no restart
        // implied, so say so plainly rather than reusing the restart wording.
        closeNote = `image ${oldImage} was already closed`;
        markSiblingsGone(registry, oldImage, oldGeneration);
      } else {
        // The failure must not swallow the fact that restore itself DID succeed — the new image
        // is open and the model needs its id regardless. Leave every sibling's bookkeeping
        // untouched: this failure gives no information about whether oldImage is still open.
        closeFailed = true;
        const msg = closeError instanceof Error ? closeError.message : String(closeError);
        closeNote = `image ${oldImage} could not be closed (${msg}) — it is still open`;
      }
    }
  }

  // Unconditional: whatever happened to the old image, THIS record now describes the freshly
  // opened one, live in the CURRENT generation.
  record.image = opened.image;
  record.generation = currentGeneration;
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
  store: CheckpointStore
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
    if (op === 'create') return await checkpointCreate(gimp, args, store);
    if (op === 'list') return await checkpointList(gimp, args, store);
    if (op === 'delete') return await checkpointDelete(args, store);
    return await checkpointRestore(gimp, args, store);
  } catch (error) {
    return toolGimpErrorResult('Error managing GIMP checkpoint', error);
  }
}

export function createGimpCheckpointTools(gimp: GimpBackend): ToolDefinition[] {
  // One store per factory call — one per server process for a host that builds this factory once
  // at boot; one per client session for a host that builds tools fresh per session, already
  // isolated from each other since each gets its own Map and its own directory. Checkpoints
  // persist across calls for the life of whichever process/session constructed this factory.
  const store: CheckpointStore = { registry: new Map(), dir: undefined, sweepDone: false };

  return [
    {
      tool: {
        name: 'gimp_checkpoint',
        description:
          'Headless GIMP: disk-backed checkpoints — the substitute for undo in a session that has ' +
          "none. op=create exports the image's CURRENT state, every live filter included, to a " +
          'snapshot file and returns a checkpoint_id. op=restore reopens that snapshot as a NEW ' +
          'image and closes the old one — replace semantics, not a copy: the old image id stops ' +
          'working once the close succeeds (if it fails instead — reported as close_failed: true ' +
          '— the old image stays open, and both ids are valid). It returns the new image id and ' +
          'says so plainly, e.g. "image N closed; restored as image M — use M from now on". A ' +
          'checkpoint survives a GIMP crash or timeout: restore reopens the FILE, not anything the ' +
          'crashed process held, so it still works right after a gimp_session_restarted error — ' +
          "that is the whole point of keeping it on disk instead of in GIMP's own memory. Each " +
          `image holds at most ${MAX_CHECKPOINTS_PER_IMAGE} checkpoints; a checkpoint whose own ` +
          "image has since closed doesn't count against a different image that later reuses the " +
          'same number. A 6th op=create for the same still-open image REFUSES outright rather ' +
          'than silently evicting the oldest — delete one first (op=delete) or list them ' +
          '(op=list) to see what exists. Checkpoint files are kept while this server runs and ' +
          'removed when it exits; files left by a server that crashed are removed the next time ' +
          'a checkpoint is made. op=list reports checkpoint_id, the image it currently belongs ' +
          'to, created_at, and its size in bytes — never a file path (a full path carries the ' +
          'username) — plus open: false for a checkpoint whose image has since closed (still ' +
          "restorable; just excluded from that image's own scoped list and cap) and pending: " +
          'true while a create is still in flight. An unknown checkpoint_id on restore or delete ' +
          'is refused, naming every checkpoint_id that IS known.',
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
                  pending: { type: 'boolean' },
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
      handler: async (args) => gimpCheckpoint(gimp, args, store),
    },
  ];
}
