import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendOutboxSync,
  readOutbox,
  clearOutbox,
  outboxPath,
  writeSessionStateSync,
  readSessionState,
  clearSessionState,
  sessionStatePath,
  MAX_OUTBOX_EVENTS,
  type PersistedSessionState,
} from '@editmamei/telemetry/outbox.ts';
import type { TelemetryEvent } from '@editmamei/telemetry/events.ts';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'editmamei-outbox-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function usage(tool: string): TelemetryEvent {
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

const STATE: PersistedSessionState = {
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

describe('outbox events', () => {
  it('append + read round-trips events', () => {
    const dir = freshDir();
    appendOutboxSync([usage('photoshop_a'), usage('photoshop_b')], { dir });
    appendOutboxSync([usage('photoshop_c')], { dir });
    const got = readOutbox({ dir });
    expect(got.map((e) => (e as { tool: string }).tool)).toEqual([
      'photoshop_a',
      'photoshop_b',
      'photoshop_c',
    ]);
  });

  it('append of an empty array is a no-op (no file created)', () => {
    const dir = freshDir();
    appendOutboxSync([], { dir });
    expect(readOutbox({ dir })).toEqual([]);
  });

  it('read returns [] for a missing outbox', () => {
    expect(readOutbox({ dir: freshDir() })).toEqual([]);
  });

  it('read skips a corrupt line rather than discarding the whole file', () => {
    const dir = freshDir();
    appendOutboxSync([usage('photoshop_a')], { dir });
    appendFileSync(outboxPath({ dir }), 'not json at all\n', 'utf8');
    appendOutboxSync([usage('photoshop_b')], { dir });
    const got = readOutbox({ dir }).map((e) => (e as { tool: string }).tool);
    expect(got).toEqual(['photoshop_a', 'photoshop_b']);
  });

  it('bounds the result to the most recent MAX_OUTBOX_EVENTS', () => {
    const dir = freshDir();
    const many = Array.from({ length: MAX_OUTBOX_EVENTS + 50 }, (_v, i) => usage(`photoshop_${i}`));
    appendOutboxSync(many, { dir });
    const got = readOutbox({ dir });
    expect(got).toHaveLength(MAX_OUTBOX_EVENTS);
    // The OLDEST 50 were dropped — first kept is photoshop_50.
    expect((got[0] as { tool: string }).tool).toBe('photoshop_50');
  });

  it('clear removes the outbox', () => {
    const dir = freshDir();
    appendOutboxSync([usage('photoshop_a')], { dir });
    clearOutbox({ dir });
    expect(readOutbox({ dir })).toEqual([]);
  });
});

describe('session state', () => {
  it('write + read round-trips the session state', () => {
    const dir = freshDir();
    writeSessionStateSync(STATE, { dir });
    expect(readSessionState({ dir })).toEqual(STATE);
  });

  it('overwrites on repeated writes (latest wins)', () => {
    const dir = freshDir();
    writeSessionStateSync(STATE, { dir });
    writeSessionStateSync({ ...STATE, tool_call_count: 9, distinct_tools: 5 }, { dir });
    expect(readSessionState({ dir })?.tool_call_count).toBe(9);
  });

  it('read returns null when absent', () => {
    expect(readSessionState({ dir: freshDir() })).toBeNull();
  });

  it('read returns null on a corrupt / partial file', () => {
    const dir = freshDir();
    writeFileSync(sessionStatePath({ dir }), '{ not valid', 'utf8');
    expect(readSessionState({ dir })).toBeNull();
  });

  it('clear removes the marker', () => {
    const dir = freshDir();
    writeSessionStateSync(STATE, { dir });
    clearSessionState({ dir });
    expect(readSessionState({ dir })).toBeNull();
  });
});
