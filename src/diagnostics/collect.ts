/**
 * Diagnostic-bundle collector.
 *
 * Assembles a content-free, user-shareable bundle when Editmamei misbehaves:
 * recent server logs (from the in-memory ring buffer), system info, a best-effort
 * tail of Claude Desktop's own MCP log, and a summary of recent tool calls. The
 * `ps_report_problem` tool and `editmamei report` CLI write it to the
 * user's Downloads folder so they can attach it to a bug report.
 *
 * Privacy contract (see docs/privacy.md, "Diagnostic reports" — same hard line as telemetry):
 *   - NO image/document content, NO tool arguments, NO full filesystem paths.
 *   - Every free-text line runs through `sanitizeMessage` (paths→basenames,
 *     home-dir redaction). Desktop-log lines additionally have JSON-RPC argument
 *     payloads and base64 blobs redacted, so neither tool arguments nor preview
 *     images can ride along.
 *   - The session summary keeps only `{seq, ts, tool, success, duration_ms,
 *     error_class}` — never the recorded `args`.
 * The only identifier is the anonymous `install_id` (a salted random id, not
 * derived from PII — same one telemetry uses).
 */

import { homedir, release as osRelease, arch as osArch, platform as osPlatform } from 'node:os';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { VERSION } from '../version.js';
import { EDITION } from '../edition.js';
import { loadSettings, settingsDir } from '../core/settings.js';
import { sanitizeMessage } from '../telemetry/sanitize.js';
import { sharedLogBuffer, type LogRingBuffer } from '../utils/log-buffer.js';
import { readSessionLog, listRecentSessionIds } from '../utils/session-log-reader.js';
import {
  classifyError,
  generateSessionId,
  type SessionLogCallEntry,
  type SessionLogMetaEntry,
} from '../utils/session-log.js';
import { detectDownloadsDir } from '../cli/downloads-dir.js';

export const DIAGNOSTIC_BUNDLE_SCHEMA = 1;
/** Where users file the bundle. */
export const ISSUES_URL = 'https://github.com/editmamei/editmamei/issues';

const MAX_LOG_LINES = 1000;
const MAX_DESKTOP_LOG_LINES = 400;
const MAX_RECENT_SESSIONS = 3;
const MAX_CALLS_PER_SESSION = 500;
const MAX_NOTE_LEN = 1000;
const MAX_LINE_LEN = 4000;
/** Desktop-log lines can carry full JSON-RPC frames; cap each hard after redaction. */
const MAX_DESKTOP_LINE_LEN = 1000;

export interface DiagnosticSessionCall {
  seq: number;
  ts: string;
  tool: string;
  success: boolean;
  duration_ms: number;
  error_class: string | null;
}

export interface DiagnosticSession {
  session_id: string;
  editmamei_version: string | null;
  ps_version: string | null;
  mcp_client: string | null;
  call_count: number;
  calls: DiagnosticSessionCall[];
}

export interface DiagnosticBundle {
  schema: number;
  report_id: string;
  editmamei_version: string;
  edition: string;
  platform: string;
  os_release: string;
  arch: string;
  node_version: string;
  install_id: string;
  ps_version: string | null;
  mcp_client: string | null;
  settings: {
    telemetry_usage: boolean;
    telemetry_diagnostics: boolean;
    update_check: boolean;
    send_previews_to_llm: boolean;
  };
  note: string | null;
  server_log: string[];
  desktop_log: string[];
  desktop_log_source: string | null;
  recent_sessions: DiagnosticSession[];
}

export interface CollectOptions {
  /** Optional user description of the problem (sanitized + capped, then embedded). */
  note?: string;
  /** Live Photoshop version when the caller knows it (server passes its cached value). */
  psVersion?: string | null;
  /** The log ring buffer to snapshot. Defaults to the process-wide shared buffer. */
  logBuffer?: LogRingBuffer;
  /** Override `~/.editmamei` (settings + sessions live under it). Tests only. */
  homeDir?: string;
  /** Override the Claude Desktop log directory. Tests only. */
  desktopLogDir?: string;
  /** Override `process.env` (tests). */
  env?: Record<string, string | undefined>;
  /** Override the report-id clock (tests). */
  now?: Date;
}

export interface WriteOptions {
  /** Override the destination directory (defaults to the user's Downloads folder). */
  downloadsDir?: string;
  env?: Record<string, string | undefined>;
}

export interface WriteResult {
  path: string;
  bytes: number;
}

function mcpClientLabel(meta: SessionLogMetaEntry | undefined): string | null {
  if (!meta?.mcp_client) return null;
  return `${meta.mcp_client.name} ${meta.mcp_client.version}`;
}

/** Assemble the bundle. Never throws on a missing/unreadable source — degrades to empty. */
export async function collectDiagnostics(opts: CollectOptions = {}): Promise<DiagnosticBundle> {
  const logBuffer = opts.logBuffer ?? sharedLogBuffer;
  const emHome = opts.homeDir ?? settingsDir();
  const { settings } = loadSettings(opts.homeDir ? { dir: opts.homeDir } : {});

  const server_log = logBuffer
    .snapshot()
    .slice(-MAX_LOG_LINES)
    .map((line) => sanitizeMessage(line, MAX_LINE_LEN));

  // Recent session summaries — content-free (no args), newest first.
  const sessionsDir = join(emHome, 'sessions');
  const recentIds = await listRecentSessionIds(MAX_RECENT_SESSIONS, { dir: sessionsDir });
  const recent_sessions: DiagnosticSession[] = [];
  let psVersion = opts.psVersion ?? null;
  let mcpClient: string | null = null;

  for (const id of recentIds) {
    const entries = await readSessionLog(id, { dir: sessionsDir });
    const meta = [...entries].reverse().find((e) => e.type === 'meta') as
      | SessionLogMetaEntry
      | undefined;
    const calls = entries.filter((e): e is SessionLogCallEntry => e.type === 'call');
    const reduced: DiagnosticSessionCall[] = calls.slice(-MAX_CALLS_PER_SESSION).map((c) => ({
      seq: c.seq,
      ts: c.ts,
      tool: c.tool,
      success: c.success,
      duration_ms: c.duration_ms,
      // Prefer the persisted classification; re-derive from the (already content-free)
      // error token if an older line lacks it. NEVER include the raw `args`.
      error_class: c.error_class ?? (c.success ? null : classifyError(c.error)),
    }));
    if (meta) {
      if (!psVersion && meta.ps_version) psVersion = meta.ps_version;
      if (!mcpClient) mcpClient = mcpClientLabel(meta);
    }
    recent_sessions.push({
      session_id: id,
      editmamei_version: meta?.editmamei_version ?? null,
      ps_version: meta?.ps_version ?? null,
      mcp_client: mcpClientLabel(meta),
      call_count: calls.length,
      calls: reduced,
    });
  }

  const desktop = await readDesktopLogTail({
    env: opts.env,
    overrideDir: opts.desktopLogDir,
  });

  return {
    schema: DIAGNOSTIC_BUNDLE_SCHEMA,
    report_id: generateSessionId(opts.now),
    editmamei_version: VERSION,
    edition: EDITION,
    platform: osPlatform(),
    os_release: osRelease(),
    arch: osArch(),
    node_version: process.version,
    install_id: settings.telemetry.install_id,
    ps_version: psVersion,
    mcp_client: mcpClient,
    settings: {
      telemetry_usage: settings.telemetry.usage,
      telemetry_diagnostics: settings.telemetry.diagnostics,
      update_check: settings.update_check,
      send_previews_to_llm: settings.privacy.send_previews_to_llm,
    },
    note: opts.note ? sanitizeMessage(opts.note, MAX_NOTE_LEN) : null,
    server_log,
    desktop_log: desktop.lines,
    desktop_log_source: desktop.source,
    recent_sessions,
  };
}

/** Write the bundle as pretty JSON (0600) to Downloads. Returns the path + byte size. */
export async function writeDiagnosticBundle(
  bundle: DiagnosticBundle,
  opts: WriteOptions = {}
): Promise<WriteResult> {
  const dest = opts.downloadsDir ?? detectDownloadsDir(opts.env ?? process.env).path;
  await mkdir(dest, { recursive: true });
  const path = join(dest, `editmamei-diagnostics-${bundle.report_id}.json`);
  const json = JSON.stringify(bundle, null, 2);
  await writeFile(path, json, { encoding: 'utf8', mode: 0o600 });
  return { path, bytes: Buffer.byteLength(json, 'utf8') };
}

interface DesktopLogResult {
  lines: string[];
  source: string | null;
}

/** Default Claude Desktop log directory per platform (null where unknown). */
export function defaultDesktopLogDir(
  env: Record<string, string | undefined> = process.env
): string | null {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'Claude');
  if (process.platform === 'win32') {
    const appData = env.APPDATA;
    return appData
      ? join(appData, 'Claude', 'logs')
      : join(homedir(), 'AppData', 'Roaming', 'Claude', 'logs');
  }
  return null;
}

const BASE64_RUN = /[A-Za-z0-9+/]{200,}={0,2}/g;
// A JSON-RPC frame line: "<prefix> Message from|to client|server: {<body>". The body
// is a full request/response payload — tool ARGUMENTS, result bodies carrying layer /
// document names, and base64 preview images. We keep only method + id + timing (the
// connection-debugging signal) and redact the ENTIRE body. Per-key redaction is not
// enough: args also ride under `params`, and result bodies aren't base64.
const JSONRPC_FRAME = /^(.*\bMessage (?:from|to) (?:client|server):\s*)(\{.*)$/;
// Secondary net for a non-frame line that still carries a payload object/array.
const PAYLOAD_OBJECT = /("(?:arguments|params|result|input)"\s*:\s*)([{[][\s\S]*)$/;

/**
 * Sanitize one Claude Desktop log line. JSON-RPC frame lines have their whole payload
 * body redacted (method + id + byte count retained); every other line is path/home
 * sanitized, has any stray payload object + long base64 run stripped, and is length
 * capped. Lifecycle and the `initialize` method/timing — the connection-debugging
 * signal — survive; no tool arguments, result content, or image data can ride along.
 *
 * Note: assumes Claude Desktop logs each JSON-RPC message on a single physical line
 * (confirmed against real logs). A hypothetical pre-split multi-line frame would have
 * its continuation lines fall to the secondary net rather than the frame path.
 */
export function sanitizeDesktopLogLine(line: string): string {
  const frame = JSONRPC_FRAME.exec(line);
  if (frame) {
    const prefix = sanitizeMessage(frame[1], MAX_LINE_LEN).replace(/\s+$/, '');
    const body = frame[2];
    const method = /"method"\s*:\s*"([^"]+)"/.exec(body)?.[1];
    const id = /"id"\s*:\s*("?[\w.-]+"?)/.exec(body)?.[1];
    const kind = method
      ? `method=${method}`
      : /"result"/.test(body)
        ? 'result'
        : /"error"/.test(body)
          ? 'error'
          : 'frame';
    return `${prefix} [${kind}${id ? ` id=${id}` : ''}, payload redacted, ${body.length} bytes]`;
  }
  let out = sanitizeMessage(line, MAX_LINE_LEN);
  out = out.replace(PAYLOAD_OBJECT, '$1<redacted>');
  out = out.replace(BASE64_RUN, '…[binary redacted]');
  if (out.length > MAX_DESKTOP_LINE_LEN) out = out.slice(0, MAX_DESKTOP_LINE_LEN) + '…[truncated]';
  return out;
}

async function readDesktopLogTail(opts: {
  env?: Record<string, string | undefined>;
  overrideDir?: string;
}): Promise<DesktopLogResult> {
  const dir = opts.overrideDir ?? defaultDesktopLogDir(opts.env ?? process.env);
  if (!dir) return { lines: [], source: null };

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { lines: [], source: null };
  }
  const logs = names.filter((f) => f.toLowerCase().endsWith('.log'));
  if (logs.length === 0) return { lines: [], source: null };

  // Prefer the editmamei-specific server log, then the general mcp.log, then any.
  const pick =
    logs.find((f) => /editmamei/i.test(f)) ??
    logs.find((f) => f.toLowerCase() === 'mcp.log') ??
    logs[0];

  try {
    const raw = await readFile(join(dir, pick), 'utf8');
    const tail = raw
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .slice(-MAX_DESKTOP_LOG_LINES)
      .map(sanitizeDesktopLogLine);
    return { lines: tail, source: pick };
  } catch {
    return { lines: [], source: null };
  }
}
