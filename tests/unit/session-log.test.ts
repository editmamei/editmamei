import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@editmamei/utils/logger.ts';
import {
  SessionLog,
  SESSION_LOG_SCHEMA_VERSION,
  generateSessionId,
  redactHomedirIn,
  classifyError,
  computeResultBytes,
  jsonEscapedLength,
  ERROR_CLASS_TABLE,
  type SessionLogMetaEntry,
  type SessionLogCallEntry,
} from '@editmamei/utils/session-log.ts';

// Wrap `open` (not the other fs/promises functions this file also uses
// directly, like mkdtemp/readFile/rm/stat) so the "held handle" tests below
// can assert exactly how many times it was called, while every fs
// operation — including SessionLog's own mkdir/open calls — still runs for
// real against the temp dirs created per test.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function readAllLines(path: string): Promise<unknown[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

async function readCallLines(path: string): Promise<SessionLogCallEntry[]> {
  const all = await readAllLines(path);
  return all.filter((e): e is SessionLogCallEntry => (e as { type: string }).type === 'call');
}

async function readMetaLines(path: string): Promise<SessionLogMetaEntry[]> {
  const all = await readAllLines(path);
  return all.filter((e): e is SessionLogMetaEntry => (e as { type: string }).type === 'meta');
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema version pin. Bumping it should be an explicit, reviewable change —
// readers branch on this value to detect breaking shape changes.
// ─────────────────────────────────────────────────────────────────────────────

describe('SESSION_LOG_SCHEMA_VERSION', () => {
  it('is 2 today', () => {
    expect(SESSION_LOG_SCHEMA_VERSION).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateSessionId
// ─────────────────────────────────────────────────────────────────────────────

describe('generateSessionId', () => {
  it('produces an ISO-ish, filesystem-safe identifier with a random suffix', () => {
    const id = generateSessionId(new Date('2026-05-27T17:38:19.815Z'));
    expect(id).toMatch(/^2026-05-27T17-38-19Z-[0-9a-f]{4}$/);
  });

  it('two consecutive IDs at the same instant differ', () => {
    const now = new Date();
    const a = generateSessionId(now);
    const b = generateSessionId(now);
    expect(a).not.toBe(b);
  });

  it('contains no colon or dot (safe for Windows filenames)', () => {
    const id = generateSessionId(new Date());
    expect(id).not.toContain(':');
    expect(id).not.toContain('.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyError
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyError', () => {
  it('returns null when no error (success case)', () => {
    expect(classifyError(undefined)).toBeNull();
  });

  it('classifies schema_validation errors', () => {
    expect(classifyError('Validation failed: field required')).toBe('schema_validation');
    expect(classifyError('required field missing')).toBe('schema_validation');
    expect(classifyError('must be string type')).toBe('schema_validation');
    expect(classifyError('invalid input provided')).toBe('schema_validation');
  });

  it('classifies layer_not_found errors', () => {
    expect(classifyError('layer "Background" not found')).toBe('layer_not_found');
    expect(classifyError('no layer named Retouching')).toBe('layer_not_found');
  });

  it('classifies ps_command_unavailable errors', () => {
    expect(classifyError('command not currently available')).toBe('ps_command_unavailable');
  });

  it('classifies ps_modal_blocking errors', () => {
    expect(classifyError('modal dialog is open')).toBe('ps_modal_blocking');
    expect(classifyError('blocked by modal')).toBe('ps_modal_blocking');
    expect(classifyError('Photoshop modal is blocking')).toBe('ps_modal_blocking');
  });

  it('classifies ps_not_running errors', () => {
    expect(classifyError('CreateObject failed')).toBe('ps_not_running');
    expect(classifyError('Photoshop is not running')).toBe('ps_not_running');
    expect(classifyError('cannot connect to Photoshop')).toBe('ps_not_running');
    expect(classifyError('connection failed to establish')).toBe('ps_not_running');
  });

  it('classifies timeout errors', () => {
    expect(classifyError('timed out')).toBe('timeout');
    expect(classifyError('Script execution timeout exceeded')).toBe('timeout');
    expect(classifyError('exceeded 1024 bytes')).toBe('timeout');
  });

  // Phase 3a (2026-07): run-child.ts's reworded timeout message still names a
  // modal dialog as one POSSIBLE cause (alongside a genuinely slow
  // operation), so it would still match the ps_modal_blocking pattern on the
  // word "modal" alone. This pins the deliberate reclassification: a message
  // that is BOTH a timeout AND mentions modal wording classifies as
  // 'timeout', not 'ps_modal_blocking' — the investigated incident was a
  // plain slow Camera Raw open, not a modal, and modal *detection* doesn't
  // exist in this product. A message that reports a modal WITHOUT also being
  // a timeout (the case pinned above) still classifies ps_modal_blocking.
  it('classifies a reworded timeout message that also mentions a modal dialog as timeout, not ps_modal_blocking', () => {
    const message =
      'Script execution timeout after 30000ms (cscript wrapper.vbs). The child process was killed, ' +
      'but Photoshop runs as a separate process and may have kept executing — the operation could ' +
      "still have completed. Check Photoshop's actual state before retrying. Common causes: a " +
      "genuinely slow operation (e.g. a large RAW file's first Camera Raw engine init) exceeding the " +
      'timeout, or a modal dialog open in Photoshop (license, missing font, GPU init, "Discard?" ' +
      'prompt) — dismiss it if present.';
    expect(classifyError(message)).toBe('timeout');
  });

  it('returns other for unrecognized errors', () => {
    expect(classifyError('some weird error')).toBe('other');
    expect(classifyError('')).toBe('other');
  });

  it('ERROR_CLASS_TABLE has all expected classes', () => {
    const classes = ERROR_CLASS_TABLE.map((e) => e.errorClass);
    expect(classes).toContain('schema_validation');
    expect(classes).toContain('layer_not_found');
    expect(classes).toContain('ps_command_unavailable');
    expect(classes).toContain('ps_modal_blocking');
    expect(classes).toContain('ps_not_running');
    expect(classes).toContain('timeout');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// redactHomedirIn
// ─────────────────────────────────────────────────────────────────────────────

describe('redactHomedirIn', () => {
  it('returns the input unchanged when prefix is empty or input is empty', () => {
    expect(redactHomedirIn('', '/home/x')).toBe('');
    expect(redactHomedirIn('/home/x/file', '')).toBe('/home/x/file');
  });

  it('returns the input unchanged when the prefix does not match', () => {
    expect(redactHomedirIn('/etc/passwd', '/home/alice')).toBe('/etc/passwd');
  });

  it('replaces an exact native-form prefix match with ~', () => {
    if (process.platform === 'win32') {
      expect(redactHomedirIn('C:\\Users\\alice\\Pictures\\x.jpg', 'C:\\Users\\alice')).toBe(
        '~\\Pictures\\x.jpg'
      );
    } else {
      expect(redactHomedirIn('/home/alice/Pictures/x.jpg', '/home/alice')).toBe('~/Pictures/x.jpg');
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'on Windows, also matches forward-slash normalized variant',
    () => {
      expect(redactHomedirIn('C:/Users/alice/Photos/raw.dng', 'C:/Users/alice')).toBe(
        '~/Photos/raw.dng'
      );
    }
  );

  it.skipIf(process.platform !== 'win32')(
    'on Windows, the match is case-insensitive (NTFS reality)',
    () => {
      expect(redactHomedirIn('c:\\users\\Alice\\Pictures\\x.jpg', 'C:\\Users\\alice')).toBe(
        '~\\Pictures\\x.jpg'
      );
    }
  );

  it('does NOT redact when the prefix is a STRING prefix of another path component', () => {
    if (process.platform === 'win32') {
      expect(redactHomedirIn('C:\\Users\\amberbob\\Docs', 'C:\\Users\\amber')).toBe(
        'C:\\Users\\amberbob\\Docs'
      );
    } else {
      expect(redactHomedirIn('/home/amberbob/Docs', '/home/amber')).toBe('/home/amberbob/Docs');
    }
  });

  it('redacts the prefix when followed by a path separator (boundary held)', () => {
    if (process.platform === 'win32') {
      expect(redactHomedirIn('C:\\Users\\amber\\Docs', 'C:\\Users\\amber')).toBe('~\\Docs');
      expect(redactHomedirIn('C:\\Users\\amber/Docs', 'C:\\Users\\amber')).toBe('~/Docs');
    } else {
      expect(redactHomedirIn('/home/amber/Docs', '/home/amber')).toBe('~/Docs');
    }
  });

  it('redacts the prefix when it is the entire string (no trailing separator)', () => {
    const prefix = process.platform === 'win32' ? 'C:\\Users\\amber' : '/home/amber';
    expect(redactHomedirIn(prefix, prefix)).toBe('~');
  });

  it('redacts homedir occurrences inside an error-message-style string', () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\amber' : '/home/amber';
    const sample =
      process.platform === 'win32'
        ? `failed to open C:\\Users\\amber\\Pictures\\x.jpg: EBUSY`
        : `failed to open /home/amber/Pictures/x.jpg: EBUSY`;
    const expected =
      process.platform === 'win32'
        ? 'failed to open ~\\Pictures\\x.jpg: EBUSY'
        : 'failed to open ~/Pictures/x.jpg: EBUSY';
    expect(redactHomedirIn(sample, home)).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeResultBytes (result_bytes without a full
// stringify of embedded base64/text payloads)
// ─────────────────────────────────────────────────────────────────────────────

describe('computeResultBytes', () => {
  it('returns 0 for an undefined result', () => {
    expect(computeResultBytes(undefined)).toBe(0);
  });

  it('falls back to a plain stringify for results without a content array', () => {
    const result = { structuredContent: { ok: true, count: 3 } };
    expect(computeResultBytes(result)).toBe(JSON.stringify(result).length);
  });

  it('matches JSON.stringify(result).length for a plain text content block', () => {
    const result = { content: [{ type: 'text', text: 'hello' }] };
    expect(computeResultBytes(result)).toBe(JSON.stringify(result).length);
  });

  it('sums a 100 KB base64 image block to the same value a full stringify would report, without ever stringifying the payload itself', () => {
    const base64 = 'B'.repeat(100_000);
    const result = {
      content: [
        { type: 'text', text: 'preview rendered' },
        { type: 'image', data: base64, mimeType: 'image/png' },
      ],
    };

    const stringifySpy = vi.spyOn(JSON, 'stringify');
    const bytes = computeResultBytes(result);
    // Snapshot the call history before mockRestore() — mockRestore()
    // implies mockReset()/mockClear(), which wipes mock.results.
    const results = [...stringifySpy.mock.results];
    stringifySpy.mockRestore();

    // Exact match: base64 and this plain-ASCII text never need JSON-string
    // escaping, so blanking the payload field before stringifying and
    // adding its real .length back afterward reproduces the same total a
    // full stringify would have produced.
    expect(bytes).toBe(JSON.stringify(result).length);

    // But no individual JSON.stringify call made *inside* computeResultBytes
    // ever serialized the 100 KB payload — every call it made produced a
    // string far shorter than the base64 blob, proving the payload itself
    // was blanked out before being handed to JSON.stringify.
    expect(results.length).toBeGreaterThan(0);
    for (const call of results) {
      if (call.type === 'return') {
        expect((call.value as string).length).toBeLessThan(1000);
      }
    }
  });

  it('leaves an unknown content-block shape to the stringify fallback', () => {
    const result = { content: [{ type: 'resource', resource: { uri: 'x' } }] };
    expect(computeResultBytes(result)).toBe(JSON.stringify(result).length);
  });

  // ───────────────────────────────────────────────────────────────────────
  // C6+Q1 — byte-exact for escaped content. Nearly every real handler
  // returns pretty-printed JSON inside a text block, and JSON.stringify
  // escapes quotes/backslashes/control-chars (2 or 6 chars each) when it
  // re-serializes that string. Each case here is asserted against a REAL
  // JSON.stringify(result).length, not a hand-computed number.
  // ───────────────────────────────────────────────────────────────────────

  it('matches JSON.stringify(result).length exactly for escape-heavy pretty-printed JSON inside a text block', () => {
    const payload = JSON.stringify(
      {
        document: { name: 'My "Great" Photo.psd', note: 'line1\nline2\ttabbed' },
        path: 'C:\\Users\\x',
      },
      null,
      2
    );
    const result = { content: [{ type: 'text', text: payload }] };
    expect(computeResultBytes(result)).toBe(JSON.stringify(result).length);
  });

  it('counts an emoji (surrogate pair) as its unescaped UTF-16 code units, not escaped', () => {
    const result = { content: [{ type: 'text', text: 'layer renamed to 🎨 Retouching 😀' }] };
    expect(computeResultBytes(result)).toBe(JSON.stringify(result).length);
  });

  it('matches JSON.stringify(result).length exactly for a lone (unpaired) surrogate', () => {
    // A bare high surrogate with no following low surrogate — invalid UTF-16
    // text that can still show up in free-form strings (e.g. a truncated
    // copy-paste). JSON.stringify (ES2019+) escapes it to \uXXXX (6 chars).
    const lone = 'before ' + String.fromCharCode(0xd800) + ' after';
    const result = { content: [{ type: 'text', text: lone }] };
    expect(computeResultBytes(result)).toBe(JSON.stringify(result).length);
  });

  it('matches JSON.stringify(result).length exactly for control characters', () => {
    const withControls = 'a\x00b\x01c\x1fd\bf\fn\rt\tz';
    const result = { content: [{ type: 'text', text: withControls }] };
    expect(computeResultBytes(result)).toBe(JSON.stringify(result).length);
  });

  it('matches JSON.stringify(result).length exactly for quotes and backslashes', () => {
    const text = 'say "hello" then C:\\path\\to\\file and \\"escaped-looking\\"';
    const result = { content: [{ type: 'text', text }] };
    expect(computeResultBytes(result)).toBe(JSON.stringify(result).length);
  });

  it('combines escape-heavy text AND a base64 image block in the same result, still byte-exact', () => {
    const base64 = 'B'.repeat(5000);
    const result = {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, msg: 'quo"te\nnewline\\slash' }) },
        { type: 'image', data: base64, mimeType: 'image/png' },
      ],
    };
    expect(computeResultBytes(result)).toBe(JSON.stringify(result).length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// jsonEscapedLength — the single-pass escaped-length helper computeResultBytes
// leans on for text-block payloads (C6+Q1).
// ─────────────────────────────────────────────────────────────────────────────

describe('jsonEscapedLength', () => {
  function assertMatchesStringify(s: string) {
    // JSON.stringify(s) wraps in quotes; strip those to isolate the
    // escaped-content contribution jsonEscapedLength claims to compute.
    const stringified = JSON.stringify(s);
    const contentLen = stringified.length - 2; // minus the two wrapping quotes
    expect(jsonEscapedLength(s)).toBe(contentLen);
  }

  it('returns 0 for an empty string', () => {
    expect(jsonEscapedLength('')).toBe(0);
  });

  it('counts plain ASCII 1:1', () => {
    assertMatchesStringify('hello world');
  });

  it('counts quotes and backslashes as 2 chars each', () => {
    assertMatchesStringify('"quoted" and \\backslash\\');
  });

  it('counts named control-char escapes (\\b \\t \\n \\f \\r) as 2 chars each', () => {
    assertMatchesStringify('a\bb\tc\nd\fe\rf');
  });

  it('counts other control chars (< 0x20) as 6-char \\u00XX escapes', () => {
    assertMatchesStringify('a\x00b\x01c\x1fd\x0bz'); // \x0b is not a named escape
  });

  it('counts a valid surrogate pair (emoji) as 2 unescaped chars, not 12', () => {
    assertMatchesStringify('🎨');
    assertMatchesStringify('before 😀 after');
  });

  it('counts a lone high surrogate as a 6-char escape', () => {
    assertMatchesStringify(String.fromCharCode(0xd800));
    assertMatchesStringify('x' + String.fromCharCode(0xd800) + 'y');
  });

  it('counts a lone low surrogate as a 6-char escape', () => {
    assertMatchesStringify(String.fromCharCode(0xdc00));
    assertMatchesStringify('x' + String.fromCharCode(0xdc00) + 'y');
  });

  it('handles a lone high surrogate immediately followed by another lone high surrogate (neither pairs)', () => {
    assertMatchesStringify(String.fromCharCode(0xd800) + String.fromCharCode(0xd801));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SessionLog — core behaviour
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Directory resolution — EDITMAMEI_SESSION_LOG_DIR env var (1a)
// ─────────────────────────────────────────────────────────────────────────────

describe('SessionLog directory resolution', () => {
  const ENV_KEY = 'EDITMAMEI_SESSION_LOG_DIR';
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  });

  it('an explicit dir option wins over the env var', () => {
    process.env[ENV_KEY] = 'from-env-should-not-be-used';
    const log = new SessionLog('explicit-dir', { dir: 'explicit-dir-value' });
    expect(log.path).toBe(join('explicit-dir-value', 'explicit-dir.ndjson'));
  });

  it('a non-empty env var is used when no dir option is given', () => {
    process.env[ENV_KEY] = 'env-dir-value';
    const log = new SessionLog('env-dir', {});
    expect(log.path).toBe(join('env-dir-value', 'env-dir.ndjson'));
  });

  it('an EMPTY env var falls through to the homedir default, not process.cwd() (1a)', () => {
    process.env[ENV_KEY] = '';
    const log = new SessionLog('empty-env', {});
    expect(log.path).toBe(join(homedir(), '.editmamei', 'sessions', 'empty-env.ndjson'));
  });

  it('a WHITESPACE-only env var falls through to the homedir default (1a)', () => {
    process.env[ENV_KEY] = '   ';
    const log = new SessionLog('whitespace-env', {});
    expect(log.path).toBe(join(homedir(), '.editmamei', 'sessions', 'whitespace-env.ndjson'));
  });
});

describe('SessionLog', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'editmamei-sessionlog-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // v2 meta line
  // ──────────────────────────────────────────────────────────────────────────

  it('emits a meta line before the first call line', async () => {
    const log = new SessionLog('meta-first', { dir });
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 });

    const all = await readAllLines(log.path);
    expect(all).toHaveLength(2);
    expect((all[0] as { type: string }).type).toBe('meta');
    expect((all[1] as { type: string }).type).toBe('call');
  });

  it('concurrent first-appends emit exactly ONE meta line (backlog §5.12 race)', async () => {
    // emitMeta used to latch metaEmitted AFTER awaiting the write, so two
    // callers racing the lazy first-emit both observed false and both wrote a
    // byte-identical meta line ~1ms apart (seen live, v0.24.0 macOS session).
    const log = new SessionLog('meta-race', { dir });
    await Promise.all([
      log.append({ tool: 'a', args: {}, success: true, duration_ms: 1 }),
      log.append({ tool: 'b', args: {}, success: true, duration_ms: 1 }),
      log.append({ tool: 'c', args: {}, success: true, duration_ms: 1 }),
    ]);

    const metas = await readMetaLines(log.path);
    expect(metas).toHaveLength(1);
    // The meta line must still come first — writeChain preserves append order.
    const all = await readAllLines(log.path);
    expect((all[0] as { type: string }).type).toBe('meta');
    expect(all.filter((l) => (l as { type: string }).type === 'call')).toHaveLength(3);
  });

  it('setPsVersion still re-emits meta deliberately after a lazy first emit', async () => {
    // The dedupe above must not break the intended "meta changed" re-emit:
    // setPsVersion calls emitMeta directly and never consults the flag.
    const log = new SessionLog('meta-reemit', { dir });
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 });
    await log.setPsVersion('27.2.0');

    const metas = await readMetaLines(log.path);
    expect(metas).toHaveLength(2);
    expect(metas[0].ps_version).toBeNull();
    expect(metas[1].ps_version).toBe('27.2.0');
  });

  it('setPsVersion with an unchanged version does not re-emit', async () => {
    const log = new SessionLog('meta-noop', { dir });
    await log.setPsVersion('27.2.0');
    await log.setPsVersion('27.2.0');

    const metas = await readMetaLines(log.path);
    expect(metas).toHaveLength(1);
  });

  it('meta line has the correct shape', async () => {
    const log = new SessionLog('meta-shape', { dir });
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 });

    const [meta] = await readMetaLines(log.path);
    expect(meta.v).toBe(2);
    expect(meta.type).toBe('meta');
    expect(typeof meta.ts).toBe('string');
    expect(meta.session_id).toBe('meta-shape');
    expect(typeof meta.editmamei_version).toBe('string');
    expect(typeof meta.edition).toBe('string');
    expect(typeof meta.platform).toBe('string');
    expect(meta.ps_version).toBeNull();
    expect(meta.mcp_client).toBeNull();
  });

  it('meta line mcp_client is populated from the getter', async () => {
    const log = new SessionLog('mcp-client-test', { dir });
    log.setMcpClientGetter(() => ({ name: 'Claude Desktop', version: '1.2.3' }));
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 });

    const [meta] = await readMetaLines(log.path);
    expect(meta.mcp_client).toEqual({ name: 'Claude Desktop', version: '1.2.3' });
  });

  it('meta line mcp_client is null when getter returns null', async () => {
    const log = new SessionLog('mcp-null', { dir });
    log.setMcpClientGetter(() => null);
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 });

    const [meta] = await readMetaLines(log.path);
    expect(meta.mcp_client).toBeNull();
  });

  it('meta line mcp_client is null when getter returns undefined', async () => {
    const log = new SessionLog('mcp-undef', { dir });
    log.setMcpClientGetter(() => undefined);
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 });

    const [meta] = await readMetaLines(log.path);
    expect(meta.mcp_client).toBeNull();
  });

  it('setPsVersion re-emits meta with the new ps_version', async () => {
    const log = new SessionLog('ps-ver', { dir });
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 });
    await log.setPsVersion('27.7.0');

    const metas = await readMetaLines(log.path);
    // First meta has null, second has the version
    expect(metas).toHaveLength(2);
    expect(metas[0].ps_version).toBeNull();
    expect(metas[1].ps_version).toBe('27.7.0');
  });

  it('setPsVersion is a no-op when called with the same version', async () => {
    const log = new SessionLog('ps-ver-noop', { dir });
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 });
    await log.setPsVersion('27.7.0');
    await log.setPsVersion('27.7.0'); // second call — same version

    const metas = await readMetaLines(log.path);
    expect(metas).toHaveLength(2); // initial + one re-emit (not two)
  });

  // ──────────────────────────────────────────────────────────────────────────
  // v2 call line fields
  // ──────────────────────────────────────────────────────────────────────────

  it('call lines carry v:2 and type:call', async () => {
    const log = new SessionLog('call-shape', { dir });
    await log.append({ tool: 'ps_ping', args: {}, success: true, duration_ms: 5 });

    const [call] = await readCallLines(log.path);
    expect(call.v).toBe(2);
    expect(call.type).toBe('call');
    expect(call.tool).toBe('ps_ping');
    expect(call.session_id).toBe('call-shape');
  });

  it('seq is monotonically incrementing across call lines', async () => {
    const log = new SessionLog('seq-test', { dir });
    for (let i = 0; i < 4; i++) {
      await log.append({ tool: 't', args: { i }, success: true, duration_ms: 1 });
    }

    const calls = await readCallLines(log.path);
    expect(calls.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
  });

  it('retry_signal is true when consecutive calls have identical tool + args', async () => {
    const log = new SessionLog('retry-test', { dir });
    await log.append({ tool: 'ps_ping', args: {}, success: false, duration_ms: 1 });
    await log.append({ tool: 'ps_ping', args: {}, success: false, duration_ms: 1 });
    await log.append({ tool: 'ps_ping', args: {}, success: true, duration_ms: 1 });

    const calls = await readCallLines(log.path);
    expect(calls[0].retry_signal).toBe(false); // first call, no prior
    expect(calls[1].retry_signal).toBe(true); // same as prior
    expect(calls[2].retry_signal).toBe(true); // same as prior
  });

  it('retry_signal is false when args differ', async () => {
    const log = new SessionLog('retry-args', { dir });
    await log.append({ tool: 'ps_ping', args: {}, success: true, duration_ms: 1 });
    await log.append({ tool: 'ps_ping', args: { x: 1 }, success: true, duration_ms: 1 });

    const calls = await readCallLines(log.path);
    expect(calls[1].retry_signal).toBe(false);
  });

  it('result_bytes reflects the JSON size of the result object', async () => {
    const log = new SessionLog('result-bytes', { dir });
    const result = { content: [{ type: 'text', text: 'hello' }] };
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 }, result);

    const [call] = await readCallLines(log.path);
    expect(call.result_bytes).toBe(JSON.stringify(result).length);
  });

  it('result_bytes is 0 when no result is passed', async () => {
    const log = new SessionLog('result-bytes-zero', { dir });
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 });

    const [call] = await readCallLines(log.path);
    expect(call.result_bytes).toBe(0);
  });

  it('hoists context scalars from structuredContent.context (full getContextInfo shape)', async () => {
    const log = new SessionLog('hoist-test', { dir });
    const result = {
      structuredContent: {
        context: {
          activeLayer: { name: 'Retouching' },
          document: { layerCount: 7 },
        },
      },
    };
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 }, result);

    const [call] = await readCallLines(log.path);
    expect(call.active_layer_after).toBe('Retouching');
    expect(call.doc_layer_count_after).toBe(7);
  });

  it('hoists active_layer_after from flat activeLayer_name (getMinimalContextInfo shape)', async () => {
    const log = new SessionLog('hoist-minimal', { dir });
    const result = {
      structuredContent: {
        context: {
          activeLayer_name: 'Background copy',
        },
      },
    };
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 }, result);

    const [call] = await readCallLines(log.path);
    expect(call.active_layer_after).toBe('Background copy');
    expect('doc_layer_count_after' in call).toBe(false);
  });

  it('hoists target_was_copy from structuredContent top level', async () => {
    const log = new SessionLog('hoist-copy', { dir });
    const result = { structuredContent: { target_was_copy: true } };
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 }, result);

    const [call] = await readCallLines(log.path);
    expect(call.target_was_copy).toBe(true);
  });

  it('hoists background_promoted from structuredContent top level', async () => {
    const log = new SessionLog('hoist-bg', { dir });
    const result = { structuredContent: { background_promoted: true } };
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 }, result);

    const [call] = await readCallLines(log.path);
    expect(call.background_promoted).toBe(true);
  });

  it('omits hoisted fields when structuredContent is absent', async () => {
    const log = new SessionLog('hoist-absent', { dir });
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 }, { content: [] });

    const [call] = await readCallLines(log.path);
    expect('active_layer_after' in call).toBe(false);
    expect('doc_layer_count_after' in call).toBe(false);
    expect('target_was_copy' in call).toBe(false);
    expect('background_promoted' in call).toBe(false);
  });

  it('error_class is null on successful calls', async () => {
    const log = new SessionLog('errclass-null', { dir });
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 });

    const [call] = await readCallLines(log.path);
    expect('error_class' in call).toBe(false); // omitted when null
  });

  it('error_class classifies failed calls via error message', async () => {
    const log = new SessionLog('errclass-test', { dir });
    await log.append({
      tool: 't',
      args: {},
      success: false,
      duration_ms: 1,
      error: 'command not currently available',
    });

    const [call] = await readCallLines(log.path);
    expect(call.error_class).toBe('ps_command_unavailable');
  });

  it('result is NOT included by default (privacy default off)', async () => {
    const log = new SessionLog('result-privacy', { dir });
    const result = { content: [{ type: 'text', text: 'secret data' }] };
    await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 }, result);

    const [call] = await readCallLines(log.path);
    expect('result' in call).toBe(false);
  });

  it('result IS included when EDITMAMEI_LOG_RESULTS=1', async () => {
    const prev = process.env.EDITMAMEI_LOG_RESULTS;
    process.env.EDITMAMEI_LOG_RESULTS = '1';
    try {
      const log = new SessionLog('result-capture', { dir });
      const result = { content: [{ type: 'text', text: 'hello' }] };
      await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 }, result);

      const [call] = await readCallLines(log.path);
      expect(call.result).toEqual(result);
    } finally {
      if (prev === undefined) delete process.env.EDITMAMEI_LOG_RESULTS;
      else process.env.EDITMAMEI_LOG_RESULTS = prev;
    }
  });

  it('captured result elides inline base64 image payloads to size markers', async () => {
    const prev = process.env.EDITMAMEI_LOG_RESULTS;
    process.env.EDITMAMEI_LOG_RESULTS = '1';
    try {
      const log = new SessionLog('result-image-elide', { dir });
      const base64 = 'A'.repeat(8000); // ~6 KB decoded
      const result = {
        content: [
          { type: 'text', text: 'preview rendered' },
          { type: 'image', data: base64, mimeType: 'image/jpeg' },
        ],
        structuredContent: { bytes: 6000 },
      };
      await log.append({ tool: 'ps_get_preview', args: {}, success: true, duration_ms: 1 }, result);

      const [call] = await readCallLines(log.path);
      const content = (call.result as { content: Array<Record<string, unknown>> }).content;
      expect(content[0]).toEqual({ type: 'text', text: 'preview rendered' });
      expect(content[1].data).toBe(`[image:${Math.floor(8000 * 0.75)} bytes]`);
      expect(content[1].mimeType).toBe('image/jpeg');
      // The raw size is still measured pre-elision:
      expect(call.result_bytes).toBe(JSON.stringify(result).length);
      // And no base64 blob survives anywhere on the line:
      expect(JSON.stringify(call)).not.toContain('AAAAAAAAAA');
    } finally {
      if (prev === undefined) delete process.env.EDITMAMEI_LOG_RESULTS;
      else process.env.EDITMAMEI_LOG_RESULTS = prev;
    }
  });

  it('captured result strings get the same truncation discipline as args', async () => {
    const prev = process.env.EDITMAMEI_LOG_RESULTS;
    process.env.EDITMAMEI_LOG_RESULTS = '1';
    try {
      const log = new SessionLog('result-truncate', { dir, maxArgStringLen: 64 });
      const long = 'x'.repeat(500);
      await log.append(
        { tool: 't', args: {}, success: true, duration_ms: 1 },
        { structuredContent: { blob: long } }
      );

      const [call] = await readCallLines(log.path);
      const blob = (call.result as { structuredContent: { blob: string } }).structuredContent.blob;
      expect(blob).toContain('…[truncated:500→64]');
      expect(blob.startsWith('x'.repeat(64))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EDITMAMEI_LOG_RESULTS;
      else process.env.EDITMAMEI_LOG_RESULTS = prev;
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Core functionality (v1 parity, updated for v2 line shape)
  // ──────────────────────────────────────────────────────────────────────────

  it('appends call lines with correct envelope fields', async () => {
    const log = new SessionLog('test-session-1', { dir });
    await log.append({
      tool: 'ps_ping',
      args: {},
      success: true,
      duration_ms: 42,
    });
    await log.append({
      tool: 'photoshop_get_metadata',
      args: { foo: 'bar' },
      success: false,
      duration_ms: 100,
      error: 'no doc',
    });

    const all = await readAllLines(log.path);
    expect(all).toHaveLength(3); // meta + 2 calls

    const calls = await readCallLines(log.path);
    expect(calls).toHaveLength(2);

    expect(calls[0].v).toBe(SESSION_LOG_SCHEMA_VERSION);
    expect(calls[0].type).toBe('call');
    expect(calls[0].tool).toBe('ps_ping');
    expect(calls[0].session_id).toBe('test-session-1');
    expect(calls[0].success).toBe(true);
    expect(calls[0].duration_ms).toBe(42);
    expect(typeof calls[0].ts).toBe('string');
    expect(calls[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(calls[1].v).toBe(SESSION_LOG_SCHEMA_VERSION);
    expect(calls[1].tool).toBe('photoshop_get_metadata');
    expect(calls[1].success).toBe(false);
    expect(calls[1].error).toBe('no doc');
    expect(calls[1].args).toEqual({ foo: 'bar' });
  });

  it('every line (meta + call) carries schema version v:2', async () => {
    const log = new SessionLog('schemav-test', { dir });
    for (let i = 0; i < 3; i++) {
      await log.append({ tool: 't', args: { i }, success: true, duration_ms: 1 });
    }
    const lines = await readAllLines(log.path);
    for (const line of lines) {
      expect((line as { v: number }).v).toBe(SESSION_LOG_SCHEMA_VERSION);
    }
  });

  it('creates the target directory if it does not exist', async () => {
    const nested = join(dir, 'a', 'b', 'c');
    const log = new SessionLog('nested-test', { dir: nested });
    await log.append({ tool: 'x', args: {}, success: true, duration_ms: 1 });
    const raw = await readFile(log.path, 'utf8');
    expect(raw).toContain('"tool":"x"');
  });

  it('truncates string args over the configured cap with a self-describing marker', async () => {
    const log = new SessionLog('trunc-test', { dir, maxArgStringLen: 32 });
    const big = 'A'.repeat(500);
    await log.append({
      tool: 'ps_execute_script',
      args: { code: big, other: 'short' },
      success: true,
      duration_ms: 1,
    });
    const [call] = await readCallLines(log.path);
    expect(call.args.code).toMatch(/^A{32}…\[truncated:500→32\]$/);
    expect(call.args.other).toBe('short');
  });

  it('truncation recurses into nested objects + arrays', async () => {
    const log = new SessionLog('recursive-trunc', { dir, maxArgStringLen: 16 });
    const big = 'X'.repeat(200);
    await log.append({
      tool: 'ps_template_save',
      args: {
        name: 'short',
        nested: {
          inner: big,
          deeper: { code: big },
        },
        list: [big, 'fine', big],
      },
      success: true,
      duration_ms: 1,
    });
    const [call] = await readCallLines(log.path);
    expect(call.args.name).toBe('short');
    expect(call.args.nested).toMatchObject({
      inner: expect.stringMatching(/^X{16}…\[truncated:200→16\]$/),
      deeper: { code: expect.stringMatching(/^X{16}…\[truncated:200→16\]$/) },
    });
    expect((call.args.list as string[])[0]).toMatch(/^X{16}…\[truncated:200→16\]$/);
    expect((call.args.list as string[])[1]).toBe('fine');
    expect((call.args.list as string[])[2]).toMatch(/^X{16}…\[truncated:200→16\]$/);
  });

  it('disables truncation when maxArgStringLen is 0', async () => {
    const log = new SessionLog('no-trunc', { dir, maxArgStringLen: 0 });
    const big = 'B'.repeat(5000);
    await log.append({
      tool: 'ps_execute_script',
      args: { code: big },
      success: true,
      duration_ms: 1,
    });
    const [call] = await readCallLines(log.path);
    expect(call.args.code).toBe(big);
  });

  it('replaces the running user homedir prefix with ~ inside string args', async () => {
    const log = new SessionLog('redact-test', { dir });
    const home = homedir();
    await log.append({
      tool: 'photoshop_export_jpeg',
      args: { output_path: join(home, 'Pictures', 'oahu.jpg') },
      success: true,
      duration_ms: 1,
    });
    const [call] = await readCallLines(log.path);
    expect(String(call.args.output_path).startsWith('~')).toBe(true);
    expect(String(call.args.output_path)).not.toContain(home);
  });

  it('redaction also walks into nested object args', async () => {
    const log = new SessionLog('redact-nested', { dir });
    const home = homedir();
    await log.append({
      tool: 'ps_template_save',
      args: {
        evidence: {
          metadata: { document: { full_path: join(home, 'Photos', 'IMG.heic') } },
        },
      },
      success: true,
      duration_ms: 1,
    });
    const [call] = await readCallLines(log.path);
    const fullPath = (call.args.evidence as { metadata: { document: { full_path: string } } })
      .metadata.document.full_path;
    expect(fullPath.startsWith('~')).toBe(true);
    expect(fullPath).not.toContain(home);
  });

  it('applies BOTH homedir redaction AND truncation to the same nested string', async () => {
    const log = new SessionLog('combined', { dir, maxArgStringLen: 64 });
    const home = homedir();
    const tail = 'X'.repeat(500);
    const fullPath = join(home, 'Pictures', `${tail}.jpg`);
    await log.append({
      tool: 'photoshop_export_jpeg',
      args: { wrapper: { output_path: fullPath } },
      success: true,
      duration_ms: 1,
    });
    const [call] = await readCallLines(log.path);
    const got = (call.args.wrapper as { output_path: string }).output_path;
    expect(got.startsWith('~')).toBe(true);
    expect(got).toMatch(/…\[truncated:\d+→64\]$/);
  });

  it('honors redactHomedir: false to disable the redaction', async () => {
    const log = new SessionLog('no-redact', { dir, redactHomedir: false });
    const home = homedir();
    await log.append({
      tool: 'ps_open_document',
      args: { file_path: join(home, 'Pictures', 'raw.dng') },
      success: true,
      duration_ms: 1,
    });
    const [call] = await readCallLines(log.path);
    expect(String(call.args.file_path)).toContain(home);
    expect(String(call.args.file_path).startsWith('~')).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POSIX file permissions
  // ──────────────────────────────────────────────────────────────────────────

  it.skipIf(process.platform === 'win32')(
    'creates the session-log directory with mode 0700 on POSIX',
    async () => {
      const localDir = await mkdtemp(join(tmpdir(), 'editmamei-mode-test-'));
      try {
        const log = new SessionLog('mode-dir', { dir: join(localDir, 'sessions') });
        await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 });
        const dirStat = await stat(join(localDir, 'sessions'));
        expect(dirStat.mode & 0o777).toBe(0o700);
      } finally {
        await rm(localDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'creates the NDJSON file with mode 0600 on POSIX',
    async () => {
      const log = new SessionLog('mode-file', { dir });
      await log.append({ tool: 't', args: {}, success: true, duration_ms: 1 });
      const fileStat = await stat(log.path);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  );

  it('is fire-and-forget: append never throws even if the directory cannot be created', async () => {
    const badDir = join(dir, 'with\0null');
    const log = new SessionLog('safe-test', { dir: badDir });
    await expect(
      log.append({ tool: 'x', args: {}, success: true, duration_ms: 1 })
    ).resolves.toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Held file handle
  // ──────────────────────────────────────────────────────────────────────────

  it('reuses one open() call across multiple appends instead of one per line', async () => {
    const openSpy = vi.mocked(fsPromises.open);
    openSpy.mockClear();

    const log = new SessionLog('handle-reuse', { dir });
    await log.append({ tool: 'a', args: {}, success: true, duration_ms: 1 });
    await log.append({ tool: 'b', args: {}, success: true, duration_ms: 1 });
    await log.append({ tool: 'c', args: {}, success: true, duration_ms: 1 });
    await log.close();

    // One open() for the whole session (meta line + 3 call lines) — not
    // one per line as the old open→append→close-per-line implementation did.
    expect(openSpy).toHaveBeenCalledTimes(1);

    const calls = await readCallLines(log.path);
    expect(calls.map((c) => c.tool)).toEqual(['a', 'b', 'c']);
  });

  it('close() is idempotent — safe to call more than once', async () => {
    const log = new SessionLog('close-idempotent', { dir });
    await log.append({ tool: 'a', args: {}, success: true, duration_ms: 1 });
    await log.close();
    await expect(log.close()).resolves.toBeUndefined();
  });

  it('close() is safe even when no write ever happened (handle never opened)', async () => {
    const log = new SessionLog('close-never-opened', { dir });
    await expect(log.close()).resolves.toBeUndefined();
  });

  it('a write issued after close() does not throw, and is dropped silently', async () => {
    const log = new SessionLog('close-then-write', { dir });
    await log.append({ tool: 'a', args: {}, success: true, duration_ms: 1 });
    await log.close();

    await expect(
      log.append({ tool: 'b', args: {}, success: true, duration_ms: 1 })
    ).resolves.toBeUndefined();

    // Only the pre-close line made it to disk; the post-close append was
    // dropped silently rather than throwing into the caller.
    const calls = await readCallLines(log.path);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('a');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // S1/Q5 — open-retry cooldown. A failed open() used to latch PERMANENTLY
  // (openFailed: boolean); a transient EMFILE / AV-lock / permission blip
  // then killed session logging for the rest of the process. It now retries
  // after a cooldown instead of latching forever, and still warns only once
  // per failure streak (not once per dropped line, and not again on every
  // retry the cooldown itself blocks).
  // ──────────────────────────────────────────────────────────────────────────

  describe('open-retry cooldown after a failed open (S1/Q5)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('drops lines and warns once while within cooldown, then retries and succeeds once the cooldown elapses', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.useFakeTimers();

      const openSpy = vi.mocked(fsPromises.open);
      openSpy.mockClear();
      openSpy.mockRejectedValueOnce(new Error('EMFILE: too many open files'));

      const log = new SessionLog('open-retry', { dir });
      await log.append({ tool: 'a', args: {}, success: true, duration_ms: 1 }); // open fails
      await log.append({ tool: 'b', args: {}, success: true, duration_ms: 1 }); // still cooling down — no retry

      expect(openSpy).toHaveBeenCalledTimes(1);
      const openFailWarns = warnSpy.mock.calls.filter(([msg]) =>
        String(msg).includes('session-log open failed')
      );
      expect(openFailWarns).toHaveLength(1); // one warn for the whole failure streak so far

      vi.advanceTimersByTime(30_001); // past OPEN_RETRY_COOLDOWN_MS

      await log.append({ tool: 'c', args: {}, success: true, duration_ms: 1 }); // cooldown elapsed — retries, succeeds
      await log.close();

      expect(openSpy).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
      warnSpy.mockRestore();

      const raw = await readFile(log.path, 'utf8');
      expect(raw).not.toContain('"tool":"a"');
      expect(raw).not.toContain('"tool":"b"');
      expect(raw).toContain('"tool":"c"');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // S2/Q6 — serialized appends. `writeLine` chains every write through a
  // private `writeChain` promise so two overlapping fire-and-forget
  // `append()` calls (the shape server.ts actually uses — `void
  // this.sessionLog.append(...)`) can never both be mid-`appendFile()` on
  // the one shared handle at once.
  // ──────────────────────────────────────────────────────────────────────────

  it('serializes concurrent fire-and-forget appends so two writes on the shared handle never overlap, and land in issue order (S2/Q6)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const fakeHandle = {
      appendFile: vi.fn(async (data: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(data as string);
        // Hold the "write" open for a few milliseconds — long enough that,
        // absent serialization, a second concurrent append() call's
        // appendFile would already have fired while this one is still
        // pending.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
      }),
      close: vi.fn(async () => undefined),
    };
    const openSpy = vi.mocked(fsPromises.open);
    openSpy.mockClear();
    openSpy.mockResolvedValueOnce(fakeHandle as unknown as FileHandle);

    const log = new SessionLog('concurrent-writes', { dir });

    // Prime metaEmitted with one awaited append first, so the concurrency
    // under test below is exactly the two CALL-line writes below, not an
    // (unrelated, pre-existing) race on the metaEmitted flag itself, which
    // both of two truly-concurrent FIRST-ever append() calls would also
    // try to emit.
    await log.append({ tool: 'prime', args: {}, success: true, duration_ms: 1 });
    order.length = 0; // drop the priming write from the record

    // Fired without awaiting either individually first — exactly the
    // fire-and-forget shape the ToolRegistry onCall hook uses in server.ts.
    const p1 = log.append({ tool: 'first', args: {}, success: true, duration_ms: 1 });
    const p2 = log.append({ tool: 'second', args: {}, success: true, duration_ms: 1 });
    await Promise.all([p1, p2]);

    expect(maxInFlight).toBe(1); // never more than one appendFile() call mid-flight at once
    expect(order).toHaveLength(2);
    expect(order[0]).toContain('"tool":"first"');
    expect(order[1]).toContain('"tool":"second"');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Retry-detection key (capped, not raw, args)
  // ──────────────────────────────────────────────────────────────────────────

  it('known: retry_signal is keyed on sanitized (capped) args, so two different ps_execute_script calls whose code shares the same first 32 chars AND overall length read as a retry', async () => {
    const log = new SessionLog('retry-capped', { dir, maxArgStringLen: 32 });
    const prefix = 'A'.repeat(32);
    // Same prefix (survives the cap) and same total length (so the
    // truncation marker's encoded original-length is identical too) —
    // the two sanitized strings come out byte-identical even though the
    // raw args differ.
    await log.append({
      tool: 'ps_execute_script',
      args: { code: prefix + 'X'.repeat(8) },
      success: true,
      duration_ms: 1,
    });
    await log.append({
      tool: 'ps_execute_script',
      args: { code: prefix + 'Y'.repeat(8) },
      success: true,
      duration_ms: 1,
    });

    const calls = await readCallLines(log.path);
    expect(calls[0].args.code).toBe(calls[1].args.code); // sanitized forms collide
    // The capped retry key can't distinguish the raw args past the cap —
    // the documented tradeoff of keying retry detection off sanitized
    // (bounded) args instead of an unbounded stringify of the raw ones.
    expect(calls[1].retry_signal).toBe(true);
  });

  it('retry_signal still tells apart short args that differ well within the cap', async () => {
    const log = new SessionLog('retry-uncapped-short', { dir });
    await log.append({
      tool: 'ps_execute_script',
      args: { code: 'doThing(1)' },
      success: true,
      duration_ms: 1,
    });
    await log.append({
      tool: 'ps_execute_script',
      args: { code: 'doThing(2)' },
      success: true,
      duration_ms: 1,
    });

    const calls = await readCallLines(log.path);
    expect(calls[1].retry_signal).toBe(false);
  });
});
