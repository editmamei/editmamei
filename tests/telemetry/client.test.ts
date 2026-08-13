import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryClient } from '@editmamei/telemetry/client.ts';
import {
  readOutbox,
  readSessionState,
  writeSessionStateSync,
} from '@editmamei/telemetry/outbox.ts';
import type { PersistedSessionState } from '@editmamei/telemetry/outbox.ts';
import type { Settings } from '@editmamei/core/settings.ts';
import type { TelemetryEvent, ModuleStatusInfo } from '@editmamei/telemetry/events.ts';

function makeSettings(over: Partial<Settings['telemetry']> = {}): Settings {
  return {
    telemetry: { usage: true, diagnostics: false, install_id: 'a'.repeat(32), ...over },
    privacy: { send_previews_to_llm: true },
    ps_path: null,
    update_check: true,
  };
}

/** A transport that records every batch it's handed; optionally fails. */
function recorder(opts: { fail?: boolean } = {}) {
  const batches: TelemetryEvent[][] = [];
  const transport = async (_url: string, body: string) => {
    if (opts.fail) throw new Error('network down');
    batches.push((JSON.parse(body) as { events: TelemetryEvent[] }).events);
  };
  return { batches, transport };
}

// Every client gets its own throwaway outbox dir so tests never touch the real ~/.editmamei
// and can assert what was persisted. Cleaned up after each test.
const tmpDirs: string[] = [];
function freshOutboxDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'editmamei-tel-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeClient(
  settings: Settings,
  rec: ReturnType<typeof recorder>,
  over: {
    active?: boolean;
    getPsVersion?: () => string | null;
    maxBatchSize?: number;
    flushIntervalMs?: number;
    outboxDir?: string;
    edition?: string;
    channel?: string;
    getModuleStatus?: () => ModuleStatusInfo | null;
  } = {}
) {
  return new TelemetryClient({
    settings,
    getPsVersion: over.getPsVersion ?? (() => '2026'),
    transport: rec.transport,
    endpoint: 'https://telemetry.test/v1/telemetry',
    active: over.active ?? true,
    flushIntervalMs: over.flushIntervalMs ?? 10_000_000,
    outboxDir: over.outboxDir ?? freshOutboxDir(),
    ...(over.maxBatchSize !== undefined ? { maxBatchSize: over.maxBatchSize } : {}),
    ...(over.edition !== undefined ? { edition: over.edition } : {}),
    ...(over.channel !== undefined ? { channel: over.channel } : {}),
    ...(over.getModuleStatus !== undefined ? { getModuleStatus: over.getModuleStatus } : {}),
  });
}

/** Make a client AND return its outbox dir, for tests that assert persistence. */
function makeClientD(
  settings: Settings,
  rec: ReturnType<typeof recorder>,
  over: Parameters<typeof makeClient>[2] = {}
) {
  const dir = over.outboxDir ?? freshOutboxDir();
  return { client: makeClient(settings, rec, { ...over, outboxDir: dir }), dir };
}

describe('active gate', () => {
  it('is inert when inactive — records nothing, sends nothing', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { active: false });
    c.recordCall({ tool: 'photoshop_x', success: true, duration_ms: 1, error_class: null });
    expect(c.pendingCount()).toBe(0);
    await c.flush();
    expect(rec.batches).toHaveLength(0);
  });
});

describe('consent gating', () => {
  it('does not record usage when telemetry.usage is off', () => {
    const rec = recorder();
    const c = makeClient(makeSettings({ usage: false }), rec);
    c.recordCall({ tool: 'photoshop_x', success: true, duration_ms: 1, error_class: null });
    expect(c.pendingCount()).toBe(0);
  });

  it('does not record diagnostics when telemetry.diagnostics is off (default)', () => {
    const rec = recorder();
    const c = makeClient(makeSettings(), rec);
    c.recordDiagnostic({ tool: 'photoshop_x', error_class: 'other', error_message: 'boom' });
    expect(c.pendingCount()).toBe(0);
  });

  it('records diagnostics when opted in, and sanitizes the message', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings({ diagnostics: true }), rec);
    c.recordDiagnostic({
      tool: 'photoshop_x',
      error_class: 'other',
      error_message: 'failed C:\\Users\\me\\secret.psd',
    });
    await c.flush();
    const ev = rec.batches[0][0] as { type: string; error_message: string };
    expect(ev.type).toBe('diagnostic');
    expect(ev.error_message).not.toContain('\\');
    expect(ev.error_message).not.toContain('C:');
  });
});

describe('flush + batching', () => {
  it('sends queued usage events as a single {events:[...]} batch', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings(), rec);
    c.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    c.recordCall({ tool: 'photoshop_b', success: false, duration_ms: 2, error_class: 'timeout' });
    await c.flush();
    expect(rec.batches).toHaveLength(1);
    expect(rec.batches[0]).toHaveLength(2);
    expect(rec.batches[0].every((e) => e.type === 'usage')).toBe(true);
  });

  it('auto-flushes when the batch fills (>=100 events)', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings(), rec);
    for (let i = 0; i < 100; i++) {
      c.recordCall({ tool: `photoshop_${i}`, success: true, duration_ms: 1, error_class: null });
    }
    // auto-flush is fire-and-forget; let the microtask settle.
    await Promise.resolve();
    await c.flush();
    const total = rec.batches.reduce((n, b) => n + b.length, 0);
    expect(total).toBe(100);
  });

  it('swallows a transport failure (never throws) and persists the batch to the outbox', async () => {
    const rec = recorder({ fail: true });
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    await expect(c.flush()).resolves.toBeUndefined();
    expect(rec.batches).toHaveLength(0);
    expect(c.pendingCount()).toBe(0); // out of the in-memory queue…
    expect(readOutbox({ dir })).toHaveLength(1); // …but durably retained for next-startup retry
  });

  it('bounds the in-memory queue (drops oldest beyond the cap)', () => {
    const rec = recorder();
    // Huge batch size disables auto-flush so the queue can actually accumulate.
    const c = makeClient(makeSettings(), rec, { maxBatchSize: 1_000_000 });
    for (let i = 0; i < 600; i++) {
      c.recordCall({ tool: `photoshop_${i}`, success: true, duration_ms: 1, error_class: null });
    }
    expect(c.pendingCount()).toBe(500); // MAX_QUEUE_SIZE
  });

  it('persists the undelivered backlog to the outbox on shutdown', async () => {
    // With a non-failing transport the auto-flush (batch fills at 100) delivers most events
    // live; whatever is still queued at shutdown is handed to the durable outbox, not sent.
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { maxBatchSize: 100 });
    for (let i = 0; i < 250; i++) {
      c.recordCall({ tool: `photoshop_${i}`, success: true, duration_ms: 1, error_class: null });
    }
    await Promise.resolve(); // let the two auto-flushes (at 100, 200) settle
    await c.shutdown();
    // Everything is accounted for: delivered live + persisted to outbox = all 250 usage events
    // (+ the session_summary, which is outbox-only).
    const delivered = rec.batches.flat().filter((e) => e.type === 'usage');
    const persisted = readOutbox({ dir });
    const persistedUsage = persisted.filter((e) => e.type === 'usage');
    expect(delivered.length + persistedUsage.length).toBe(250);
    expect(persisted.some((e) => e.type === 'session_summary')).toBe(true);
    expect(rec.batches.every((b) => b.length <= 100)).toBe(true);
  });
});

describe('start() periodic flush', () => {
  it('flushes on the interval and is inert when inactive', async () => {
    vi.useFakeTimers();
    try {
      const rec = recorder();
      const c = makeClient(makeSettings(), rec, { flushIntervalMs: 1000 });
      c.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
      c.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(rec.batches.length).toBeGreaterThanOrEqual(1);

      const recOff = recorder();
      const off = makeClient(makeSettings(), recOff, { active: false, flushIntervalMs: 1000 });
      off.start();
      await vi.advanceTimersByTimeAsync(2000);
      expect(recOff.batches).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('start() boot ping', () => {
  it('emits one content-free session_start on start and flushes it promptly', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { flushIntervalMs: 10_000_000 });
    c.start();
    await new Promise((r) => setTimeout(r, 0)); // let the prompt fire-and-forget flush settle
    const boot = rec.batches.flat().find((e) => e.type === 'session_start') as
      Record<string, unknown> | undefined;
    expect(boot).toBeDefined();
    // content-free: exactly the shared Category A dimensions + channel, no counts / free text.
    expect(Object.keys(boot!).sort()).toEqual(
      [
        'channel',
        'edition',
        'editmamei_version',
        'install_id',
        'platform',
        'ps_version',
        'ts_bucket',
        'type',
        'v',
      ].sort()
    );
  });

  it('stamps the boot ping with the passed edition + channel (entitlement/install source)', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, {
      flushIntervalMs: 10_000_000,
      edition: 'pro',
      channel: 'mcpb',
    });
    c.start();
    await new Promise((r) => setTimeout(r, 0));
    const boot = rec.batches.flat().find((e) => e.type === 'session_start') as
      { edition: string; channel: string } | undefined;
    expect(boot?.edition).toBe('pro');
    expect(boot?.channel).toBe('mcpb');
  });

  it('does not emit a boot ping when usage consent is off', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings({ usage: false }), rec, { flushIntervalMs: 10_000_000 });
    c.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.batches.flat().some((e) => e.type === 'session_start')).toBe(false);
  });

  it('does not emit a boot ping when inactive', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { active: false, flushIntervalMs: 10_000_000 });
    c.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.batches).toHaveLength(0);
  });
});

describe('start() module_status', () => {
  it('emits one module_status alongside the boot ping when a status is available', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, {
      flushIntervalMs: 10_000_000,
      edition: 'pro',
      getModuleStatus: () => ({
        module: 'pro',
        outcome: 'loaded',
        module_version: '0.22.1',
        abi: 3,
      }),
    });
    c.start();
    await new Promise((r) => setTimeout(r, 0));
    const ms = rec.batches.flat().find((e) => e.type === 'module_status') as
      | { outcome: string; module_version: string | null; abi: number | null; edition: string }
      | undefined;
    expect(ms).toBeDefined();
    expect(ms?.outcome).toBe('loaded');
    expect(ms?.module_version).toBe('0.22.1');
    expect(ms?.abi).toBe(3);
    // Correlates with the entitlement-resolved edition.
    expect(ms?.edition).toBe('pro');
  });

  it('emits no module_status for a pure-CE install (getModuleStatus returns null)', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, {
      flushIntervalMs: 10_000_000,
      getModuleStatus: () => null,
    });
    c.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.batches.flat().some((e) => e.type === 'module_status')).toBe(false);
    // …but the boot ping still fires.
    expect(rec.batches.flat().some((e) => e.type === 'session_start')).toBe(true);
  });

  it('emits no module_status when usage consent is off', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings({ usage: false }), rec, {
      flushIntervalMs: 10_000_000,
      getModuleStatus: () => ({
        module: 'pro',
        outcome: 'loaded',
        module_version: '1.0.0',
        abi: 3,
      }),
    });
    c.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.batches.flat().some((e) => e.type === 'module_status')).toBe(false);
  });
});

describe('shutdown → durable outbox', () => {
  it('writes a session_summary with correct aggregates to the outbox (does NOT network-send)', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    c.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    c.recordCall({ tool: 'photoshop_b', success: false, duration_ms: 2, error_class: 'timeout' });
    await c.shutdown();
    // Exit-time send is the unreliable path we replaced — nothing goes over the wire here.
    expect(rec.batches).toHaveLength(0);
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { tool_call_count: number; distinct_tools: number; any_failures: boolean } | undefined;
    expect(summary).toBeDefined();
    expect(summary?.tool_call_count).toBe(3);
    expect(summary?.distinct_tools).toBe(2);
    expect(summary?.any_failures).toBe(true);
  });

  it('writes no summary when no calls were recorded, and clears the session marker', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    await c.shutdown();
    expect(rec.batches).toHaveLength(0);
    expect(readOutbox({ dir })).toHaveLength(0);
    expect(readSessionState({ dir })).toBeNull();
  });

  it('is memoized: two concurrent shutdowns persist exactly one summary', async () => {
    // Regression for the macOS "session_summary never lands" bug. Both shutdown paths
    // (transport onclose + a following SIGTERM handler) call shutdown(); memoization means
    // the queue is drained to the outbox once, not twice.
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    await Promise.all([c.shutdown(), c.shutdown()]);
    const summaries = readOutbox({ dir }).filter((e) => e.type === 'session_summary');
    expect(summaries).toHaveLength(1);
  });
});

describe('flushOutboxOnStartup', () => {
  it('delivers a backlog left by a previous run, then clears the outbox', async () => {
    // Session 1: transport fails, so the batch + summary land in the outbox.
    const dir = freshOutboxDir();
    const failRec = recorder({ fail: true });
    const c1 = makeClient(makeSettings(), failRec, { outboxDir: dir });
    c1.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    await c1.flush(); // fails → outbox
    await c1.shutdown(); // summary → outbox
    expect(readOutbox({ dir }).length).toBeGreaterThanOrEqual(2);

    // Session 2 (next startup): a working transport drains the outbox.
    const okRec = recorder();
    const c2 = makeClient(makeSettings(), okRec, { outboxDir: dir });
    await c2.flushOutboxOnStartup();
    const sent = okRec.batches.flat();
    expect(sent.some((e) => e.type === 'usage')).toBe(true);
    expect(sent.some((e) => e.type === 'session_summary')).toBe(true);
    expect(readOutbox({ dir })).toHaveLength(0); // cleared after a clean delivery
  });

  it('reconstructs a session_summary from a session killed before clean shutdown', async () => {
    // Simulate a hard kill: session state was persisted, but shutdown() never ran (no
    // summary in the outbox, marker still present).
    const dir = freshOutboxDir();
    const state: PersistedSessionState = {
      install_id: 'a'.repeat(32),
      ts_bucket: '2026-06-16',
      editmamei_version: '0.16.4',
      edition: 'community',
      platform: 'darwin',
      ps_version: '27.7.0',
      tool_call_count: 7,
      distinct_tools: 4,
      any_failures: false,
    };
    writeSessionStateSync(state, { dir });

    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { outboxDir: dir });
    await c.flushOutboxOnStartup();

    const summary = rec.batches.flat().find((e) => e.type === 'session_summary') as
      { tool_call_count: number; distinct_tools: number; platform: string } | undefined;
    expect(summary).toBeDefined();
    expect(summary?.tool_call_count).toBe(7);
    expect(summary?.distinct_tools).toBe(4);
    expect(summary?.platform).toBe('darwin');
    // Marker consumed so it can't be reconstructed again next boot.
    expect(readSessionState({ dir })).toBeNull();
  });

  it('drops the backlog unsent when usage consent is now off', async () => {
    const dir = freshOutboxDir();
    const failRec = recorder({ fail: true });
    const c1 = makeClient(makeSettings(), failRec, { outboxDir: dir });
    c1.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    await c1.flush(); // → outbox
    expect(readOutbox({ dir }).length).toBeGreaterThanOrEqual(1);

    // Next startup, but the user has since opted out of usage telemetry.
    const okRec = recorder();
    const c2 = makeClient(makeSettings({ usage: false }), okRec, { outboxDir: dir });
    await c2.flushOutboxOnStartup();
    expect(okRec.batches).toHaveLength(0); // respected — nothing sent
    expect(readOutbox({ dir })).toHaveLength(0); // and the backlog is cleared
  });

  it('keeps the backlog for a later startup when delivery fails', async () => {
    const dir = freshOutboxDir();
    const seedRec = recorder({ fail: true });
    const c1 = makeClient(makeSettings(), seedRec, { outboxDir: dir });
    c1.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    await c1.flush(); // → outbox

    const stillFailing = recorder({ fail: true });
    const c2 = makeClient(makeSettings(), stillFailing, { outboxDir: dir });
    await c2.flushOutboxOnStartup();
    expect(readOutbox({ dir }).length).toBeGreaterThanOrEqual(1); // retained, not lost
  });
});

describe('onPsVersionResolved', () => {
  it('re-stamps the persisted session state with the resolved ps_version', () => {
    let ps: string | null = null; // not yet identified (pre-ping)
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { getPsVersion: () => ps });
    c.recordCall({ tool: 'ps_ping', success: true, duration_ms: 1, error_class: null });
    expect(readSessionState({ dir })?.ps_version).toBe('unknown'); // snapshot taken pre-ping

    ps = '27.7.0'; // ping resolves the version
    c.onPsVersionResolved();
    expect(readSessionState({ dir })?.ps_version).toBe('27.7.0'); // snapshot refreshed
  });

  it('is a no-op when no calls have been recorded (nothing to reconstruct)', () => {
    let ps: string | null = null;
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { getPsVersion: () => ps });
    ps = '27.7.0';
    c.onPsVersionResolved();
    expect(readSessionState({ dir })).toBeNull();
  });
});

describe('ps_version re-stamping at flush', () => {
  it('stamps the resolved version onto calls recorded before detection landed', async () => {
    let ps: string | null = null; // pre-ping
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { getPsVersion: () => ps });
    c.recordCall({ tool: 'ps_select_layer', success: true, duration_ms: 1, error_class: null });
    c.recordCall({ tool: 'ps_read_scene', success: true, duration_ms: 2, error_class: null });

    ps = '27.1.0'; // the first ping identifies Photoshop
    c.recordCall({ tool: 'ps_retouch', success: true, duration_ms: 3, error_class: null });
    await c.flush();

    // One flush, one dimension — the whole day no longer splits across two rows.
    expect(rec.batches[0]!.map((e) => (e as { ps_version: string }).ps_version)).toEqual([
      '27.1.0',
      '27.1.0',
      '27.1.0',
    ]);
  });

  it('leaves unknown alone when the version never resolved', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { getPsVersion: () => null });
    c.recordCall({
      tool: 'ps_ping',
      success: false,
      duration_ms: 1,
      error_class: 'ps_not_running',
    });
    await c.flush();
    expect((rec.batches[0]![0] as { ps_version: string }).ps_version).toBe('unknown');
  });

  it('does not overwrite a version already stamped on the event', async () => {
    let ps: string | null = '27.1.0';
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { getPsVersion: () => ps });
    c.recordCall({ tool: 'ps_select_layer', success: true, duration_ms: 1, error_class: null });
    ps = '27.2.0'; // PS relaunched at a different version mid-session
    await c.flush();
    expect((rec.batches[0]![0] as { ps_version: string }).ps_version).toBe('27.1.0');
  });

  it('re-stamps the queue drained into the outbox at shutdown too', async () => {
    let ps: string | null = null;
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { getPsVersion: () => ps });
    c.recordCall({ tool: 'ps_select_layer', success: true, duration_ms: 1, error_class: null });
    ps = '27.1.0';
    await c.shutdown();

    const persisted = readOutbox({ dir }) as Array<{ type: string; ps_version: string }>;
    expect(persisted.find((e) => e.type === 'usage')?.ps_version).toBe('27.1.0');
  });

  // The outbox holds batches from a PREVIOUS process. Their `unknown` events belong to a
  // Photoshop session this one knows nothing about, so the startup drain must ship them
  // verbatim rather than stamping the current version onto someone else's history.
  it('never re-stamps events the previous process already persisted', async () => {
    const dir = freshOutboxDir();
    const failing = recorder({ fail: true });
    const c1 = makeClient(makeSettings(), failing, { getPsVersion: () => null, outboxDir: dir });
    c1.recordCall({ tool: 'ps_select_layer', success: true, duration_ms: 1, error_class: null });
    await c1.flush(); // send fails → persisted with ps_version 'unknown'
    expect(readOutbox({ dir }).length).toBeGreaterThan(0);

    const rec = recorder();
    const c2 = makeClient(makeSettings(), rec, { getPsVersion: () => '27.1.0', outboxDir: dir });
    await c2.flushOutboxOnStartup();

    const sent = rec.batches[0]!.filter((e) => e.type === 'usage');
    expect(sent.map((e) => (e as { ps_version: string }).ps_version)).toEqual(['unknown']);
  });

  // The two exclusions the re-stamp advertises, pinned directly against the
  // method — via the public API the summary is built and re-stamped in the
  // same tick with the same dims, so exclusion and coincidence are
  // indistinguishable from outside.
  it('excludes session_summary from the re-stamp by type, not by timing', () => {
    const c = makeClient(makeSettings(), recorder(), { getPsVersion: () => '27.1.0' });
    const summary = { type: 'session_summary', ps_version: 'unknown' };
    const usage = { type: 'usage', ps_version: 'unknown' };
    (c as unknown as { restampPsVersion(e: unknown[]): unknown[] }).restampPsVersion([
      summary,
      usage,
    ]);
    expect(summary.ps_version).toBe('unknown');
    expect(usage.ps_version).toBe('27.1.0');
  });

  it('does not add a ps_version field to module_status (which carries none)', () => {
    const c = makeClient(makeSettings(), recorder(), { getPsVersion: () => '27.1.0' });
    const mod = { type: 'module_status' };
    (c as unknown as { restampPsVersion(e: unknown[]): unknown[] }).restampPsVersion([mod]);
    expect('ps_version' in mod).toBe(false);
  });
});
