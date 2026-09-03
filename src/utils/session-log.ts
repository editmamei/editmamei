import { mkdir, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Logger } from './logger.js';
import { VERSION } from '../version.js';
import { EDITION } from '../edition.js';

/**
 * Per-session NDJSON tool-call log.
 *
 * Every MCP `tools/call` appends one line to `~/.editmamei/sessions/<id>.ndjson`
 * with the tool name, args, success/error, and duration. This is the evidence
 * layer the template system (Phase 3) will pull from when synthesizing
 * recipes, and it doubles as a debugging aid — "which tools did Claude call
 * during yesterday's edit?" becomes one `tail` away.
 *
 * Append is fire-and-forget: a write failure is logged to stderr but never
 * blocks or throws into the tool-call path. The log is local-only; no upload.
 *
 * ## Schema v2 (Phase 2a, 2026-06-10)
 *
 * Two line types, discriminated by `type`:
 *
 * **`type: 'meta'`** — emitted once at boot (mcp_client populated after the
 * MCP initialize handshake; see `SessionLog.setMcpClientGetter`). Re-emitted
 * when `ps_version` becomes known. Readers take the last meta line as
 * authoritative.
 *
 * **`type: 'call'`** — per tool call. Self-contained so multi-session NDJSON
 * concatenations are analysable with `jq` / grep without cross-file joins.
 * New fields vs v1: `seq`, per-line context scalars (`editmamei_version`,
 * `edition`, `platform`, `ps_version`), `result_bytes`, hoisted
 * `structuredContent` flags, `error_class`, `retry_signal`, optional `result`.
 *
 * Readers encountering a v2 line that is missing `type` should treat it as a
 * v1 `'call'` line (backward-compat note preserved in the schema-version
 * constant comment).
 *
 * ## Privacy hardening (2026-05-31 — unchanged in v2)
 *
 * Schema version field for future schema-change detection; string args are
 * recursively walked so nested blobs over the cap get truncated; `homedir()`
 * prefixes inside string values are replaced with a `~` placeholder so a
 * user who shares a log line for support doesn't unknowingly leak their OS
 * username (or, on Windows, their full Users\<name> path layout).
 */

/** Bumped when the on-disk NDJSON line shape changes in a breaking way. */
export const SESSION_LOG_SCHEMA_VERSION = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Line types
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionLogMetaEntry {
  v: 2;
  type: 'meta';
  ts: string;
  session_id: string;
  editmamei_version: string;
  edition: string;
  platform: string;
  ps_version: string | null;
  mcp_client: { name: string; version: string } | null;
}

export interface SessionLogCallEntry {
  v: 2;
  type: 'call';
  ts: string;
  session_id: string;
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  duration_ms: number;
  editmamei_version: string;
  edition: string;
  platform: string;
  ps_version: string | null;
  result_bytes: number;
  // Hoisted from structuredContent when present (omitted when the tool is EXEMPT or didn't return context):
  active_layer_after?: string;
  doc_layer_count_after?: number;
  target_was_copy?: boolean;
  background_promoted?: boolean;
  // Error classification — omitted for successful calls; a failed call
  // always carries a real token, never the empty string (see append()):
  error_class?: string | null;
  // True when tool + deep-equal args match the immediately preceding call line:
  retry_signal: boolean;
  // Full result (behind EDITMAMEI_LOG_RESULTS=1 env var; omitted by default for privacy):
  result?: unknown;
  // Error message (same as v1, present on failed calls):
  error?: string;
}

/** Union of all line types. */
export type SessionLogEntry = SessionLogMetaEntry | SessionLogCallEntry;

export interface SessionLogOptions {
  /** Override the default `~/.editmamei/sessions/` directory (used in tests).
   *  Takes priority over the `EDITMAMEI_SESSION_LOG_DIR` env var below. */
  dir?: string;
  /**
   * Per-string-arg cap before truncation. The `ps_execute_script`
   * tool can ship multi-kilobyte code bodies; without a cap, the NDJSON
   * grows unboundedly. Default 2048 chars per arg field. Set 0 to disable.
   */
  maxArgStringLen?: number;
  /**
   * Replace the running user's home-dir prefix with `~` (POSIX) /
   * `~\` (Windows) inside string args before writing them to disk.
   * Defaults true — users frequently share log lines with support and
   * `C:\Users\amber\Pictures\…` carries their first name. Pass `false`
   * to disable (rarely useful outside tests).
   */
  redactHomedir?: boolean;
}

const DEFAULT_MAX_ARG_STR_LEN = 2048;

/**
 * Cooldown before `ensureHandle()` retries the append-mode `open()` after a
 * failure (S1). A permanent latch meant one transient EMFILE / AV-lock /
 * permission blip killed session logging for the rest of the process —
 * this bounds the blackout to a fixed window instead. Module const (not
 * per-instance config) since it's a fixed policy, not something callers
 * tune.
 */
const OPEN_RETRY_COOLDOWN_MS = 30_000;

const logger = new Logger('SessionLog');

/**
 * `EDITMAMEI_SESSION_LOG_DIR`, but empty/whitespace-only doesn't count as set.
 * A trimmed truthiness check (not `??`) — `??` only guards `null`/`undefined`,
 * so `EDITMAMEI_SESSION_LOG_DIR=""` (a stray blank env var, common from a
 * shell export left with no value, or a CI/launcher template that didn't
 * substitute) would otherwise resolve `join('', 'foo')`-style paths relative
 * to `process.cwd()` — silently relocating session logs away from
 * `~/.editmamei/sessions/` to wherever the process happened to be launched
 * from, instead of falling back to the real default.
 */
function sessionLogDirEnv(): string | undefined {
  const raw = process.env.EDITMAMEI_SESSION_LOG_DIR;
  return raw !== undefined && raw.trim() !== '' ? raw : undefined;
}

/**
 * Generate a human-sortable, collision-resistant session ID:
 * `2026-05-27T17-38-19Z-a3f2` — ISO-ish timestamp (filesystem-safe colons
 * replaced with hyphens) plus a 4-char random suffix.
 */
export function generateSessionId(now: Date = new Date()): string {
  const iso = now
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/-\d{3}Z$/, 'Z');
  const suffix = randomBytes(2).toString('hex');
  return `${iso}-${suffix}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ordered table of error-class patterns, first match wins.
 *
 * Every message this table sees arrives WRAPPED in a tool-handler prefix
 * ("Error selecting layer: <cause>"), so all patterns are substring matches
 * on the cause, never anchored to the start. Class tokens must satisfy the
 * telemetry server's `^[a-z0-9_]{1,48}$` contract (`normalizeErrorClass`
 * clamps defensively, but conforming here keeps the wire token readable).
 *
 * Tier ordering (specific state before generic outcome):
 *   target-not-found → input errors → app/session state → layer-state
 *   preconditions → PS-native outcomes → generic "<op> failed:" wrapper.
 * The generic wrapper is LAST on purpose: "Select Subject failed: <PS
 * tail>" carries the diagnostic content in the tail, so the tail's class
 * (unavailable / timeout / general error) must win over the wrapper's.
 *
 * The target-not-found tier is FIRST among the real classes because those
 * messages END IN USER DATA: the engine names the layer/group that was
 * asked for and lists the ones that exist. A layer called "invalid crop
 * guide" or "must be dodged" would otherwise be classified by whatever the
 * user happened to name their layer — `invalid_argument`'s vocabulary is
 * ordinary English, so this is reachable in a real document, and it fails
 * toward a CONFIDENTLY wrong class rather than an honest `other`. Nothing
 * in the later tiers announces a missing target, so hoisting costs nothing.
 * (One residual exception, accepted: the empty-envelope phrase rule above
 * still precedes this tier, so a layer literally named "failed with no
 * message" in the suffix would steer its miss to `ps_empty_error` — the
 * synthetics' phrases are distinctive enough that this stays theoretical.)
 * Within the tier the patterns are narrow and quote the engine's own
 * wording for the same reason: `/layer.*not found/` used to match "Error
 * applying layer style: Font not found: Futura" and steal it from
 * `font_not_found`.
 *
 * `ps_empty_error`'s phrase rule (the photoshop-api.ts empty-envelope
 * synthetics) is deliberately FIRST in the table: those messages narrate
 * several possible causes by name — a modal, "a prior timeout" (and
 * `/timed? ?out/` matches the bare word "timeout"), "no active
 * document" — so any cause-word class checked earlier would steal them.
 * The envelope being empty is the one thing actually known. Its
 * trailing-colon variant (a wrapper prefix whose PS cause was empty,
 * "Error deselecting: ") instead sits LAST before the generic wrapper, so
 * a specific cause always wins over mere emptiness.
 *
 * `timeout` is deliberately checked BEFORE `ps_modal_blocking` (Phase 3a,
 * 2026-07). `run-child.ts`'s reworded timeout message still names a modal
 * dialog as one *possible* cause (alongside a genuinely slow operation), so
 * without this ordering every timeout would still be misclassified as
 * `ps_modal_blocking` purely from the word "modal" appearing in the
 * message — the exact mis-attribution this fix is for: modal *detection*
 * does not exist in this product, and the incident that prompted this
 * ordering was a plain slow Camera Raw open, not a modal.
 */
export const ERROR_CLASS_TABLE: Array<{ errorClass: string; pattern: RegExp }> = [
  // ── Empty-envelope synthetics (must precede every cause-word class) ──────
  { errorClass: 'ps_empty_error', pattern: /returned an empty error|failed with no message/i },
  // ── Named-target-is-the-wrong-kind (hoisted for the same reason as the
  //    not-found tier below: the message embeds a user-chosen GROUP name, so
  //    at its natural wrong_layer_kind position a group called "Validation" or
  //    "must be dodged" would hand the row to schema_validation or
  //    invalid_argument. The phrase is fixed text from the delete-layer
  //    snippet, so matching it here is exact, not a heuristic. ─────────────
  { errorClass: 'wrong_layer_kind', pattern: /is a group, not an art layer/i },
  // ── Target not found (first — these messages end in user-chosen names) ───
  {
    errorClass: 'layer_not_found',
    // The quoted alternative is the pre-Go-migration shape. Bounded to the
    // quoted name rather than `.*` so it cannot span a whole message and
    // swallow a more specific class from the tail.
    pattern:
      /\blayer not found|no layer named|(?:layer_to_move|target_layer_name) not found|layer "[^"]*" not found/i,
  },
  { errorClass: 'group_not_found', pattern: /group not found/i },
  { errorClass: 'channel_not_found', pattern: /channel not found|channel named/i },
  { errorClass: 'path_not_found', pattern: /no path named|no paths to|no work path/i },
  { errorClass: 'font_not_found', pattern: /font not found/i },
  {
    errorClass: 'file_not_found',
    pattern: /file not found|map not found|lut not found|could not open lut/i,
  },
  { errorClass: 'face_not_found', pattern: /no face mesh|no face detected/i },
  // ── Perception pipeline (hoisted above the input tier for the same reason
  //    the not-found tier is: these messages quote a THIRD PARTY — a JPEG
  //    decoder, the ONNX runtime, the OS — whose wording collides with
  //    `invalid_argument`'s ordinary-English vocabulary. "failed to decode JPEG
  //    at C:/…: Invalid SOS parameters" was landing in `invalid_argument` on the
  //    word "Invalid", which is confidently wrong rather than honestly `other`;
  //    an ONNX load failure was landing in `ps_op_failed`, blaming Photoshop for
  //    a Node-side problem.
  //
  //    Each pattern matches text REACHABLE today — either a throw site in this
  //    tree or the dependency name a third party puts in its own message.
  //    Speculative alternations are deliberately absent: a pattern for a message
  //    nothing emits is untestable, and a pin written against one is a test that
  //    can only ever pass. Widen these when the throw site lands, not in
  //    anticipation of it. ──────────────────────────────────────────────────
  {
    errorClass: 'perception_export_failed',
    // detect-active-doc.ts — the perception export is read_scene's FIRST step
    // and the likeliest real failure in the whole pipeline.
    pattern: /saveAs reported success but no file/i,
  },
  // runtime.ts throws for JPEG only, and the perception export is always JPEG.
  // No PNG decode path exists, so there is no `png` alternation.
  { errorClass: 'image_decode_failed', pattern: /failed to decode jpeg/i },
  {
    errorClass: 'detection_unavailable',
    // The dependency NAME, because this text comes from someone else: Node's
    // module-resolution failure and onnxruntime's own errors both carry it, and
    // neither is a throw we control. The package is onnxruntime-WEB (WASM) —
    // there is no native -node addon in this tree.
    pattern: /onnxruntime|onnx runtime/i,
  },
  {
    // Case-SENSITIVE by design: these are OS error codes, and a case-insensitive
    // match would fire on ordinary prose containing the letters.
    errorClass: 'file_io',
    pattern: /\b(ENOENT|EBUSY|EACCES|EPERM|EMFILE|ENOSPC)\b/,
  },
  // ── Input errors ─────────────────────────────────────────────────────────
  // `unknownDiscriminator()` (tool-helpers.ts) builds this exact shape for
  // every consolidated dispatcher's unknown `type`/`op`/`mode` value: `unknown
  // <kind> "<value>". Allowed: <list>.` Hoisted ahead of `invalid_argument`
  // because that class's own `unknown [^:]{1,30}:` alternative only matches
  // when the kind+value happen to fit in 30 chars before a colon — this
  // message has no colon there at all (it closes on `". Allowed:`), so a long
  // kind or value silently fell to `other` depending on string length alone.
  {
    errorClass: 'unknown_discriminator',
    pattern: /unknown [\s\S]{1,60}"\. Allowed: /i,
  },
  {
    errorClass: 'schema_validation',
    pattern:
      /\bvalidat|required.*field|missing required argument|must be.*type|invalid (input|argument)/i,
  },
  {
    errorClass: 'invalid_argument',
    pattern: /unknown [^:]{1,30}:|invalid |illegal argument|must be |out of bounds|unsupported/i,
  },
  // ── App / session state ──────────────────────────────────────────────────
  { errorClass: 'ps_not_detected', pattern: /photoshop info not available/i },
  {
    errorClass: 'ps_not_running',
    pattern: /CreateObject|photoshop.*not.*running|cannot connect.*photoshop|connection.*failed/i,
  },
  { errorClass: 'no_document', pattern: /no active document|no document is open/i },
  { errorClass: 'no_active_layer', pattern: /no active layer|document has no layers/i },
  {
    errorClass: 'no_selection',
    pattern: /no active selection|requires an active selection|make a selection/i,
  },
  // ── Layer-state preconditions ────────────────────────────────────────────
  { errorClass: 'background_layer', pattern: /background layer/i },
  { errorClass: 'layer_locked', pattern: /is locked|fully locked|locked layer/i },
  {
    errorClass: 'wrong_layer_kind',
    pattern: /pixel layer|text layer|smart object layer|layer kind|rasterize it first/i,
  },
  // Camera Raw's mode preconditions (apply / adjust_existing) — three distinct
  // messages, one shared noun phrase.
  { errorClass: 'camera_raw_precondition', pattern: /camera raw smart filter/i },
  // Photoshop's own message when a script reads doc.histogram while the
  // active channel isn't the composite (see region-precompute.ts) — a
  // visibility STATE, not a missing channel, so it sits apart from
  // channel_not_found above rather than widening that pattern.
  { errorClass: 'channel_not_visible', pattern: /histogram for visible channels/i },
  // ── PS-native outcomes ───────────────────────────────────────────────────
  { errorClass: 'ps_command_unavailable', pattern: /not currently available/i },
  { errorClass: 'timeout', pattern: /timed? ?out|Script execution timeout|exceeded.*bytes/i },
  {
    errorClass: 'ps_modal_blocking',
    pattern: /modal.*dialog|dialog.*blocking|blocked.*modal|photoshop.*modal/i,
  },
  { errorClass: 'ai_selection_no_result', pattern: /returned no result/i },
  { errorClass: 'ps_general_error', pattern: /general photoshop error/i },
  { errorClass: 'ps_no_such_element', pattern: /no such element/i },
  // ExtendScript's own ReferenceError shape for an undefined global (`JSON`
  // inside a user script that assumes browser/Node JS, or a PS constant that
  // doesn't exist on this version). Anchored to end-of-string and restricted
  // to identifier characters so it can't fire on ordinary prose that happens
  // to end differently, e.g. "...actual undefined (after 2 retries)".
  { errorClass: 'extendscript_reference_error', pattern: /\b[A-Za-z_$][\w$]*\s+is undefined$/ },
  { errorClass: 'write_not_verified', pattern: /did not verify/i },
  // ── Empty cause / generic wrapper (keep last) ────────────────────────────
  { errorClass: 'ps_empty_error', pattern: /:\s*$/ },
  { errorClass: 'ps_op_failed', pattern: /failed[: (]/i },
];

/** Classify an error string into one of the known error classes. Returns null for success (no error). */
export function classifyError(error: string | undefined): string | null {
  if (error === undefined) return null;
  for (const { errorClass, pattern } of ERROR_CLASS_TABLE) {
    if (pattern.test(error)) return errorClass;
  }
  return 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// Result sanitization (EDITMAMEI_LOG_RESULTS=1 capture)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace inline base64 image payloads with a size marker. MCP image content
 * blocks (`{type:'image', data:<base64>, mimeType}`) are the dominant case —
 * a single `ps_get_preview` result carries hundreds of KB of base64
 * that would otherwise land verbatim on every captured line. The decoded
 * size estimate (3/4 of the base64 length) is kept so result-size analysis
 * still works from the captured line alone.
 *
 * @internal exported for unit tests only — not a stable public API.
 */
export function elideImagePayloads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(elideImagePayloads);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.type === 'image' && typeof obj.data === 'string') {
      const approxBytes = Math.floor((obj.data as string).length * 0.75);
      return { ...obj, data: `[image:${approxBytes} bytes]` };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = elideImagePayloads(v);
    }
    return out;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// result_bytes sizing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the exact number of characters `JSON.stringify` would emit for a
 * string `s` INSIDE its surrounding quotes — the escaped-string
 * contribution — without ever allocating the escaped string itself. A
 * single pass over the UTF-16 code units, mirroring the ECMA-262
 * `QuoteJSONString` abstract operation:
 *
 *   - `"` and `\` escape to a 2-char sequence (`\"` / `\\`).
 *   - `\b \t \n \f \r` escape to their named 2-char form.
 *   - Any other control char (< 0x20) escapes to `\u00XX` (6 chars).
 *   - A valid surrogate PAIR (a high surrogate immediately followed by a
 *     low surrogate — e.g. an emoji) is emitted VERBATIM: 2 code units, 2
 *     chars, no escaping. This is how astral-plane text round-trips
 *     through JSON.
 *   - A LONE surrogate (an unpaired high or low code unit) escapes to
 *     `\uXXXX` (6 chars) — the ES2019 "well-formed JSON.stringify"
 *     behavior that keeps the output valid UTF-16/WTF-8.
 *   - Everything else counts as 1 char (unescaped).
 *
 * `computeResultBytes` below is the (only) caller — it needs the byte
 * contribution of a `text` content-block payload WITHOUT handing that
 * payload to `JSON.stringify` itself (see its doc comment for why).
 *
 * @internal exported for unit tests only — not a stable public API.
 */
export function jsonEscapedLength(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) {
      len += 2; // " or \
    } else if (c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) {
      len += 2; // \b \t \n \f \r
    } else if (c < 0x20) {
      len += 6; // other control char → \u00XX
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate. A valid pair with the NEXT code unit prints
      // verbatim (2 chars total across both units, consumed together); a
      // lone high surrogate escapes to \uXXXX (6 chars).
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        len += 2;
        i++; // consume the low surrogate as part of this pair
      } else {
        len += 6;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      len += 6; // lone low surrogate (not preceded by a high that paired with it)
    } else {
      len += 1;
    }
  }
  return len;
}

/**
 * Compute the byte count `JSON.stringify(result).length` would report,
 * without ever handing an embedded base64/text payload to `JSON.stringify`
 * itself. A `ps_get_preview` / `ps_detect` result can carry hundreds of KB
 * of inline base64 — stringifying the raw result just to measure it builds
 * and discards a transient string that size on every single call.
 *
 * Only the well-known MCP `content: ContentBlock[]` shape is walked
 * selectively (checked structurally up front — not by stringifying first
 * to see how big it is). For each `{type:'text', text}` / `{type:'image',
 * data}` block, the payload field is blanked to `''` before the rest of
 * the (now-small) result is stringified, and the payload's real
 * contribution to the serialized length is added back afterward:
 *
 *   - `text` uses `jsonEscapedLength()` — most handlers emit pretty-printed
 *     JSON *inside* a text block, and `JSON.stringify` escapes `"` `\`
 *     and control chars (2 or 6 chars each) when it re-serializes that
 *     string, so a raw `.length` undercounts almost every real result.
 *     `jsonEscapedLength` reproduces the exact escaped length without
 *     allocating the escaped string.
 *   - `data` (base64 image payload) uses the raw `.length` — the base64
 *     alphabet (`A-Z a-z 0-9 + / =`) contains no character JSON ever
 *     needs to escape, so escaped length === raw length there. (If this
 *     ever carries non-base64 binary-as-string data, that assumption
 *     breaks — it doesn't today.)
 *
 * This reproduces the exact byte count a full stringify would have
 * produced. Any other block shape, and anything outside `content`
 * (structuredContent, isError, …), rides along in that same small
 * stringify call — those never carry base64 or large escape-heavy text,
 * so the cost is negligible.
 *
 * Results without a `content` array at all (small/unknown shapes) fall
 * straight through to a plain `JSON.stringify(result).length` — cheap
 * because there's no known payload field to spare it from.
 *
 * @internal exported for unit tests only — not a stable public API.
 */
export function computeResultBytes(result: unknown): number {
  if (result === undefined) return 0;
  if (result === null || typeof result !== 'object') {
    return JSON.stringify(result).length;
  }

  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.content)) {
    return JSON.stringify(result).length;
  }

  let payloadBytes = 0;
  const preppedBlocks = r.content.map((block) => {
    if (block !== null && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        payloadBytes += jsonEscapedLength(b.text);
        return { ...b, text: '' };
      }
      if (b.type === 'image' && typeof b.data === 'string') {
        // Base64 charset never needs JSON escaping — see the doc comment
        // above. Raw .length is exact here, no jsonEscapedLength pass needed.
        payloadBytes += b.data.length;
        return { ...b, data: '' };
      }
    }
    return block; // unknown block shape — falls into the stringify below as-is
  });

  const { content: _omit, ...rest } = r;
  return payloadBytes + JSON.stringify({ ...rest, content: preppedBlocks }).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured content hoisting helpers
// ─────────────────────────────────────────────────────────────────────────────

interface HoistedContext {
  active_layer_after?: string;
  doc_layer_count_after?: number;
  target_was_copy?: boolean;
  background_promoted?: boolean;
}

function hoistContextScalars(result: unknown): HoistedContext {
  if (typeof result !== 'object' || result === null) return {};

  const r = result as Record<string, unknown>;

  // Hoist from structuredContent.context (the getContextInfo() payload):
  const sc = r.structuredContent as Record<string, unknown> | undefined;
  const ctx = sc?.context as Record<string, unknown> | undefined;

  const hoisted: HoistedContext = {};

  // active_layer_after: the active layer name after the operation.
  // Full getContextInfo() nests name under activeLayer.name; slim
  // getMinimalContextInfo() puts it at the flat key activeLayer_name.
  const activeLayerObj = ctx?.activeLayer as Record<string, unknown> | undefined;
  const layerName = activeLayerObj?.name ?? ctx?.activeLayer_name;
  if (typeof layerName === 'string') hoisted.active_layer_after = layerName;

  // doc_layer_count_after: TOP-LEVEL layer count only (doc.layers.length
  // does not recurse into groups — a group counts as 1 regardless of how
  // many layers it contains). Despite the name, this is NOT a total; a
  // layer landing inside an existing group leaves this value unchanged,
  // which is the exact "silent success" signature the Phase 4
  // layer-placement-bug fix (2026-07) targets. getContextInfo() nests it
  // under document.layerCount; document.total_layer_count (added in that
  // same fix) is the genuine recursive count, but is not currently hoisted
  // here — read it from structuredContent.context.document directly if
  // you need it.
  const documentObj = ctx?.document as Record<string, unknown> | undefined;
  const layerCount = documentObj?.layerCount;
  if (typeof layerCount === 'number') hoisted.doc_layer_count_after = layerCount;

  // target_was_copy (auto-duplicate-first pattern): did the op duplicate first?
  if (typeof sc?.target_was_copy === 'boolean') hoisted.target_was_copy = sc.target_was_copy;

  // background_promoted (background-auto-promote pattern): did the op promote the background layer?
  if (typeof sc?.background_promoted === 'boolean')
    hoisted.background_promoted = sc.background_promoted;

  return hoisted;
}

// ─────────────────────────────────────────────────────────────────────────────
// SessionLog class
// ─────────────────────────────────────────────────────────────────────────────

export class SessionLog {
  private readonly dir: string;
  private readonly sessionId: string;
  private readonly maxArgStringLen: number;
  private readonly redactHomedir: boolean;
  private readonly homedirPrefixes: readonly string[];
  private dirEnsured = false;
  private metaEmitted = false;
  private seq = 0;
  private psVersion: string | null = null;
  private lastCallKey: string | null = null; // JSON(tool+args) for retry detection
  private getMcpClientFn?: () => { name: string; version: string } | null | undefined;
  // Held append-mode handle, opened lazily on the first write and reused
  // for the rest of the session's lifetime instead of the previous
  // open→append→close cycle done on EVERY line (3
  // syscalls of handle churn per tool call). See ensureHandle/openHandle.
  private fileHandle: FileHandle | null = null;
  private openingHandle: Promise<FileHandle | null> | null = null;
  // ms-epoch of the most recent open() failure, or null if the last
  // attempt (if any) succeeded / none has happened yet. Used as a cooldown
  // gate (S1) rather than a permanent latch — see OPEN_RETRY_COOLDOWN_MS.
  private openFailedAt: number | null = null;
  private closed = false;
  // Every append is chained through this promise (S2) so concurrent
  // fire-and-forget writeLine() calls (the normal shape — server.ts calls
  // sessionLog.append() with `void`, never awaited) can never interleave
  // their appendFile() calls on the one shared handle. Each write both
  // waits for and extends the chain; writeLineNow() never throws, so the
  // chain itself never becomes a rejected promise.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(sessionId: string, opts: SessionLogOptions = {}) {
    this.sessionId = sessionId;
    // Directory resolution, in priority order: explicit constructor option (used
    // by tests that construct a SessionLog directly) → EDITMAMEI_SESSION_LOG_DIR
    // env var (the seam for tests that only construct a full EditmameiServer,
    // which builds its own SessionLog with no `dir` — see server.ts; matches this
    // repo's existing EDITMAMEI_MODELS_DIR / EDITMAMEI_CORE_BIN override
    // convention) → the real ~/.editmamei/sessions/ default.
    this.dir = opts.dir ?? sessionLogDirEnv() ?? join(homedir(), '.editmamei', 'sessions');
    this.maxArgStringLen =
      opts.maxArgStringLen === undefined ? DEFAULT_MAX_ARG_STR_LEN : opts.maxArgStringLen;
    this.redactHomedir = opts.redactHomedir !== false;
    // Cache the homedir variants once per session so the redaction hot
    // path doesn't re-resolve them per line. On macOS / Linux, homedir()
    // and its symlink-resolved realpath can differ (e.g. macOS:
    // /Users/alice vs /private/var/folders/... after some PS path
    // operations) — we cache both so realpath-form paths still redact.
    // Empty array disables redaction silently.
    this.homedirPrefixes = this.redactHomedir ? computeHomedirPrefixes() : [];
  }

  get path(): string {
    return join(this.dir, `${this.sessionId}.ndjson`);
  }

  /** The resolved sessions directory (constructor option → env override → default).
   *  Readers that must see the same tree this instance writes (e.g. the update
   *  notice's previous-session lookup) take this instead of re-deriving the path. */
  get directory(): string {
    return this.dir;
  }

  /**
   * Register a getter that returns the connected MCP client's identity.
   * Called lazily before the first meta-line emission, so the value is
   * populated by the time the initialize handshake has completed.
   */
  setMcpClientGetter(fn: () => { name: string; version: string } | null | undefined): void {
    this.getMcpClientFn = fn;
  }

  /**
   * Update the cached Photoshop version and re-emit the meta line.
   * Call once when the first successful PS connection identifies the version.
   * Readers take the last meta line as authoritative.
   */
  async setPsVersion(version: string): Promise<void> {
    if (this.psVersion === version) return;
    this.psVersion = version;
    await this.emitMeta();
  }

  private buildMetaEntry(): SessionLogMetaEntry {
    return {
      v: SESSION_LOG_SCHEMA_VERSION as 2,
      type: 'meta',
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      editmamei_version: VERSION,
      edition: EDITION,
      platform: process.platform,
      ps_version: this.psVersion,
      mcp_client: this.getMcpClientFn?.() ?? null,
    };
  }

  /** Write the meta line to disk. Fire-and-forget. */
  async emitMeta(): Promise<void> {
    // Latch BEFORE the await, not after. writeLine() yields, and append()'s
    // lazy emitter gates on this flag — so setting it afterwards let two
    // concurrent callers (setPsVersion's re-emit and append's first-emit) both
    // observe `false` and both write, producing two byte-identical meta lines
    // ~1ms apart (backlog §5.12, seen live in a v0.24.0 macOS session). Readers
    // take the LAST meta line as authoritative so the duplicate was harmless,
    // but it defeated the sequencing this flag exists to provide.
    //
    // Deliberate re-emits stay possible: setPsVersion calls emitMeta directly
    // and never consults the flag, which is the intended "meta changed" path.
    // Ordering is preserved by writeChain (appends run in call order), so the
    // meta line still lands before the call line of whichever caller skipped it.
    this.metaEmitted = true;
    await this.writeLine(JSON.stringify(this.buildMetaEntry()));
  }

  /**
   * Append one tool-call entry. Fire-and-forget — never throws.
   * Emits the meta line first if it hasn't been written yet (lazy-emit so
   * mcp_client is populated after the initialize handshake).
   *
   * @param entry  The call details from the tool-registry observer.
   * @param result The full result object returned by the handler (used for
   *               result_bytes, hoisted context scalars, and optional
   *               EDITMAMEI_LOG_RESULTS full capture).
   */
  async append(
    entry: {
      tool: string;
      args: Record<string, unknown>;
      success: boolean;
      duration_ms: number;
      error?: string;
    },
    result?: unknown
  ): Promise<void> {
    // Lazy meta emission — before any call line, and with mcp_client available.
    if (!this.metaEmitted) {
      await this.emitMeta();
    }

    const ts = new Date().toISOString();
    this.seq += 1;

    // Sanitized once, reused for both the retry key and the logged `args`
    // field below. `ps_execute_script` bodies can run to multi-KB — since
    // sanitizeArgs already caps every string field at maxArgStringLen (2048
    // by default), keying retry-detection off the sanitized args caps this
    // stringify too, instead of JSON.stringify-ing the raw, unbounded args
    // on every call just to build a comparison key. This does mean two
    // DIFFERENT raw calls whose args are identical up through the
    // truncation point (rare — most bodies diverge early) would now read as
    // a retry; deep-equality on the full raw args would catch that, but at
    // the cost of the exact unbounded stringify this change removes.
    const sanitizedArgs = this.sanitizeArgs(entry.args);

    // Retry detection: same tool + deep-equal (sanitized) args as the
    // immediately preceding call.
    const callKey = JSON.stringify({ tool: entry.tool, args: sanitizedArgs });
    const retrySignal = callKey === this.lastCallKey;
    this.lastCallKey = callKey;

    // result_bytes: byte count a full JSON.stringify(result) would report,
    // computed without ever stringifying an embedded base64/text payload
    // directly — see computeResultBytes.
    const resultBytes = computeResultBytes(result);

    // Hoist context scalars from structuredContent — fire-and-forget if it throws.
    let hoisted: HoistedContext = {};
    try {
      hoisted = hoistContextScalars(result);
    } catch {
      /* structural surprises must never break telemetry */
    }

    // A failed call must always carry a class — `classifyError` alone can't
    // promise that, because it only sees the error TEXT: a handler that
    // reports failure with no text (e.g. an isError result with no text
    // content block) gives it `undefined`, indistinguishable from the
    // "no error at all" input a SUCCESSFUL call also passes. `entry.success`
    // is the signal classifyError doesn't have, so the fallback lives here,
    // not in the classifier. Without it, a genuine failure logs with no
    // error_class field at all — the diagnostics bundle and any other reader
    // then sees a failure with nothing to act on.
    const errorClass = entry.success ? null : (classifyError(entry.error) ?? 'no_error_text');

    // Full result capture — only when EDITMAMEI_LOG_RESULTS=1 (off by default
    // for privacy). The captured copy goes through the SAME discipline as
    // args: inline base64 images elided to size markers first, then homedir
    // redaction + per-string truncation. result_bytes above is computed on
    // the RAW result, so size analysis is unaffected by the elision.
    const captureResult =
      process.env.EDITMAMEI_LOG_RESULTS === '1' && result !== undefined
        ? this.sanitizeValue(elideImagePayloads(result))
        : undefined;

    const full: SessionLogCallEntry = {
      v: SESSION_LOG_SCHEMA_VERSION as 2,
      type: 'call',
      ts,
      session_id: this.sessionId,
      seq: this.seq,
      tool: entry.tool,
      args: sanitizedArgs,
      success: entry.success,
      duration_ms: entry.duration_ms,
      editmamei_version: VERSION,
      edition: EDITION,
      platform: process.platform,
      ps_version: this.psVersion,
      result_bytes: resultBytes,
      ...hoisted,
      ...(errorClass !== null ? { error_class: errorClass } : {}),
      retry_signal: retrySignal,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      ...(captureResult !== undefined ? { result: captureResult } : {}),
    };

    await this.writeLine(JSON.stringify(full));
  }

  /**
   * Lazily open (once) the append-mode handle reused for every line in the
   * session, instead of the previous open→append→close cycle done per
   * line. Concurrent first-write callers share one in-flight open via
   * `openingHandle` so only one `open()` syscall happens no matter how
   * many calls race in before it resolves.
   *
   * Returns `null` when the log is closed, or the open failed within the
   * last `OPEN_RETRY_COOLDOWN_MS` — callers must treat `null` as "drop
   * this line silently"; the failure itself is warned once per failure
   * streak (at the point an open was attempted), not on every dropped
   * line, and not again on every retry the cooldown blocks (S1).
   */
  private ensureHandle(): Promise<FileHandle | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.fileHandle) return Promise.resolve(this.fileHandle);
    if (this.openFailedAt !== null) {
      if (Date.now() - this.openFailedAt < OPEN_RETRY_COOLDOWN_MS) {
        return Promise.resolve(null);
      }
      // Cooldown elapsed — clear the latch so the block below attempts a
      // fresh open() instead of degrading silently for the rest of the
      // session over what may have been a transient EMFILE / AV-lock blip.
      this.openFailedAt = null;
    }
    if (!this.openingHandle) {
      this.openingHandle = this.openHandle();
    }
    return this.openingHandle;
  }

  private async openHandle(): Promise<FileHandle | null> {
    try {
      if (!this.dirEnsured) {
        // 0o700 — readable / writable / executable by owner only on POSIX.
        // Closes the multi-user-host privacy gap: the session log can
        // contain free-text args that the redaction step doesn't catch,
        // so we don't want other local users to read them by default.
        // Windows ignores `mode` here — its ACLs default to user-only.
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        this.dirEnsured = true;
      }
      // Open once with 0o600 so the file is owner-readable only on POSIX
      // even on first creation, then hold this handle for the rest of the
      // session — appendFile() lacks a mode option, only fs.open sets the
      // mode when the file is created, and once the file exists a later
      // open() would inherit the existing perms anyway.
      const fh = await open(this.path, 'a', 0o600);
      this.fileHandle = fh;
      return fh;
    } catch (err) {
      this.openFailedAt = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`session-log open failed: ${msg}`);
      return null;
    } finally {
      this.openingHandle = null;
    }
  }

  /**
   * Write a single line to the NDJSON file. Fire-and-forget from the
   * caller's perspective (never throws), but NOT independent of other
   * writes: every call is chained onto `writeChain` (S2) so two
   * overlapping fire-and-forget `append()` calls — the normal shape, see
   * `writeChain`'s field comment — can never both be mid-`appendFile()` on
   * the shared handle at once. The returned promise resolves once THIS
   * line's write (in its serialized turn) has been attempted.
   */
  private writeLine(line: string): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.writeLineNow(line));
    return this.writeChain;
  }

  /** The actual write, run in turn by writeLine()'s chain. Never throws. */
  private async writeLineNow(line: string): Promise<void> {
    const fh = await this.ensureHandle();
    if (!fh) return; // closed, or the open is cooling down after a failure
    try {
      await fh.appendFile(line + '\n', 'utf8');
    } catch (err) {
      // Benign degrade for the fire-and-forget write-after-close race: if
      // `close()` closed this exact handle out from under an in-flight
      // write, appendFile rejects here rather than throwing into the
      // caller — same never-throw guarantee as any other write failure.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`session-log write failed: ${msg}`);
    }
  }

  /**
   * Close the held file handle, if one was ever opened. Idempotent, and
   * safe to call while a write is racing in: `closed` is set first (a
   * synchronous, immediate assignment) so any `writeLine` call that
   * hasn't yet grabbed the handle via `ensureHandle()` sees it and no-ops;
   * a write already mid-flight on the handle degrades through its own
   * try/catch in `writeLine` instead of throwing into the shutdown path.
   */
  async close(): Promise<void> {
    this.closed = true;
    const pending = this.openingHandle;
    if (pending) {
      await pending.catch(() => undefined);
    }
    const fh = this.fileHandle;
    this.fileHandle = null;
    if (fh) {
      try {
        await fh.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`session-log close failed: ${msg}`);
      }
    }
  }

  /**
   * Recursively walk an args payload and apply two transforms to every
   * string value found, no matter how deep:
   *
   *   1. **Homedir redaction.** A string whose value starts with the
   *      running user's home directory gets the prefix replaced with `~`.
   *      Matches case-insensitively on Windows (NTFS paths are
   *      case-insensitive but mixed-case in practice) and a few common
   *      forward-slash variants. Skips when the redaction is disabled
   *      via `redactHomedir: false` or when `homedir()` returns an
   *      empty string.
   *
   *   2. **Length truncation.** Strings over `maxArgStringLen` get the
   *      tail dropped and a `[truncated:N→M]` marker appended. The
   *      `ps_execute_script` `code` field is the worst offender
   *      at the top level; nested template / metadata blobs are the
   *      worst offenders inside objects.
   *
   * The previous shallow walk only handled top-level string values, so
   * nested blobs escaped the cap and unredacted paths slipped through
   * inside object / array args.
   */
  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    return this.sanitizeValue(args) as Record<string, unknown>;
  }

  private sanitizeValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.sanitizeString(value);
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.sanitizeValue(v));
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.sanitizeValue(v);
      }
      return out;
    }
    return value;
  }

  private sanitizeString(s: string): string {
    let out = s;
    for (const prefix of this.homedirPrefixes) {
      out = redactHomedirIn(out, prefix);
    }
    if (this.maxArgStringLen > 0 && out.length > this.maxArgStringLen) {
      out =
        out.slice(0, this.maxArgStringLen) + `…[truncated:${out.length}→${this.maxArgStringLen}]`;
    }
    return out;
  }
}

/**
 * Build the set of homedir prefix variants to scan args for.
 *
 * Returns:
 *   - The native-form `homedir()`.
 *   - The symlink-resolved realpath of the homedir, when it differs (macOS
 *     typically resolves `/Users/x` → `/private/var/.../x` on some paths).
 *   - On Windows, the forward-slash variant of each of the above (some PS
 *     tools normalize paths to `/` before passing them).
 *
 * Empty array if `homedir()` returns falsy.
 */
function computeHomedirPrefixes(): string[] {
  const home = homedir();
  if (!home) return [];
  const variants = new Set<string>();
  variants.add(home);
  // realpath may fail on weird mounts; degrade silently.
  try {
    const real = realpathSync(home);
    if (real && real !== home) variants.add(real);
  } catch {
    /* defensive */
  }
  if (process.platform === 'win32') {
    for (const v of [...variants]) {
      variants.add(v.replace(/\\/g, '/'));
    }
  }
  return [...variants];
}

/**
 * Replace every occurrence of `homedirPrefix` inside `s` with `~`, with
 * a word-boundary guard so a prefix `C:\Users\amber` does NOT corrupt a
 * sibling path like `C:\Users\amberbob\Documents` into `~bob\Documents`.
 * The char immediately after the matched prefix must be a path separator
 * (`/`, `\`) or end-of-string.
 *
 * Scans the whole string, not just the start — error messages and embedded
 * snippet bodies frequently mention the homedir mid-sentence. The previous
 * anchored `startsWith` missed those, leaving the username visible.
 *
 * Case-insensitive match on Windows (NTFS realities); POSIX is
 * case-sensitive to avoid over-redacting on case-sensitive filesystems.
 *
 * @internal exported for unit tests only — not a stable public API.
 */
export function redactHomedirIn(s: string, homedirPrefix: string): string {
  if (!homedirPrefix || !s) return s;
  const isWindows = process.platform === 'win32';
  const haystack = isWindows ? s.toLowerCase() : s;
  const needle = isWindows ? homedirPrefix.toLowerCase() : homedirPrefix;

  let out = '';
  let cursor = 0;
  while (cursor < s.length) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx < 0) {
      out += s.slice(cursor);
      break;
    }
    // Word-boundary: char after prefix must be a path separator or EOS.
    const after = idx + needle.length;
    const nextChar = after < s.length ? s[after] : '';
    const atBoundary = nextChar === '' || nextChar === '/' || nextChar === '\\';
    if (!atBoundary) {
      // Not a real homedir hit (e.g. `amber` matched inside `amberbob`).
      // Skip past this position and keep scanning.
      out += s.slice(cursor, idx + 1);
      cursor = idx + 1;
      continue;
    }
    out += s.slice(cursor, idx) + '~';
    cursor = after;
  }
  return out;
}
