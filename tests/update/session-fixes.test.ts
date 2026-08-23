import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { previousSessionFailureCounts, relevantFixes } from '@editmamei/update/session-fixes.ts';

/** One v2 call line. */
function callLine(sessionId: string, tool: string, success: boolean): string {
  return JSON.stringify({
    v: 2,
    type: 'call',
    ts: '2026-08-23T10:00:00.000Z',
    session_id: sessionId,
    seq: 1,
    tool,
    args: {},
    success,
    duration_ms: 100,
    editmamei_version: '1.0.3',
    edition: 'community',
    platform: 'win32',
    ps_version: null,
    result_bytes: 10,
    retry_signal: false,
    ...(success ? {} : { error_class: 'other', error: 'boom' }),
  });
}

function metaLine(sessionId: string): string {
  return JSON.stringify({
    v: 2,
    type: 'meta',
    ts: '2026-08-23T10:00:00.000Z',
    session_id: sessionId,
    editmamei_version: '1.0.3',
    edition: 'community',
    platform: 'win32',
    ps_version: null,
    mcp_client: null,
  });
}

async function writeSession(
  dir: string,
  sessionId: string,
  lines: string[],
  mtimeSecondsAgo: number
): Promise<void> {
  const path = join(dir, `${sessionId}.ndjson`);
  await writeFile(path, lines.join('\n') + '\n', 'utf8');
  // Deterministic recency ordering regardless of write speed.
  const t = new Date(Date.now() - mtimeSecondsAgo * 1000);
  await utimes(path, t, t);
}

describe('previousSessionFailureCounts', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'em-session-fixes-'));
  });

  it('counts the failed tools of the most recent session that is not the current one', async () => {
    await writeSession(dir, 'current', [metaLine('current')], 0);
    await writeSession(
      dir,
      'prev',
      [
        metaLine('prev'),
        callLine('prev', 'ps_delete_layer', false),
        callLine('prev', 'ps_delete_layer', false),
        callLine('prev', 'ps_delete_layer', true),
        callLine('prev', 'ps_select_layer', false),
        callLine('prev', 'ps_export', true),
      ],
      60
    );
    await writeSession(dir, 'older', [callLine('older', 'ps_export', false)], 3600);

    const counts = await previousSessionFailureCounts('current', { dir });
    expect(counts.get('ps_delete_layer')).toBe(2);
    expect(counts.get('ps_select_layer')).toBe(1);
    expect(counts.has('ps_export')).toBe(false); // older session not read; successes not counted
  });

  it('treats a type-less v1 line as a call line', async () => {
    await writeSession(
      dir,
      'prev',
      [JSON.stringify({ tool: 'ps_crop_document', success: false })],
      60
    );
    const counts = await previousSessionFailureCounts('current', { dir });
    expect(counts.get('ps_crop_document')).toBe(1);
  });

  it('is empty when the only session on disk is the current one', async () => {
    await writeSession(dir, 'current', [metaLine('current')], 0);
    expect((await previousSessionFailureCounts('current', { dir })).size).toBe(0);
  });

  it('skips call-less sessions (client restarts) when picking the previous session', async () => {
    // Realistic sequence: failures, then an open-and-close client start that
    // logged only a meta line, then the current session. The empty file must
    // not hide the real previous session behind it.
    await writeSession(dir, 'current', [metaLine('current')], 0);
    await writeSession(dir, 'empty-restart', [metaLine('empty-restart')], 30);
    await writeSession(
      dir,
      'real-prev',
      [metaLine('real-prev'), callLine('real-prev', 'ps_delete_layer', false)],
      120
    );
    const counts = await previousSessionFailureCounts('current', { dir });
    expect(counts.get('ps_delete_layer')).toBe(1);
  });

  it('a clean previous session answers zero counts rather than scanning further back', async () => {
    // Failures two sessions ago must NOT be reported as "last session" when
    // the actual last working session was clean.
    await writeSession(dir, 'current', [metaLine('current')], 0);
    await writeSession(dir, 'clean-prev', [callLine('clean-prev', 'ps_export', true)], 30);
    await writeSession(
      dir,
      'older-failures',
      [callLine('older-failures', 'ps_delete_layer', false)],
      300
    );
    const counts = await previousSessionFailureCounts('current', { dir });
    expect(counts.size).toBe(0);
  });

  it('is empty for a missing directory', async () => {
    const counts = await previousSessionFailureCounts('current', {
      dir: join(dir, 'does-not-exist'),
    });
    expect(counts.size).toBe(0);
  });
});

describe('relevantFixes', () => {
  const counts = new Map<string, number>([
    ['ps_delete_layer', 10],
    ['ps_select_layer', 3],
    ['ps_export', 6],
    ['ps_group', 1],
  ]);

  it('intersects, sorts most-failed first, and caps', () => {
    expect(
      relevantFixes(counts, ['ps_select_layer', 'ps_delete_layer', 'ps_never_failed'])
    ).toEqual([
      { tool: 'ps_delete_layer', failures: 10 },
      { tool: 'ps_select_layer', failures: 3 },
    ]);
    expect(
      relevantFixes(counts, ['ps_group', 'ps_select_layer', 'ps_delete_layer', 'ps_export'], 2)
    ).toEqual([
      { tool: 'ps_delete_layer', failures: 10 },
      { tool: 'ps_export', failures: 6 },
    ]);
  });

  it('is empty when nothing intersects', () => {
    expect(relevantFixes(counts, ['ps_other'])).toEqual([]);
    expect(relevantFixes(new Map(), ['ps_delete_layer'])).toEqual([]);
  });
});
