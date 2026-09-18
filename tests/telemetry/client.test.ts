import { describe, it, expect, vi, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { osMajor, nodeMajor, boundMajor } from '@editmamei/telemetry/activity.ts';
import { TelemetryClient } from '@editmamei/telemetry/client.ts';
import {
  appendOutboxSync,
  outboxPath,
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
    now?: () => Date;
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
    ...(over.now !== undefined ? { now: over.now } : {}),
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
    // content-free: exactly the shared Category A dimensions + channel + arch, no counts /
    // free text. node_major/os_major are asserted the SAME way the client itself decides
    // whether to include them (bounded + non-null) — not assumed always-present, since a
    // real host isn't guaranteed to resolve either one.
    const expectedKeys = [
      'arch',
      'channel',
      'edition',
      'editmamei_version',
      'install_id',
      'platform',
      'ps_version',
      'ts_bucket',
      'type',
      'v',
    ];
    if (boundMajor(nodeMajor(), 999) !== null) expectedKeys.push('node_major');
    if (boundMajor(osMajor(process.platform, release()), 999) !== null) {
      expectedKeys.push('os_major');
    }
    expect(Object.keys(boot!).sort()).toEqual(expectedKeys.sort());
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

describe('session_summary day attribution', () => {
  it('a same-day session is credited to that day', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, {
      now: () => new Date('2026-06-15T12:00:00.000Z'),
    });
    c.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { ts_bucket: string } | undefined;
    expect(summary?.ts_bucket).toBe('2026-06-15');
  });

  it('a session crossing UTC midnight is credited to the day it STARTED, not shutdown', async () => {
    let cur = new Date('2026-06-15T23:59:30.000Z');
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { now: () => cur });
    c.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    // The state persisted mid-session already carries the start-day bucket.
    expect(readSessionState({ dir })?.ts_bucket).toBe('2026-06-15');

    cur = new Date('2026-06-16T00:00:30.000Z'); // crossed midnight
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { ts_bucket: string } | undefined;
    expect(summary?.ts_bucket).toBe('2026-06-15'); // start day, not the shutdown day
  });

  it('a later persist does not advance the bucket past midnight', async () => {
    // The persisted bucket must survive a persist that happens on a later day. The two
    // calls have to be far enough apart to clear SESSION_PERSIST_THROTTLE_MS, or the
    // second persist never runs and the assertion proves nothing.
    let cur = new Date('2026-06-15T23:59:00.000Z');
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { now: () => cur });
    c.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    expect(readSessionState({ dir })?.ts_bucket).toBe('2026-06-15');

    cur = new Date('2026-06-16T00:05:00.000Z'); // past midnight AND past the throttle
    c.recordCall({ tool: 'photoshop_b', success: true, duration_ms: 1, error_class: null });
    expect(readSessionState({ dir })?.ts_bucket).toBe('2026-06-15');
  });

  it('a resident server credits the day of its first CALL, not the day it booted', async () => {
    // An MCP host can stay resident for days. Claiming the bucket in start() would credit
    // the summary to the boot day while every usage event landed on the day of the work.
    let cur = new Date('2026-06-15T08:00:00.000Z');
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { now: () => cur });
    c.start();
    expect(readSessionState({ dir })).toBeNull(); // nothing claimed yet

    cur = new Date('2026-06-17T10:00:00.000Z'); // first use, two days later
    c.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { ts_bucket: string } | undefined;
    expect(summary?.ts_bucket).toBe('2026-06-17');
  });

  it('clamps a corrupt persisted bucket so one bad file cannot reject the batch', async () => {
    // The persisted state is a plain file on disk: truncation or a hand edit can put
    // anything in ts_bucket, and the endpoint rejects a whole batch over one bad event.
    const dir = freshOutboxDir();
    const state: PersistedSessionState = {
      install_id: 'i',
      ts_bucket: 'not-a-bucket',
      editmamei_version: '1.3.0',
      edition: 'community',
      platform: 'win32',
      ps_version: 'unknown',
      tool_call_count: 1,
      distinct_tools: 1,
      any_failures: false,
    };
    writeSessionStateSync(state, { dir });

    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { outboxDir: dir });
    await c.flushOutboxOnStartup();
    const summary = rec.batches.flat().find((e) => e.type === 'session_summary') as
      { ts_bucket: string } | undefined;
    expect(summary?.ts_bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(summary?.ts_bucket).not.toBe('not-a-bucket');
  });

  it('crash reconstruction agrees with what a clean shutdown would have produced', async () => {
    // Simulate a hard kill: the session-state marker persisted mid-session survives (no
    // clean shutdown to clear it); the NEXT startup reconstructs the summary from it.
    const cur = new Date('2026-06-15T23:59:45.000Z');
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { now: () => cur });
    c.recordCall({ tool: 'photoshop_a', success: true, duration_ms: 1, error_class: null });
    // (deliberately no shutdown() call — the process is presumed hard-killed here)

    const rec2 = recorder();
    const c2 = makeClient(makeSettings(), rec2, { outboxDir: dir });
    await c2.flushOutboxOnStartup();
    const summary = rec2.batches.flat().find((e) => e.type === 'session_summary') as
      { ts_bucket: string } | undefined;
    // Same start-day bucket a clean shutdown produces, so the two paths agree.
    expect(summary?.ts_bucket).toBe('2026-06-15');
  });
});

describe('session_summary accumulators', () => {
  it('computes duration_s from the first call to the last, floored to whole seconds', async () => {
    let cur = new Date('2026-06-15T12:00:00.000Z');
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { now: () => cur });
    c.recordCall({
      tool: 'ps_add_adjustment_layer',
      success: true,
      duration_ms: 1,
      error_class: null,
    });
    cur = new Date('2026-06-15T12:02:10.500Z'); // +130.5s
    c.recordCall({
      tool: 'ps_add_adjustment_layer',
      success: true,
      duration_ms: 1,
      error_class: null,
    });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { duration_s: number } | undefined;
    expect(summary?.duration_s).toBe(130);
  });

  it('caps duration_s at 604_800 (7 days)', async () => {
    let cur = new Date('2026-06-01T00:00:00.000Z');
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { now: () => cur });
    c.recordCall({
      tool: 'ps_add_adjustment_layer',
      success: true,
      duration_ms: 1,
      error_class: null,
    });
    cur = new Date('2026-06-20T00:00:00.000Z'); // way past 7 days later
    c.recordCall({
      tool: 'ps_add_adjustment_layer',
      success: true,
      duration_ms: 1,
      error_class: null,
    });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { duration_s: number } | undefined;
    expect(summary?.duration_s).toBe(604_800);
  });

  it('clamps duration_s to 0 when the clock steps backward mid-session', async () => {
    let cur = new Date('2026-06-15T12:00:00.000Z');
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { now: () => cur });
    c.recordCall({
      tool: 'ps_add_adjustment_layer',
      success: true,
      duration_ms: 1,
      error_class: null,
    });
    cur = new Date('2026-06-15T11:59:00.000Z'); // clock stepped BACKWARD 60s
    c.recordCall({
      tool: 'ps_add_adjustment_layer',
      success: true,
      duration_ms: 1,
      error_class: null,
    });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { duration_s: number } | undefined;
    expect(summary?.duration_s).toBe(0);
  });

  it('counts retries via the retry flag on RecordedCall', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.recordCall({ tool: 'ps_select_layer', success: true, duration_ms: 1, error_class: null });
    c.recordCall({
      tool: 'ps_select_layer',
      success: true,
      duration_ms: 1,
      error_class: null,
      retry: true,
    });
    c.recordCall({
      tool: 'ps_select_layer',
      success: false,
      duration_ms: 1,
      error_class: 'other',
      retry: true,
    });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { retry_count: number } | undefined;
    expect(summary?.retry_count).toBe(2);
  });

  it('ended_after_failure reflects only the LAST recorded call', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.recordCall({ tool: 'ps_a', success: false, duration_ms: 1, error_class: 'other' });
    c.recordCall({ tool: 'ps_b', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { ended_after_failure: boolean } | undefined;
    expect(summary?.ended_after_failure).toBe(false); // last call succeeded

    const rec2 = recorder();
    const { client: c2, dir: dir2 } = makeClientD(makeSettings(), rec2);
    c2.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    c2.recordCall({ tool: 'ps_b', success: false, duration_ms: 1, error_class: 'other' });
    await c2.shutdown();
    const summary2 = readOutbox({ dir: dir2 }).find((e) => e.type === 'session_summary') as
      { ended_after_failure: boolean } | undefined;
    expect(summary2?.ended_after_failure).toBe(true); // last call failed
  });

  it('edits_ok / kept_work use the shared READ_ONLY_TOOLS / KEPT_WORK_TOOLS lists', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    // Read-only success — counts toward neither.
    c.recordCall({ tool: 'ps_ping', success: true, duration_ms: 1, error_class: null });
    // An ordinary edit — counts toward edits_ok only.
    c.recordCall({
      tool: 'ps_add_adjustment_layer',
      success: true,
      duration_ms: 1,
      error_class: null,
    });
    // A kept-work tool — counts toward BOTH edits_ok (not read-only) and kept_work.
    c.recordCall({ tool: 'ps_export', success: true, duration_ms: 1, error_class: null });
    // A failed edit — success:false, so it counts toward neither.
    c.recordCall({
      tool: 'ps_add_adjustment_layer',
      success: false,
      duration_ms: 1,
      error_class: 'other',
    });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { edits_ok: number; kept_work: number } | undefined;
    expect(summary?.edits_ok).toBe(2);
    expect(summary?.kept_work).toBe(1);
  });

  it('dropped_events reflects the in-memory MAX_QUEUE_SIZE trim', async () => {
    const rec = recorder();
    // Huge batch size disables auto-flush so the queue actually accumulates and trims.
    const { client: c, dir } = makeClientD(makeSettings(), rec, { maxBatchSize: 1_000_000 });
    for (let i = 0; i < 600; i++) {
      c.recordCall({ tool: `photoshop_${i}`, success: true, duration_ms: 1, error_class: null });
    }
    expect(c.pendingCount()).toBe(500); // MAX_QUEUE_SIZE
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { dropped_events: number } | undefined;
    expect(summary?.dropped_events).toBe(100); // 600 recorded - 500 kept
  });

  it('omits behind_latest until setBehindLatest is called, then carries it through', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { behind_latest?: boolean } | undefined;
    expect('behind_latest' in (summary ?? {})).toBe(false);

    const rec2 = recorder();
    const { client: c2, dir: dir2 } = makeClientD(makeSettings(), rec2);
    c2.setBehindLatest(true);
    c2.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c2.shutdown();
    const summary2 = readOutbox({ dir: dir2 }).find((e) => e.type === 'session_summary') as
      { behind_latest?: boolean } | undefined;
    expect(summary2?.behind_latest).toBe(true);
  });

  it('carries behind_latest: false when the install is confirmed already current', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.setBehindLatest(false);
    c.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { behind_latest?: boolean } | undefined;
    expect('behind_latest' in (summary ?? {})).toBe(true);
    expect(summary?.behind_latest).toBe(false);
  });

  it('omits module_update for a pure-CE install even after setModuleUpdate is called', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec); // no getModuleStatus → null
    c.setModuleUpdate('updated');
    c.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { module_update?: string } | undefined;
    expect('module_update' in (summary ?? {})).toBe(false);
  });

  it('includes module_update (default "none") for a licensed install', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, {
      getModuleStatus: () => ({
        module: 'pro',
        outcome: 'loaded',
        module_version: '1.0.0',
        abi: 3,
      }),
    });
    c.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { module_update?: string } | undefined;
    expect(summary?.module_update).toBe('none'); // never set this session, but the install IS licensed

    const rec2 = recorder();
    const { client: c2, dir: dir2 } = makeClientD(makeSettings(), rec2, {
      getModuleStatus: () => ({
        module: 'pro',
        outcome: 'loaded',
        module_version: '1.0.0',
        abi: 3,
      }),
    });
    c2.setModuleUpdate('failed');
    c2.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c2.shutdown();
    const summary2 = readOutbox({ dir: dir2 }).find((e) => e.type === 'session_summary') as
      { module_update?: string } | undefined;
    expect(summary2?.module_update).toBe('failed');
  });

  it('includes templates_saved / action_sets only once setInstallAssets is called', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { templates_saved?: number; action_sets?: number } | undefined;
    expect('templates_saved' in (summary ?? {})).toBe(false);
    expect('action_sets' in (summary ?? {})).toBe(false);

    const rec2 = recorder();
    const { client: c2, dir: dir2 } = makeClientD(makeSettings(), rec2);
    c2.setInstallAssets({ templates_saved: 6, action_sets: 2 });
    c2.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c2.shutdown();
    const summary2 = readOutbox({ dir: dir2 }).find((e) => e.type === 'session_summary') as
      { templates_saved?: number; action_sets?: number } | undefined;
    expect(summary2?.templates_saved).toBe(6);
    expect(summary2?.action_sets).toBe(2);
  });

  it('setInstallAssets merges per field — a degraded second ping does not clobber the other', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    // First ping: both observed.
    c.setInstallAssets({ templates_saved: 6, action_sets: 2 });
    // Second ping: only templates_saved observed (action_sets degraded this round) —
    // must NOT erase the action_sets value the first ping recorded.
    c.setInstallAssets({ templates_saved: 7 });
    c.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { templates_saved?: number; action_sets?: number } | undefined;
    expect(summary?.templates_saved).toBe(7);
    expect(summary?.action_sets).toBe(2);
  });

  it('setInstallAssets clamps each field to MAX_INSTALL_ASSET_COUNT (100_000)', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.setInstallAssets({ templates_saved: 100_001, action_sets: -5 });
    c.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { templates_saved?: number; action_sets?: number } | undefined;
    expect(summary?.templates_saved).toBe(100_000);
    expect(summary?.action_sets).toBe(0);
  });

  it('setInstallAssets treats a non-finite field as unobserved — never clamped to 0, never sent as null', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    // A real earlier reading, then a NaN on a later ping (e.g. a bad parse) — the NaN must
    // not overwrite the earlier good value, and must never surface as 0 or null on the wire.
    c.setInstallAssets({ templates_saved: 6, action_sets: 2 });
    c.setInstallAssets({ templates_saved: NaN, action_sets: Infinity });
    c.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { templates_saved?: number; action_sets?: number } | undefined;
    expect(summary?.templates_saved).toBe(6);
    expect(summary?.action_sets).toBe(2);
  });

  it('setInstallAssets omits templates_saved entirely when the only observation is non-finite (no earlier value to fall back on)', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.setInstallAssets({ templates_saved: NaN });
    c.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      Record<string, unknown> | undefined;
    expect('templates_saved' in (summary ?? {})).toBe(false);
  });

  it('setInstallAssets truncates a fractional count to an integer', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.setInstallAssets({ action_sets: 6.5 });
    c.recordCall({ tool: 'ps_a', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      { action_sets?: number } | undefined;
    expect(summary?.action_sets).toBe(6);
  });
});

describe('recordClientConnected', () => {
  it('enqueues one client_connected event without forcing its own flush', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { flushIntervalMs: 10_000_000 });
    c.recordClientConnected({
      clientName: 'claude-code',
      clientVersion: '2.1.170',
      capSampling: true,
      capElicitation: false,
      capRoots: true,
    });
    // Not sent yet — it rides the next flush (boot flush, periodic timer, batch-fill flush,
    // or shutdown's outbox write), not a flush of its own.
    expect(rec.batches).toHaveLength(0);
    expect(c.pendingCount()).toBe(1);

    await c.flush();
    const ev = rec.batches.flat().find((e) => e.type === 'client_connected') as
      { client: string; client_major: number | null; cap_sampling: boolean } | undefined;
    expect(ev).toBeDefined();
    expect(ev?.client).toBe('claude_code');
    expect(ev?.client_major).toBe(2);
    expect(ev?.cap_sampling).toBe(true);
  });

  it('is suppressed when usage telemetry is off', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings({ usage: false }), rec, { flushIntervalMs: 10_000_000 });
    c.recordClientConnected({
      clientName: 'claude-ai',
      clientVersion: '0.1.0',
      capSampling: false,
      capElicitation: false,
      capRoots: false,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.batches.flat().some((e) => e.type === 'client_connected')).toBe(false);
  });

  it('is suppressed when inactive', async () => {
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { active: false, flushIntervalMs: 10_000_000 });
    c.recordClientConnected({
      clientName: 'claude-ai',
      clientVersion: '0.1.0',
      capSampling: false,
      capElicitation: false,
      capRoots: false,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.batches).toHaveLength(0);
  });
});

describe('persisted session state carries the new accumulators', () => {
  it('round-trips retry_count / edits_ok / kept_work through the session-state file', () => {
    // persistSessionStateThrottled only writes once per SESSION_PERSIST_THROTTLE_MS (10s),
    // so the second call's persist must land outside that window to actually hit disk.
    let cur = new Date('2026-06-15T12:00:00.000Z');
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { now: () => cur });
    c.recordCall({ tool: 'ps_export', success: true, duration_ms: 1, error_class: null });
    cur = new Date('2026-06-15T12:00:11.000Z'); // +11s, past the throttle window
    c.recordCall({
      tool: 'ps_export',
      success: true,
      duration_ms: 1,
      error_class: null,
      retry: true,
    });
    const state = readSessionState({ dir });
    expect(state?.retry_count).toBe(1);
    expect(state?.edits_ok).toBe(2);
    expect(state?.kept_work).toBe(2);
  });

  it('reconstructs a session_summary from an OLD-FORMAT state file missing the new fields', async () => {
    const dir = freshOutboxDir();
    // Simulates a state file written by a pre-this-change version — none of the new
    // accumulator fields exist on disk.
    const oldState: PersistedSessionState = {
      install_id: 'a'.repeat(32),
      ts_bucket: '2026-06-16',
      editmamei_version: '1.3.0',
      edition: 'community',
      platform: 'darwin',
      ps_version: '27.7.0',
      tool_call_count: 5,
      distinct_tools: 2,
      any_failures: false,
    };
    writeSessionStateSync(oldState, { dir });

    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { outboxDir: dir });
    await expect(c.flushOutboxOnStartup()).resolves.toBeUndefined();

    const summary = rec.batches.flat().find((e) => e.type === 'session_summary') as
      Record<string, unknown> | undefined;
    expect(summary).toBeDefined();
    expect(summary?.tool_call_count).toBe(5);
    // None of the new fields were on disk, so none should appear on the reconstructed event.
    for (const key of [
      'duration_s',
      'retry_count',
      'ended_after_failure',
      'edits_ok',
      'kept_work',
      'behind_latest',
      'dropped_events',
      'module_update',
      'templates_saved',
      'action_sets',
    ]) {
      expect(key in summary!).toBe(false);
    }
  });

  it('re-clamps templates_saved / action_sets read from a persisted state file', async () => {
    // The persisted state is a plain file on disk: a hand edit or a differently-versioned
    // writer can put anything in these fields, same reasoning as the ts_bucket clamp above —
    // one bad count must not reject the whole batch.
    const dir = freshOutboxDir();
    const state: PersistedSessionState = {
      install_id: 'a'.repeat(32),
      ts_bucket: '2026-06-16',
      editmamei_version: '1.3.0',
      edition: 'community',
      platform: 'win32',
      ps_version: 'unknown',
      tool_call_count: 3,
      distinct_tools: 1,
      any_failures: false,
      templates_saved: 6.5,
      action_sets: NaN,
    };
    writeSessionStateSync(state, { dir });

    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { outboxDir: dir });
    await c.flushOutboxOnStartup();

    const summary = rec.batches.flat().find((e) => e.type === 'session_summary') as
      { templates_saved?: number; action_sets?: number } | undefined;
    expect(summary?.templates_saved).toBe(6);
    expect('action_sets' in (summary ?? {})).toBe(false);
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

/** A transport that accepts the first `n` batches and then fails, like a mid-drain outage. */
function failAfter(n: number) {
  const batches: TelemetryEvent[][] = [];
  let calls = 0;
  const transport = async (_url: string, body: string) => {
    calls += 1;
    if (calls > n) throw new Error('network down');
    batches.push((JSON.parse(body) as { events: TelemetryEvent[] }).events);
  };
  return { batches, transport };
}

function usageLine(tool: string): TelemetryEvent {
  return {
    v: 2,
    type: 'usage',
    install_id: 'a'.repeat(32),
    ts_bucket: '2026-06-16',
    editmamei_version: '0.16.4',
    edition: 'community',
    platform: 'darwin',
    ps_version: '27.7.0',
    tool,
    success: true,
    error_class: null,
    duration_ms: 1,
  };
}

type LossCounts = {
  dropped_events: number;
  dropped_outbox: number;
  dropped_unsafe: number;
  usage_calls_sent: number;
  tool_call_count: number;
};

describe('telemetry loss accounting', () => {
  it('reports all four counters, at 0, for an ordinary session', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.recordCall({ tool: 'ps_export', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      LossCounts | undefined;
    // Always present, never omitted-when-zero: a missing field can't be told apart from a
    // client too old to report one, which is the ambiguity that hid this loss for weeks.
    expect(summary).toMatchObject({
      dropped_events: 0,
      dropped_outbox: 0,
      dropped_unsafe: 0,
      usage_calls_sent: 0,
    });
  });

  it('counts an event the content guard refused to send', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    // A tool name shaped like an absolute path fails isContentSafe, so flush drops it.
    c.recordCall({ tool: '/usr/bin/leak', success: true, duration_ms: 1, error_class: null });
    await c.flush();
    expect(rec.batches).toHaveLength(0); // nothing went out…
    c.recordCall({ tool: 'ps_export', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      LossCounts | undefined;
    expect(summary?.dropped_unsafe).toBe(1); // …and the drop is on the record
  });

  it('counts a corrupt outbox line discarded by the startup drain', async () => {
    const rec = recorder();
    const dir = freshOutboxDir();
    appendOutboxSync([usageLine('ps_export')], { dir });
    appendFileSync(outboxPath({ dir }), 'not json at all\n', 'utf8');
    const c = makeClient(makeSettings(), rec, { outboxDir: dir });
    await c.flushOutboxOnStartup();
    c.recordCall({ tool: 'ps_export', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      LossCounts | undefined;
    expect(summary?.dropped_outbox).toBe(1);
  });

  it('counts only usage events in usage_calls_sent, and only once sent', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.recordCall({ tool: 'ps_export', success: true, duration_ms: 1, error_class: null });
    c.recordCall({ tool: 'ps_save_psd', success: true, duration_ms: 1, error_class: null });
    await c.flush();
    c.recordCall({ tool: 'ps_export', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      LossCounts | undefined;
    // Two flushed; the third never left (it went to the outbox at shutdown), and the
    // session_summary riding the same path must not inflate the denominator.
    expect(summary?.usage_calls_sent).toBe(2);
    expect(summary?.tool_call_count ?? 0).toBe(3);
  });

  it('does not count usage events toward sent when the transport fails', async () => {
    const rec = recorder({ fail: true });
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    c.recordCall({ tool: 'ps_export', success: true, duration_ms: 1, error_class: null });
    await c.flush();
    c.recordCall({ tool: 'ps_export', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      LossCounts | undefined;
    expect(summary?.usage_calls_sent).toBe(0);
  });
});

describe('startup outbox drain — partial delivery', () => {
  it('keeps only the undelivered remainder when the drain fails midway', async () => {
    const dir = freshOutboxDir();
    appendOutboxSync(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => usageLine(`ps_${t}`)),
      { dir }
    );
    // Batches of 2: the first two go out, the third throws.
    const rec = failAfter(2);
    const c = makeClient(makeSettings(), rec, { outboxDir: dir, maxBatchSize: 2 });
    await c.flushOutboxOnStartup();

    expect(rec.batches).toHaveLength(2);
    const remaining = readOutbox({ dir }).map((e) => (e as { tool: string }).tool);
    // The four delivered events are GONE from the file. Before this fix the drain cleared
    // nothing on a partial failure, so the next startup re-sent ps_a..ps_d and the server
    // counted them twice — inflation, the mirror image of the loss being chased here.
    expect(remaining).toEqual(['ps_e', 'ps_f']);
  });

  it('clears the outbox entirely when every batch lands', async () => {
    const dir = freshOutboxDir();
    appendOutboxSync(
      ['a', 'b', 'c'].map((t) => usageLine(`ps_${t}`)),
      { dir }
    );
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { outboxDir: dir, maxBatchSize: 2 });
    await c.flushOutboxOnStartup();
    expect(readOutbox({ dir })).toHaveLength(0);
  });

  it('keeps everything when the very first batch fails', async () => {
    const dir = freshOutboxDir();
    appendOutboxSync(
      ['a', 'b', 'c'].map((t) => usageLine(`ps_${t}`)),
      { dir }
    );
    const rec = failAfter(0);
    const c = makeClient(makeSettings(), rec, { outboxDir: dir, maxBatchSize: 2 });
    await c.flushOutboxOnStartup();
    expect(readOutbox({ dir }).map((e) => (e as { tool: string }).tool)).toEqual([
      'ps_a',
      'ps_b',
      'ps_c',
    ]);
  });
});

function startLine(): TelemetryEvent {
  return {
    v: 2,
    type: 'session_start',
    install_id: 'a'.repeat(32),
    ts_bucket: '2026-06-16',
    editmamei_version: '0.16.4',
    edition: 'community',
    platform: 'darwin',
    ps_version: '27.7.0',
    channel: 'npm',
  };
}

describe('shutdown ordering and loss carry-through', () => {
  it('the summary reports discards from its OWN shutdown drain', async () => {
    // The discriminating test for the doShutdown reorder. The unsafe event is left IN THE
    // QUEUE — never explicitly flushed — so it is only discarded during shutdown's drain.
    // Build the summary first (the old order) and this reads 0; drain first and it reads 1.
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec, { maxBatchSize: 1_000_000 });
    c.recordCall({ tool: '/usr/bin/leak', success: true, duration_ms: 1, error_class: null });
    c.recordCall({ tool: 'ps_export', success: true, duration_ms: 1, error_class: null });
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      LossCounts | undefined;
    expect(summary?.dropped_unsafe).toBe(1);
  });

  it('emits a summary for a run that made no tool calls but has loss to report', async () => {
    // The startup drain is the ONLY place the outbox bound's discards are observed, and it
    // runs before any tool call. Gating the summary on tool_call_count alone threw that
    // measurement away on exactly the boots most likely to have a backlog.
    const dir = freshOutboxDir();
    appendOutboxSync([usageLine('ps_export'), usageLine('ps_save_psd')], { dir });
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { outboxDir: dir });
    await c.flushOutboxOnStartup();
    await c.shutdown(); // no recordCall at all
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      LossCounts | undefined;
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({ tool_call_count: 0, usage_calls_sent: 2 });
  });

  it('still emits nothing for a run with neither calls nor loss', async () => {
    const rec = recorder();
    const { client: c, dir } = makeClientD(makeSettings(), rec);
    await c.shutdown();
    expect(readOutbox({ dir }).filter((e) => e.type === 'session_summary')).toHaveLength(0);
  });

  it('counts only usage events in usage_calls_sent when the batch is mixed', async () => {
    // A mixed batch is the case that discriminates countUsageCalls from `batch.length` —
    // the earlier flush-based test could never have contained a non-usage event.
    const dir = freshOutboxDir();
    appendOutboxSync([startLine(), usageLine('ps_a'), usageLine('ps_b'), usageLine('ps_c')], {
      dir,
    });
    const rec = recorder();
    const c = makeClient(makeSettings(), rec, { outboxDir: dir });
    await c.flushOutboxOnStartup();
    await c.shutdown();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      LossCounts | undefined;
    expect(summary?.usage_calls_sent).toBe(3); // 4 events delivered, 3 of them calls
  });
});

describe('crash-recovered summary carries the loss counters', () => {
  it('reconstructs them from a state file written by this build', async () => {
    const dir = freshOutboxDir();
    const state: PersistedSessionState = {
      install_id: 'a'.repeat(32),
      ts_bucket: '2026-06-16',
      editmamei_version: '0.16.4',
      edition: 'community',
      platform: 'darwin',
      ps_version: '27.7.0',
      tool_call_count: 12,
      distinct_tools: 4,
      any_failures: false,
      dropped_outbox: 9,
      dropped_unsafe: 1,
      usage_calls_sent: 11,
    };
    writeSessionStateSync(state, { dir });
    const rec = recorder({ fail: true }); // keep the reconstructed summary on disk
    const c = makeClient(makeSettings(), rec, { outboxDir: dir });
    await c.flushOutboxOnStartup();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      LossCounts | undefined;
    expect(summary).toMatchObject({ dropped_outbox: 9, dropped_unsafe: 1, usage_calls_sent: 11 });
  });

  it('omits them for a state file written by an older build', async () => {
    // The backward-compat contract: every field added after v2 is optional on the state file,
    // so an older build's leftover state must reconstruct WITHOUT them, not as false zeroes.
    const dir = freshOutboxDir();
    const legacy: PersistedSessionState = {
      install_id: 'a'.repeat(32),
      ts_bucket: '2026-06-16',
      editmamei_version: '0.16.4',
      edition: 'community',
      platform: 'darwin',
      ps_version: '27.7.0',
      tool_call_count: 3,
      distinct_tools: 2,
      any_failures: false,
    };
    writeSessionStateSync(legacy, { dir });
    const rec = recorder({ fail: true });
    const c = makeClient(makeSettings(), rec, { outboxDir: dir });
    await c.flushOutboxOnStartup();
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      Record<string, unknown> | undefined;
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({ tool_call_count: 3 });
    expect('dropped_outbox' in (summary ?? {})).toBe(false);
    expect('usage_calls_sent' in (summary ?? {})).toBe(false);
  });
});

describe('startup outbox drain — remaining boundaries', () => {
  it('keeps just the final batch when the LAST batch fails', async () => {
    const dir = freshOutboxDir();
    appendOutboxSync(
      ['a', 'b', 'c', 'd'].map((t) => usageLine(`ps_${t}`)),
      { dir }
    );
    const rec = failAfter(1); // batches of 2: first lands, second throws
    const c = makeClient(makeSettings(), rec, { outboxDir: dir, maxBatchSize: 2 });
    await c.flushOutboxOnStartup();
    expect(readOutbox({ dir }).map((e) => (e as { tool: string }).tool)).toEqual(['ps_c', 'ps_d']);
  });

  it('handles a non-multiple length with a partial failure', async () => {
    const dir = freshOutboxDir();
    appendOutboxSync(
      ['a', 'b', 'c', 'd', 'e'].map((t) => usageLine(`ps_${t}`)),
      { dir }
    );
    const rec = failAfter(2); // 2 + 2 land, the 1-event remainder throws
    const c = makeClient(makeSettings(), rec, { outboxDir: dir, maxBatchSize: 2 });
    await c.flushOutboxOnStartup();
    expect(readOutbox({ dir }).map((e) => (e as { tool: string }).tool)).toEqual(['ps_e']);
  });

  it('discards a wholly-unsafe batch rather than retrying it forever', async () => {
    // A batch every one of whose events fails the content guard can never be sent. It must be
    // counted and dropped, not written back — otherwise it is re-counted at every boot.
    const dir = freshOutboxDir();
    appendOutboxSync([usageLine('/usr/bin/leak'), usageLine('/etc/shadow')], { dir });
    const rec = failAfter(0);
    const c = makeClient(makeSettings(), rec, { outboxDir: dir, maxBatchSize: 2 });
    await c.flushOutboxOnStartup();
    await c.shutdown();
    expect(readOutbox({ dir }).filter((e) => e.type === 'usage')).toHaveLength(0);
    const summary = readOutbox({ dir }).find((e) => e.type === 'session_summary') as
      LossCounts | undefined;
    expect(summary?.dropped_unsafe).toBe(2);
  });

  it('does not re-count an unsafe event left behind by a failed drain', async () => {
    // The unsafe event sits in a batch that fails to send. The remainder written back must
    // exclude it, or the next boot counts the same single bad event all over again.
    const dir = freshOutboxDir();
    appendOutboxSync([usageLine('/usr/bin/leak'), usageLine('ps_export')], { dir });
    const rec = failAfter(0);
    const c = makeClient(makeSettings(), rec, { outboxDir: dir, maxBatchSize: 2 });
    await c.flushOutboxOnStartup();
    const kept = readOutbox({ dir }).map((e) => (e as { tool: string }).tool);
    expect(kept).toEqual(['ps_export']); // the safe event retried, the unsafe one gone for good
  });
});
