import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendOutboxSync,
  claimOutboxForDrain,
  outboxPath,
  readOutbox,
  MAX_OUTBOX_BYTES,
} from '@editmamei/telemetry/outbox.ts';
import type { TelemetryEvent } from '@editmamei/telemetry/events.ts';

// Interleavings between processes are driven through two fs seams: a one-shot hook that runs
// right after the next readFileSync returns (standing in for a sibling acting at that moment),
// and a predicate that makes rmSync fail for matching paths (a Windows EBUSY/EPERM).
const fsHooks = vi.hoisted(() => ({
  afterNextRead: null as null | (() => void),
  rmFails: null as null | ((path: string) => boolean),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const out = actual.readFileSync(...args);
      const hook = fsHooks.afterNextRead;
      if (hook) {
        fsHooks.afterNextRead = null;
        hook();
      }
      return out;
    }) as typeof actual.readFileSync,
    rmSync: ((...args: Parameters<typeof actual.rmSync>) => {
      if (fsHooks.rmFails?.(String(args[0]))) {
        throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      }
      return actual.rmSync(...args);
    }) as typeof actual.rmSync,
  };
});

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'editmamei-claims-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  fsHooks.afterNextRead = null;
  fsHooks.rmFails = null;
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
    editmamei_version: '1.7.0',
    edition: 'community',
    platform: 'darwin',
    ps_version: '27.7.0',
    tool,
    success: true,
    error_class: null,
    duration_ms: 1,
  };
}

/** A usage event padded to roughly `bytes`, tagged with a short marker. */
function fat(bytes: number, marker: string): TelemetryEvent {
  const pad = Math.max(1, bytes - JSON.stringify(usage(marker)).length);
  return usage(`${marker}_${'a'.repeat(pad)}`);
}

const marker = (e: TelemetryEvent) => (e as { tool: string }).tool.split('_')[0]!;
const claimFiles = (dir: string) =>
  readdirSync(dir).filter((n) => n.includes('.ndjson') && n !== 'telemetry-outbox.ndjson');

const COMPACTOR = 3001;
const DRAINER = 3002;
const NEXT_BOOT = 3003;
const alive =
  (...pids: number[]) =>
  (pid: number) =>
    pids.includes(pid);

describe('compaction and drains share one claim protocol', () => {
  it('a drain running while a compaction holds the outbox sends each event once', () => {
    const dir = freshDir();
    // Ten events, together over the byte cap, written straight to disk so no append compacts
    // them on the way in.
    const backlog = Array.from({ length: 10 }, (_v, i) => fat(MAX_OUTBOX_BYTES / 8, `e${i}`));
    writeFileSync(outboxPath({ dir }), backlog.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const isPidAlive = alive(COMPACTOR, DRAINER);

    // A sibling's startup drain runs the moment the compactor has read the outbox.
    const sent: TelemetryEvent[] = [];
    fsHooks.afterNextRead = () => {
      const drain = claimOutboxForDrain({ dir, pid: DRAINER, isPidAlive });
      sent.push(...drain.events);
      drain.release([]);
    };
    const discarded = appendOutboxSync([usage('trigger')], { dir, pid: COMPACTOR, isPidAlive });
    expect(fsHooks.afterNextRead).toBeNull(); // the race was actually exercised

    // Both processes have exited; the next boot drains whatever is left.
    const next = claimOutboxForDrain({ dir, pid: NEXT_BOOT, isPidAlive: alive() });
    sent.push(...next.events);
    next.release([]);

    const markers = sent.map(marker);
    expect(new Set(markers).size).toBe(markers.length);
    expect(markers).toContain('trigger');
    expect(markers).toContain('e9'); // compaction keeps the newest
    expect(markers.length + discarded).toBe(backlog.length + 1);
    expect(claimFiles(dir)).toEqual([]);
    expect(readOutbox({ dir })).toEqual([]);
  });
});

describe('a claim that cannot be deleted', () => {
  it('is emptied instead, so a later drain does not send it again', () => {
    const dir = freshDir();
    appendOutboxSync([usage('a'), usage('b')], { dir });
    fsHooks.rmFails = (path) => path.includes('.draining.');

    const first = claimOutboxForDrain({ dir, pid: DRAINER, isPidAlive: alive() });
    expect(first.events.map(marker)).toEqual(['a', 'b']);
    first.release([]);
    expect(claimFiles(dir)).toHaveLength(1); // still there, but empty

    fsHooks.rmFails = null;
    const second = claimOutboxForDrain({ dir, pid: NEXT_BOOT, isPidAlive: alive() });
    expect(second.events).toEqual([]);
    second.release([]);
    expect(claimFiles(dir)).toEqual([]);
  });
});
