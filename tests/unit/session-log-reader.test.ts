import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionLog, listRecentSessionIds } from '@editmamei/utils/session-log-reader.ts';
import { SessionLog } from '@editmamei/utils/session-log.ts';

describe('readSessionLog', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'editmamei-sessionlog-reader-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('returns [] when the log file does not exist', async () => {
    const entries = await readSessionLog('does-not-exist', { dir });
    expect(entries).toEqual([]);
  });

  it('returns [] when the file exists but is empty', async () => {
    await writeFile(join(dir, 'empty.ndjson'), '', 'utf8');
    const entries = await readSessionLog('empty', { dir });
    expect(entries).toEqual([]);
  });

  it('roundtrips entries written by SessionLog', async () => {
    const log = new SessionLog('roundtrip', { dir });
    await log.append({ tool: 'ps_ping', args: {}, success: true, duration_ms: 10 });
    await log.append({
      tool: 'photoshop_get_metadata',
      args: { sections: ['context'] },
      success: true,
      duration_ms: 42,
    });
    await log.append({
      tool: 'ps_execute_script',
      args: { code: 'app.activeDocument.name' },
      success: false,
      duration_ms: 100,
      error: 'no doc',
    });

    // Schema v2 emits a meta line before the first call line.
    const entries = await readSessionLog('roundtrip', { dir });

    const metas = entries.filter((e) => e.type === 'meta') as Array<{
      type: string;
      v: number;
      session_id: string;
    }>;
    expect(metas).toHaveLength(1);
    expect(metas[0].v).toBe(2);
    expect(metas[0].session_id).toBe('roundtrip');

    const calls = entries.filter((e) => e.type === 'call') as Array<{
      tool: string;
      args: Record<string, unknown>;
      success: boolean;
      error?: string;
    }>;
    expect(calls).toHaveLength(3);
    expect(calls[0].tool).toBe('ps_ping');
    expect(calls[1].args).toEqual({ sections: ['context'] });
    expect(calls[2].success).toBe(false);
    expect(calls[2].error).toBe('no doc');
  });

  it('skips a malformed last line (partial-write race)', async () => {
    const path = join(dir, 'partial.ndjson');
    const good = JSON.stringify({
      v: 1,
      ts: '2026-05-27T00:00:00.000Z',
      session_id: 'partial',
      tool: 'a',
      args: {},
      success: true,
      duration_ms: 1,
    });
    await writeFile(path, good + '\n' + '{"tool":"b","args":', 'utf8');
    const entries = await readSessionLog('partial', { dir });
    expect(entries).toHaveLength(1);
    expect((entries[0] as { tool: string }).tool).toBe('a');
  });

  it('survives partial mid-file corruption (warns + skips, keeps reading)', async () => {
    const path = join(dir, 'mid-bad.ndjson');
    const a = JSON.stringify({
      v: 1,
      ts: 't',
      session_id: 's',
      tool: 'a',
      args: {},
      success: true,
      duration_ms: 1,
    });
    const c = JSON.stringify({
      v: 1,
      ts: 't',
      session_id: 's',
      tool: 'c',
      args: {},
      success: true,
      duration_ms: 1,
    });
    await writeFile(path, `${a}\nNOT_JSON_HERE\n${c}\n`, 'utf8');
    const entries = await readSessionLog('mid-bad', { dir });
    expect(entries.map((e) => (e as { tool: string }).tool)).toEqual(['a', 'c']);
  });

  it('returns [] when the parent dir does not exist (ENOENT path)', async () => {
    const ghostDir = join(dir, 'definitely-not-real');
    // ensure parent exists but ghostDir doesn't
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    const entries = await readSessionLog('whatever', { dir: ghostDir });
    expect(entries).toEqual([]);
  });
});

describe('listRecentSessionIds', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'editmamei-sessionlist-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('returns ids newest-first and respects the limit', async () => {
    // Write three files with increasing mtimes (oldest → newest).
    for (const [name, ms] of [
      ['old', 1_000_000],
      ['mid', 2_000_000],
      ['new', 3_000_000],
    ] as const) {
      const path = join(dir, `${name}.ndjson`);
      await writeFile(path, '{}\n', 'utf8');
      const { utimes } = await import('node:fs/promises');
      await utimes(path, new Date(ms), new Date(ms));
    }
    const ids = await listRecentSessionIds(2, { dir });
    expect(ids).toEqual(['new', 'mid']);
  });

  it('ignores non-ndjson files', async () => {
    await writeFile(join(dir, 's.ndjson'), '{}\n', 'utf8');
    await writeFile(join(dir, 'notes.txt'), 'hi', 'utf8');
    const ids = await listRecentSessionIds(10, { dir });
    expect(ids).toEqual(['s']);
  });

  it('returns [] for a missing directory', async () => {
    const ids = await listRecentSessionIds(5, { dir: join(dir, 'nope') });
    expect(ids).toEqual([]);
  });
});
