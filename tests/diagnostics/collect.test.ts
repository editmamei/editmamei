import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectDiagnostics,
  writeDiagnosticBundle,
  sanitizeDesktopLogLine,
} from '@editmamei/diagnostics/collect.ts';
import { LogRingBuffer } from '@editmamei/utils/log-buffer.ts';

/**
 * The collector's whole reason to exist is a SHAREABLE bundle: content-free, no
 * tool args, no image data, no full paths. These tests pin that contract against
 * deliberately-poisoned inputs (a secret path/layer-name in session args, a base64
 * blob + arguments payload in the Desktop log).
 */

const SECRET_PATH_SEGMENT = 'TOPSECRETDIR';
const SECRET_ARG_VALUE = 'SECRETLAYERNAME';
const BIG_BASE64 = 'A'.repeat(250);

let work: string;
let emHome: string;
let sessionsDir: string;
let desktopLogDir: string;
let downloadsDir: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'editmamei-diag-'));
  emHome = join(work, '.editmamei');
  sessionsDir = join(emHome, 'sessions');
  desktopLogDir = join(work, 'desktop-logs');
  downloadsDir = join(work, 'downloads');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(desktopLogDir, { recursive: true });
  mkdirSync(downloadsDir, { recursive: true });

  // A session NDJSON with a meta line and two call lines. The args carry secrets
  // that must NEVER reach the bundle.
  const meta = {
    v: 2,
    type: 'meta',
    ts: '2026-06-27T18:00:00.000Z',
    session_id: 'sess1',
    editmamei_version: '0.20.0',
    edition: 'community',
    platform: 'darwin',
    ps_version: '27.7.0',
    mcp_client: { name: 'claude-ai', version: '0.1.0' },
  };
  const okCall = {
    v: 2,
    type: 'call',
    ts: '2026-06-27T18:00:01.000Z',
    session_id: 'sess1',
    seq: 1,
    tool: 'ps_open_document',
    args: { path: `/Users/alex/${SECRET_PATH_SEGMENT}/pic.psd`, layer: SECRET_ARG_VALUE },
    success: true,
    duration_ms: 12,
    editmamei_version: '0.20.0',
    edition: 'community',
    platform: 'darwin',
    ps_version: '27.7.0',
    result_bytes: 40,
    retry_signal: false,
  };
  const failCall = {
    v: 2,
    type: 'call',
    ts: '2026-06-27T18:00:02.000Z',
    session_id: 'sess1',
    seq: 2,
    tool: 'ps_filter',
    args: { type: 'gaussian_blur', secret: SECRET_ARG_VALUE },
    success: false,
    duration_ms: 30000,
    editmamei_version: '0.20.0',
    edition: 'community',
    platform: 'darwin',
    ps_version: '27.7.0',
    result_bytes: 0,
    retry_signal: false,
    error_class: 'timeout',
    error: 'Script execution timeout',
  };
  writeFileSync(
    join(sessionsDir, 'sess1.ndjson'),
    [meta, okCall, failCall].map((o) => JSON.stringify(o)).join('\n') + '\n',
    'utf8'
  );

  // A fake Claude Desktop log: a lifecycle line, an initialize frame (no args), a
  // tools/call frame with arguments, and a result frame carrying a base64 image.
  const desktopLog = [
    '2026-06-27T18:00:00.000Z [Editmamei] [info] Server started and connected successfully',
    '2026-06-27T18:00:00.100Z [Editmamei] [info] Message from client: {"method":"initialize","params":{"protocolVersion":"2025-11-25"},"id":0}',
    `2026-06-27T18:00:01.000Z [Editmamei] [info] Message from client: {"method":"tools/call","params":{"name":"ps_open_document","arguments":{"path":"/Users/alex/${SECRET_PATH_SEGMENT}/pic.psd"}},"id":2}`,
    `2026-06-27T18:00:01.500Z [Editmamei] [info] Message from server: {"result":{"content":[{"type":"image","data":"${BIG_BASE64}"}]},"id":2}`,
  ].join('\n');
  writeFileSync(join(desktopLogDir, 'mcp-server-Editmamei.log'), desktopLog + '\n', 'utf8');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('collectDiagnostics — privacy contract', () => {
  it('never includes raw tool arguments (secret path + layer name) anywhere in the bundle', async () => {
    const buffer = new LogRingBuffer(50);
    buffer.push(`[INFO] [Session] opening /Users/alex/${SECRET_PATH_SEGMENT}/pic.psd`);
    const bundle = await collectDiagnostics({ homeDir: emHome, desktopLogDir, logBuffer: buffer });

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(SECRET_ARG_VALUE); // arg value lives only in args → dropped
    expect(serialized).not.toContain(SECRET_PATH_SEGMENT); // path segment basenamed away everywhere
  });

  it('reduces each recent-session call to a content-free summary with no `args` key', async () => {
    const bundle = await collectDiagnostics({ homeDir: emHome, desktopLogDir });
    expect(bundle.recent_sessions).toHaveLength(1);
    const session = bundle.recent_sessions[0];
    expect(session.call_count).toBe(2);
    for (const call of session.calls) {
      expect(Object.keys(call).sort()).toEqual(
        ['duration_ms', 'error_class', 'seq', 'success', 'tool', 'ts'].sort()
      );
      expect(call).not.toHaveProperty('args');
    }
    const fail = session.calls.find((c) => c.tool === 'ps_filter');
    expect(fail?.success).toBe(false);
    expect(fail?.error_class).toBe('timeout');
  });

  it('sanitizes server-log lines (absolute path → basename)', async () => {
    const buffer = new LogRingBuffer(10);
    buffer.push(`[INFO] [Session] opening /Users/alex/${SECRET_PATH_SEGMENT}/pic.psd`);
    const bundle = await collectDiagnostics({ homeDir: emHome, desktopLogDir, logBuffer: buffer });
    expect(bundle.server_log.join('\n')).toContain('pic.psd');
    expect(bundle.server_log.join('\n')).not.toContain(SECRET_PATH_SEGMENT);
  });

  it('redacts whole Desktop-log payload bodies (args, results, base64) but keeps method + timing', async () => {
    const bundle = await collectDiagnostics({ homeDir: emHome, desktopLogDir });
    const joined = bundle.desktop_log.join('\n');
    expect(bundle.desktop_log_source).toBe('mcp-server-Editmamei.log');
    expect(joined).toContain('Server started and connected'); // lifecycle survives
    expect(joined).toContain('method=initialize'); // method + timing kept
    expect(joined).toContain('method=tools/call');
    expect(joined).toContain('payload redacted');
    expect(joined).not.toContain('"arguments"'); // the whole body is gone, not just the value
    expect(joined).not.toContain(BIG_BASE64); // image data dropped
    expect(joined).not.toContain(SECRET_PATH_SEGMENT);
  });

  it('embeds system info + anonymous install_id and a sanitized note', async () => {
    const bundle = await collectDiagnostics({
      homeDir: emHome,
      desktopLogDir,
      note: `crashed while /Users/alex/${SECRET_PATH_SEGMENT}/pic.psd was open`,
    });
    expect(bundle.editmamei_version).toBeTruthy();
    expect(bundle.install_id).toMatch(/^[0-9a-f]{32}$/);
    expect(bundle.ps_version).toBe('27.7.0'); // recovered from the session meta line
    expect(bundle.note).toContain('pic.psd');
    expect(bundle.note).not.toContain(SECRET_PATH_SEGMENT);
  });

  it('degrades cleanly when there are no sessions and no Desktop log', async () => {
    const emptyHome = join(work, 'empty-home');
    const bundle = await collectDiagnostics({
      homeDir: emptyHome,
      desktopLogDir: join(work, 'nope'),
      logBuffer: new LogRingBuffer(5),
    });
    expect(bundle.recent_sessions).toEqual([]);
    expect(bundle.desktop_log).toEqual([]);
    expect(bundle.desktop_log_source).toBeNull();
  });
});

describe('writeDiagnosticBundle', () => {
  it('writes a parseable JSON file to the chosen directory', async () => {
    const bundle = await collectDiagnostics({ homeDir: emHome, desktopLogDir });
    const { path, bytes } = await writeDiagnosticBundle(bundle, { downloadsDir });
    expect(path).toMatch(/editmamei-diagnostics-.*\.json$/);
    expect(bytes).toBeGreaterThan(0);
    const written = readdirSync(downloadsDir);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.schema).toBe(1);
    expect(parsed.install_id).toBe(bundle.install_id);
  });
});

describe('sanitizeDesktopLogLine', () => {
  it('redacts the whole body of a JSON-RPC frame, keeping method + id', () => {
    const out = sanitizeDesktopLogLine(
      '2026-06-27 [info] Message from client: {"method":"tools/call","params":{"name":"x","arguments":{"path":"/a/b/c.psd"}},"id":2}'
    );
    expect(out).toContain('method=tools/call');
    expect(out).toContain('id=2');
    expect(out).toContain('payload redacted');
    expect(out).not.toContain('arguments'); // args under params → gone with the body
    expect(out).not.toContain('c.psd');
  });

  it('redacts result-frame bodies so layer/document names never leak', () => {
    const out = sanitizeDesktopLogLine(
      'x [info] Message from server: {"result":{"structuredContent":{"layerName":"ClientCodename"}},"id":2}'
    );
    expect(out).toContain('payload redacted');
    expect(out).not.toContain('ClientCodename');
  });

  it('redacts a stray payload object on a non-frame line', () => {
    const out = sanitizeDesktopLogLine('debug "arguments":{"path":"/a/b/c.psd","x":1}');
    expect(out).toContain('<redacted>');
    expect(out).not.toContain('c.psd');
  });

  it('redacts long base64 runs on non-frame lines', () => {
    const out = sanitizeDesktopLogLine(`data ${'Q'.repeat(300)} end`);
    expect(out).toContain('…[binary redacted]');
    expect(out).not.toContain('Q'.repeat(300));
  });
});
