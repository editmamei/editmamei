/**
 * What the MODEL reads when a GIMP op runs long, end to end through the real tool handlers,
 * `GimpBackend`, and `GimpSession` (only the GIMP process is faked). A slow op is never killed: its
 * call says it is still running, and the next call says how it ended. Only an op that stays
 * unanswered past the hung limit stops GIMP, and every image id the model holds dies with it; that
 * result and the first call that trips over a dead id must say so and say how to recover.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GimpBackend, lateResultsNote } from '@editmamei/backends/gimp/backend.ts';
import { ToolRegistry } from '@editmamei/core/tool-registry.ts';
import { withLateNote } from '@editmamei/tools/gimp-shared.ts';
import type { GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { createGimpDocumentTools } from '@editmamei/tools/gimp-document-tools.ts';
import { createGimpVerifyTools } from '@editmamei/tools/gimp-verify-tools.ts';
import { runWithToolBudget } from '@editmamei/utils/tool-budget-context.ts';
import { fakeGimpSpawn } from '../fixtures/fake-gimp-process.ts';
import { callTool } from '../fixtures/tool-helpers.ts';

const INSTALL: GimpInstall = {
  source: 'conventional',
  path: 'FAKE_GIMP_CONSOLE',
  launch: { command: 'FAKE_GIMP_CONSOLE', args: [] },
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const RECOVERY =
  'every open image and unsaved filter is gone — reopen the file with gimp_open_document';

describe('a slow op, then the next call, as the model sees them', () => {
  it('the slow call says it is still running; the next one runs after it and says how it ended', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-tool-errors-'));
    const fake = fakeGimpSpawn({
      delayOps: new Map([['export', 150]]),
      responder: (op) => {
        if (op === 'ping') return { major: 3, minor: 2, micro: 6, images: [] };
        if (op === 'histogram') return { channels: {} };
        return {};
      },
    });
    const killTree = vi.fn();
    const backend = new GimpBackend(INSTALL, {
      sessionOptions: { rootDir, spawn: fake.spawn, killTree },
    });
    cleanups.push(() => rmSync(rootDir, { recursive: true, force: true }));
    cleanups.push(() => fake.stop());
    cleanups.push(() => backend.shutdown());
    const registry = new ToolRegistry({
      decorate: (tool, result) => withLateNote(result, lateResultsNote(backend.takeLateResults())),
    });
    const tools = [
      ...createGimpDocumentTools(backend),
      ...createGimpVerifyTools(backend, { previewsAllowed: () => false }),
    ];
    registry.registerAll(tools);
    await backend.call('ping', {});

    const saveResult = await runWithToolBudget(
      { toolName: 'gimp_save_xcf', budgetMs: 40, deadline: Date.now() + 40 },
      () => callTool(tools, 'gimp_save_xcf', { image: 1, file_path: join(rootDir, 'later.xcf') })
    );
    expect(saveResult.isError).toBe(true);
    const saveText = (saveResult.content?.[0] as { text: string }).text;
    expect(saveText).toMatch(
      /gimp_still_working: export is taking longer than \d+ s and is still running in GIMP; nothing it changes is lost/
    );
    expect(saveText).not.toContain(RECOVERY);
    expect(killTree).not.toHaveBeenCalled();

    const histogramResult = await registry.execute('gimp_get_histogram', { image: 1 });
    const histogramText = (histogramResult.content?.[0] as { text: string }).text;
    expect(histogramText).toMatch(
      /^The earlier export that was still running has finished \(it took \d+ s\), but its answer was not returned: an edit it made is in the image; for an open or anything it read, check with gimp_inspect/
    );
    expect(fake.children).toHaveLength(1); // never restarted
  });
});

describe('an op stuck past the hung limit, then the next call, as the model sees them', () => {
  it('both tool results say the session restarted and how to recover', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'em-gimp-tool-errors-'));
    const fake = fakeGimpSpawn({
      hangOps: new Set(['export']),
      responder: (op) => {
        if (op === 'ping') return { major: 3, minor: 2, micro: 6, images: [] };
        if (op === 'histogram') {
          throw Object.assign(new Error('ValueError: no open image with id 1'), {
            code: 'invalid_argument',
          });
        }
        return {};
      },
    });
    const backend = new GimpBackend(INSTALL, {
      sessionOptions: { rootDir, spawn: fake.spawn, killTree: vi.fn(), hungAfterMs: 60 },
    });
    cleanups.push(() => rmSync(rootDir, { recursive: true, force: true }));
    cleanups.push(() => fake.stop());
    cleanups.push(() => backend.shutdown());

    const tools = [
      ...createGimpDocumentTools(backend),
      ...createGimpVerifyTools(backend, { previewsAllowed: () => false }),
    ];
    await backend.call('ping', {}); // a warm session, so the timeout below is a restart, not a first launch

    const saveResult = await runWithToolBudget(
      { toolName: 'gimp_save_xcf', budgetMs: 5_000, deadline: Date.now() + 5_000 },
      () =>
        callTool(tools, 'gimp_save_xcf', {
          image: 1,
          file_path: join(rootDir, 'never-written.xcf'),
        })
    );
    expect(saveResult.isError).toBe(true);
    const saveText = (saveResult.content?.[0] as { text: string }).text;
    expect(saveText).toMatch(
      /gimp_timeout: export gave no answer for 1 s, so GIMP was treated as stuck and stopped/
    );
    expect(saveText).toContain(RECOVERY);

    const histogramResult = await callTool(tools, 'gimp_get_histogram', { image: 1 });
    expect(histogramResult.isError).toBe(true);
    const histogramText = (histogramResult.content?.[0] as { text: string }).text;
    expect(histogramText).toMatch(
      /gimp_session_restarted: that image id is not open. The GIMP session restarted/
    );
    expect(histogramText).toContain(RECOVERY);
    expect(fake.children).toHaveLength(2); // the timeout killed GIMP; the histogram call restarted it
  });
});

describe('withLateNote', () => {
  it('puts the note first in the text and in structuredContent, and leaves a result with no note alone', () => {
    const result = {
      content: [{ type: 'text' as const, text: 'Histogram ready.' }],
      structuredContent: { mean: 1 },
    };
    expect(withLateNote(result, '')).toBe(result);
    const noted = withLateNote(result, 'The earlier resize finished.');
    expect((noted.content[0] as { text: string }).text).toBe(
      'The earlier resize finished.\nHistogram ready.'
    );
    expect(noted.structuredContent).toEqual({
      mean: 1,
      earlier_operations: 'The earlier resize finished.',
    });
  });

  it('adds a text item when the result has none', () => {
    const noted = withLateNote({ content: [] }, 'The earlier resize finished.');
    expect(noted.content).toEqual([{ type: 'text', text: 'The earlier resize finished.' }]);
    expect(noted.structuredContent).toBeUndefined();
  });
});
