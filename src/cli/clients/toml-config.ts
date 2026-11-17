/**
 * Line-level editing of Editmamei's own table in a Codex `config.toml`.
 *
 * The file is shared by the ChatGPT desktop app, the Codex CLI and the Codex
 * IDE extension, and people keep comments, other servers and per-tool approval
 * tables in it. Parsing the whole document and writing it back would drop the
 * comments and reformat everything, so this module never does that. It finds
 * the `[mcp_servers.editmamei]` table and its sub-tables by their headers and
 * changes only the lines it owns; every other line is written back byte for
 * byte.
 *
 * Forms it will not edit: an `editmamei` entry written as dotted keys or as an
 * inline table under `[mcp_servers]`. Those are reported as unsupported so the
 * caller can ask the user to edit the file by hand, rather than guessed at.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { McpServerEntry } from './types.js';
import { SERVER_NAME } from './json-config.js';

/** Codex's own defaults are 10 s to start and 60 s per tool call; both are too short here. */
export const STARTUP_TIMEOUT_SEC = 60;
export const TOOL_TIMEOUT_SEC = 600;

const MAIN_PATH = ['mcp_servers', SERVER_NAME];

export interface TomlDoc {
  lines: string[];
  eol: '\n' | '\r\n';
  /** The file existed when it was read. */
  hadExisting: boolean;
}

export async function readTomlDoc(configPath: string): Promise<TomlDoc> {
  if (!existsSync(configPath)) return { lines: [], eol: '\n', hadExisting: false };
  const raw = await readFile(configPath, 'utf8');
  return parseDoc(raw, true);
}

export function parseDoc(raw: string, hadExisting = true): TomlDoc {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.length === 0 ? [] : raw.split(/\r?\n/);
  return { lines, eol, hadExisting };
}

export function renderDoc(doc: TomlDoc): string {
  return doc.lines.join(doc.eol);
}

/** Atomic write (temp file + rename), owner-only on POSIX, like the JSON configs. */
export async function writeTomlDoc(configPath: string, text: string): Promise<void> {
  const tmpPath = join(dirname(configPath), `.editmamei.toml-config.${process.pid}.tmp`);
  await writeFile(tmpPath, text, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(tmpPath, configPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------- scanning

/** A table header's key path, or null when the line is not a header. */
export function headerPath(line: string): string[] | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('[[')) return ['[['];
  const m = /^\[([^[\]]+)\]\s*(#.*)?$/.exec(trimmed);
  if (!m) return null;
  return splitKey(m[1]!);
}

/** Split a dotted key, dropping the quotes around quoted parts. */
function splitKey(key: string): string[] {
  const parts: string[] = [];
  const re = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(?:\.|$)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < key.length && (m = re.exec(key)) !== null) {
    const p = m[1]!;
    parts.push(p.startsWith('"') || p.startsWith("'") ? p.slice(1, -1) : p);
  }
  return parts;
}

function startsWithPath(path: string[], prefix: string[]): boolean {
  return prefix.every((p, i) => path[i] === p);
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && startsWithPath(a, b);
}

export interface Span {
  /** Header line index. */
  start: number;
  /** One past the table's last content line (trailing blank and comment lines excluded). */
  end: number;
  path: string[];
}

function tableSpans(lines: string[]): Span[] {
  const spans: Span[] = [];
  let open: Span | null = null;
  lines.forEach((line, i) => {
    const path = headerPath(line);
    if (path === null) return;
    if (open) spans.push(close(open, i, lines));
    open = { start: i, end: lines.length, path };
  });
  if (open) spans.push(close(open, lines.length, lines));
  return spans;
}

function close(span: Span, next: number, lines: string[]): Span {
  let end = next;
  while (end > span.start + 1 && /^\s*(#.*)?$/.test(lines[end - 1]!)) end--;
  return { ...span, end };
}

/** Editmamei's own tables: the main one and any `[mcp_servers.editmamei.*]`. */
export function ourSpans(lines: string[]): { main: Span | null; subs: Span[] } {
  let main: Span | null = null;
  const subs: Span[] = [];
  for (const s of tableSpans(lines)) {
    if (samePath(s.path, MAIN_PATH)) main = s;
    else if (startsWithPath(s.path, MAIN_PATH)) subs.push(s);
  }
  return { main, subs };
}

/**
 * True when the file holds something this module will not edit around:
 * - an editmamei entry as dotted keys at the top level
 *   (`mcp_servers.editmamei.command = ...`), or as an inline table or dotted
 *   keys inside `[mcp_servers]`;
 * - `mcp_servers` itself defined as a value (`mcp_servers = { ... }`), which
 *   a `[mcp_servers.editmamei]` table would then redefine;
 * - a multi-line string (`"""` or `'''`) inside Editmamei's tables, whose lines
 *   the line-level scan can't tell from keys and headers.
 */
export function hasUnsupportedForm(lines: string[]): boolean {
  let current: string[] = [];
  for (const line of lines) {
    const path = headerPath(line);
    if (path !== null) {
      current = path;
      continue;
    }
    if (startsWithPath(current, MAIN_PATH) && /"""|'''/.test(line)) return true;
    const key = keyOf(line);
    if (!key) continue;
    const full = [...current, ...key.path];
    if (current.length < 2 && startsWithPath(full, MAIN_PATH)) return true;
    if (full.length < MAIN_PATH.length && startsWithPath(MAIN_PATH, full)) return true;
  }
  return false;
}

/** The env keys of the main table written as dotted keys (`env.X = ...`). */
function hasDottedEnv(lines: string[], main: Span): boolean {
  for (let i = main.start + 1; i < main.end; i++) {
    const k = keyOf(lines[i]!);
    if (k && k.path.length > 1 && k.path[0] === 'env') return true;
  }
  return false;
}

interface KeyLine {
  path: string[];
  /** Index of the first character of the value. */
  valueAt: number;
}

function keyOf(line: string): KeyLine | null {
  const m =
    /^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=\s*/.exec(
      line
    );
  if (!m) return null;
  return { path: splitKey(m[1]!), valueAt: m[0].length };
}

/**
 * Number of lines a value spans, following open brackets and braces across
 * lines, never past `limit` (the end of its table), so an unclosed bracket in
 * a malformed file can't reach into the tables after it.
 */
function valueExtent(lines: string[], i: number, valueAt: number, limit: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let j = i; j < limit; j++) {
    const text = j === i ? lines[j]!.slice(valueAt) : lines[j]!;
    for (let k = 0; k < text.length; k++) {
      const c = text[k]!;
      if (quote) {
        if (c === '\\' && quote === '"') k++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '#') break;
      if (c === '"' || c === "'") quote = c;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
    }
    quote = null;
    if (depth <= 0) return j - i + 1;
  }
  return Math.max(1, limit - i);
}

interface KeyHit {
  line: number;
  count: number;
  value: string;
}

/** Find a top-level key inside a table span. */
function findKey(lines: string[], span: Span, key: string): KeyHit | null {
  for (let i = span.start + 1; i < span.end; i++) {
    const k = keyOf(lines[i]!);
    if (!k) continue;
    const count = valueExtent(lines, i, k.valueAt, span.end);
    if (k.path.length === 1 && k.path[0] === key) {
      const value = [lines[i]!.slice(k.valueAt), ...lines.slice(i + 1, i + count)].join('\n');
      return { line: i, count, value };
    }
    i += count - 1;
  }
  return null;
}

// ---------------------------------------------------------------- values

/** A TOML basic string. JSON's string escapes are a valid subset of TOML's. */
export function tomlString(s: string): string {
  return JSON.stringify(s);
}

function tomlStringArray(items: string[]): string {
  return `[${items.map(tomlString).join(', ')}]`;
}

function tomlInlineTable(entries: [string, string][]): string {
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([k, v]) => `${bareOrQuoted(k)} = ${tomlString(v)}`).join(', ')} }`;
}

function bareOrQuoted(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** Every string literal in a value, in order. Null if anything else is in the way. */
function stringsIn(value: string): string[] | null {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    if (m[2] !== undefined) out.push(m[2]);
    else {
      try {
        out.push(JSON.parse(`"${m[1]}"`) as string);
      } catch {
        return null;
      }
    }
  }
  return out;
}

function stripComment(value: string): string {
  // Comments after a value: good enough for the single-line values we compare.
  const m = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^#"'])*)/.exec(value);
  return (m ? m[1]! : value).trim();
}

function parseCommand(value: string): string | null {
  const v = stripComment(value);
  const strings = stringsIn(v);
  return strings && strings.length === 1 && /^["']/.test(v) ? strings[0]! : null;
}

function parseArgs(value: string): string[] | null {
  const v = value
    .split('\n')
    .map((l) => stripComment(l))
    .join(' ');
  if (!v.startsWith('[')) return null;
  return stringsIn(v);
}

/** Pairs of an inline table of strings (`{ A = "x", B = 'y' }`), or null if it is anything else. */
function parseInlineStringTable(value: string): [string, string][] | null {
  const v = stripComment(value);
  if (!v.startsWith('{') || !v.endsWith('}')) return null;
  const body = v.slice(1, -1).trim();
  if (body === '') return [];
  const out: [string, string][] = [];
  const re =
    /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(,|$)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < body.length && (m = re.exec(body)) !== null) {
    const k = splitKey(m[1]!)[0]!;
    const s = stringsIn(m[2]!);
    if (!s || s.length !== 1) return null;
    out.push([k, s[0]!]);
    if (m[3] === '') break;
  }
  return re.lastIndex >= body.length || body.slice(re.lastIndex).trim() === '' ? out : null;
}

// ---------------------------------------------------------------- edits

export type EditOutcome = { kind: 'ok'; doc: TomlDoc } | { kind: 'unsupported'; detail: string };

export const UNSUPPORTED_DETAIL =
  'config.toml defines mcp_servers or editmamei as dotted keys or an inline table, or ' +
  'has a multi-line string in the editmamei table. Rewrite it as an ' +
  '[mcp_servers.editmamei] table, or edit it by hand.';

/**
 * Set Editmamei's entry. Owned keys (`command`, `args`, and each env key we set)
 * are rewritten; the timeouts are added only when missing, so a value the user
 * chose survives; everything else in the table and its sub-tables is kept.
 */
export function upsertEntry(doc: TomlDoc, entry: McpServerEntry): EditOutcome {
  const lines = [...doc.lines];
  if (hasUnsupportedForm(lines)) return { kind: 'unsupported', detail: UNSUPPORTED_DETAIL };

  const { main, subs } = ourSpans(lines);
  const envEntries = Object.entries(entry.env ?? {});
  if (main && envEntries.length > 0 && hasDottedEnv(lines, main)) {
    return {
      kind: 'unsupported',
      detail:
        'The env of [mcp_servers.editmamei] is written as dotted keys (env.NAME = ...). ' +
        'Set the variables by hand.',
    };
  }

  if (!main) {
    const block = [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${tomlString(entry.command)}`,
      `args = ${tomlStringArray(entry.args ?? [])}`,
      `startup_timeout_sec = ${STARTUP_TIMEOUT_SEC}`,
      `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
    ];
    const envSub = subs.find((s) => samePath(s.path, [...MAIN_PATH, 'env']));
    if (envEntries.length > 0 && !envSub) block.push(`env = ${tomlInlineTable(envEntries)}`);
    // Drop trailing empty lines, then separate the new table with one blank line.
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(...block, '');
    let next: TomlDoc = { ...doc, lines };
    if (envSub && envEntries.length > 0) {
      const r = setEnvInSubtable(next, envEntries);
      next = r;
    }
    return { kind: 'ok', doc: next };
  }

  const edits: { at: number; remove: number; insert: string[] }[] = [];
  const insertAfterHeader: string[] = [];

  const command = findKey(lines, main, 'command');
  const wantCommand = `command = ${tomlString(entry.command)}`;
  if (!command) insertAfterHeader.push(wantCommand);
  else if (parseCommand(command.value) !== entry.command) {
    edits.push({ at: command.line, remove: command.count, insert: [wantCommand] });
  }

  const args = findKey(lines, main, 'args');
  const wantArgs = `args = ${tomlStringArray(entry.args ?? [])}`;
  const currentArgs = args ? parseArgs(args.value) : null;
  if (!args) insertAfterHeader.push(wantArgs);
  else if (!currentArgs || !sameArray(currentArgs, entry.args ?? [])) {
    edits.push({ at: args.line, remove: args.count, insert: [wantArgs] });
  }

  if (!findKey(lines, main, 'startup_timeout_sec')) {
    insertAfterHeader.push(`startup_timeout_sec = ${STARTUP_TIMEOUT_SEC}`);
  }
  if (!findKey(lines, main, 'tool_timeout_sec')) {
    insertAfterHeader.push(`tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`);
  }

  const envSub = subs.find((s) => samePath(s.path, [...MAIN_PATH, 'env']));
  if (envEntries.length > 0 && !envSub) {
    const env = findKey(lines, main, 'env');
    if (!env) insertAfterHeader.push(`env = ${tomlInlineTable(envEntries)}`);
    else {
      const pairs = parseInlineStringTable(env.value);
      if (!pairs) {
        return {
          kind: 'unsupported',
          detail:
            'The env value of [mcp_servers.editmamei] is not a one-line table of strings. ' +
            'Set the variables by hand.',
        };
      }
      const merged = new Map(pairs);
      for (const [k, v] of envEntries) merged.set(k, v);
      const wantEnv = `env = ${tomlInlineTable([...merged])}`;
      if (!sameArray(pairs.flat(), [...merged].flat())) {
        edits.push({ at: env.line, remove: env.count, insert: [wantEnv] });
      }
    }
  }

  if (insertAfterHeader.length > 0) {
    edits.push({ at: main.start + 1, remove: 0, insert: insertAfterHeader });
  }
  applyEdits(lines, edits);

  let next: TomlDoc = { ...doc, lines };
  if (envSub && envEntries.length > 0) next = setEnvInSubtable(next, envEntries);
  return { kind: 'ok', doc: next };
}

function setEnvInSubtable(doc: TomlDoc, envEntries: [string, string][]): TomlDoc {
  const lines = [...doc.lines];
  const sub = ourSpans(lines).subs.find((s) => samePath(s.path, [...MAIN_PATH, 'env']));
  if (!sub) return doc;
  const inserts: string[] = [];
  const edits: { at: number; remove: number; insert: string[] }[] = [];
  for (const [k, v] of envEntries) {
    const want = `${bareOrQuoted(k)} = ${tomlString(v)}`;
    const hit = findKey(lines, sub, k);
    if (!hit) inserts.push(want);
    else {
      const current = stringsIn(stripComment(hit.value));
      if (!current || current.length !== 1 || current[0] !== v) {
        edits.push({ at: hit.line, remove: hit.count, insert: [want] });
      }
    }
  }
  if (inserts.length > 0) edits.push({ at: sub.start + 1, remove: 0, insert: inserts });
  applyEdits(lines, edits);
  return { ...doc, lines };
}

/**
 * Apply edits from the bottom up so earlier indexes stay valid. At the same
 * index a replacement goes before an insertion, or the insertion would be the
 * line the replacement removes.
 */
function applyEdits(lines: string[], edits: { at: number; remove: number; insert: string[] }[]) {
  edits.sort((a, b) => b.at - a.at || b.remove - a.remove);
  for (const e of edits) lines.splice(e.at, e.remove, ...e.insert);
}

/** Remove the main table and every `[mcp_servers.editmamei.*]` sub-table. */
export function removeEntry(doc: TomlDoc): { doc: TomlDoc; removed: boolean } {
  const lines = [...doc.lines];
  const { main, subs } = ourSpans(lines);
  const spans = [...(main ? [main] : []), ...subs].sort((a, b) => b.start - a.start);
  for (const s of spans) {
    let start = s.start;
    // Take the blank line that separated the table from the one before it.
    if (start > 0 && lines[start - 1]!.trim() === '') start--;
    lines.splice(start, s.end - start);
  }
  return { doc: { ...doc, lines }, removed: spans.length > 0 };
}

/** The registered command line, for `editmamei status`. */
export function describeEntry(doc: TomlDoc): string | null {
  const { main } = ourSpans(doc.lines);
  if (!main) return null;
  const command = findKey(doc.lines, main, 'command');
  const args = findKey(doc.lines, main, 'args');
  const cmd = command ? parseCommand(command.value) : null;
  const argv = args ? parseArgs(args.value) : null;
  return `${cmd ?? '?'} ${(argv ?? []).join(' ')}`.trim();
}

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
