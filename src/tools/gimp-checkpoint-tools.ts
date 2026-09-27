import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
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
 * below and (for delete) the filesystem — no bridge round trip at all.
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
 * server process), keyed by checkpoint id. Every record's `image` field
 * tracks the CURRENT image this checkpoint is a snapshot ancestor of: at
 * `create` time it's the source image; after each `restore` it's updated to
 * the freshly reopened image, so a second restore of the same checkpoint
 * closes the right (post-restore) image rather than one already gone.
 *
 * No absolute paths or usernames ever reach a tool result — `record.path`
 * lives under the user's own temp/home directory and is used only to talk
 * to the bridge, never returned in `content` or `structuredContent`.
 */

/** Refuse the 6th `create` for one image rather than silently evicting the oldest. */
export const MAX_CHECKPOINTS_PER_IMAGE = 5;

interface CheckpointRecord {
  id: string;
  image: number;
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
        'to one image): checkpoint_id, the image it currently belongs to, created_at, bytes — never ' +
        "a file path. 'delete' removes one, freeing its slot.",
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

function isSessionGoneError(error: unknown): boolean {
  // Covers both the bridge's own wording ("no open image with id N") and
  // session.ts's own wrapped `gimp_session_restarted` phrasing ("that image
  // id is not open. The GIMP session restarted") — whichever one reaches
  // here depends on whether `restartNoticePending` was still set (see
  // session.ts:1040-1050), and restore's own preceding `open` call typically
  // clears that flag before this close runs, so the bridge's raw wording is
  // the common case.
  return error instanceof GimpError && /no open image|session restarted/i.test(error.message);
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
  const existing = [...registry.values()].filter((r) => r.image === image);
  if (existing.length >= MAX_CHECKPOINTS_PER_IMAGE) {
    throw new GimpError(
      'invalid_argument',
      `image ${image} already has ${MAX_CHECKPOINTS_PER_IMAGE} checkpoints, the maximum per image. ` +
        `Delete one first — gimp_checkpoint op=delete, checkpoint_id one of: ` +
        `${existing.map((r) => r.id).join(', ')} — or list them with op=list.`
    );
  }
  await gimp.prepare(); // a late-found install must be in place before tempPath runs
  const id = randomUUID();
  const path = gimp.tempPath(`checkpoint-${id}.xcf`);
  const result = await gimp.call<{ bytes: number }>('export', { image, path });
  const createdAt = new Date().toISOString();
  registry.set(id, { id, image, path, bytes: result.bytes, createdAt });
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
}

function checkpointList(
  args: Record<string, unknown>,
  registry: Map<string, CheckpointRecord>
): ToolResult {
  const image = args.image;
  const scoped = typeof image === 'number';
  const filtered = [...registry.values()].filter((r) => !scoped || r.image === image);
  const checkpoints = filtered.map((r) => ({
    checkpoint_id: r.id,
    image: r.image,
    bytes: r.bytes,
    created_at: r.createdAt,
  }));
  return {
    content: [
      {
        type: 'text' as const,
        text: `${checkpoints.length} checkpoint(s)${scoped ? ` for image ${image}` : ''}.`,
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
  await rm(record.path, { force: true });
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
  let closePhrase: string;
  try {
    await gimp.call('close', { image: oldImage });
    closePhrase = `image ${oldImage} closed`;
  } catch (closeError) {
    if (!isSessionGoneError(closeError)) throw closeError;
    closePhrase = `image ${oldImage} was already gone (the GIMP session had restarted)`;
  }
  // Replace-semantics bookkeeping: this checkpoint now belongs to the freshly
  // reopened image, so a LATER restore of the same checkpoint closes THIS
  // image, not the one just closed above.
  record.image = opened.image;
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `${closePhrase}; restored as image ${opened.image} ` +
          `(${opened.width}x${opened.height}) — use ${opened.image} from now on.`,
      },
    ],
    structuredContent: {
      checkpoint_id: record.id,
      old_image: oldImage,
      image: opened.image,
      width: opened.width,
      height: opened.height,
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
    if (op === 'list') return checkpointList(args, registry);
    if (op === 'delete') return await checkpointDelete(args, registry);
    return await checkpointRestore(gimp, args, registry);
  } catch (error) {
    return toolGimpErrorResult('Error managing GIMP checkpoint', error);
  }
}

export function createGimpCheckpointTools(gimp: GimpBackend): ToolDefinition[] {
  // One Map per factory call — one per server process (`gimpModule.register`
  // calls each factory exactly once at boot) — so checkpoints persist across
  // calls for the life of the server, per the tool's own contract.
  const registry = new Map<string, CheckpointRecord>();
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
          `${MAX_CHECKPOINTS_PER_IMAGE} checkpoints: a 6th op=create REFUSES outright rather than ` +
          'silently evicting the oldest — delete one first (op=delete) or list them (op=list) to ' +
          'see what exists. Every checkpoint file lives until this MCP server process shuts down, ' +
          'then it is gone; there is no separate cleanup step. op=list reports checkpoint_id, the ' +
          'image it currently belongs to, created_at, and its size in bytes — never a file path (a ' +
          'full path carries the username). An unknown checkpoint_id on restore or delete is ' +
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
            checkpoints: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  checkpoint_id: { type: 'string' },
                  image: { type: 'number' },
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
          openWorldHint: true,
        },
      },
      handler: async (args) => gimpCheckpoint(gimp, args, registry),
    },
  ];
}
