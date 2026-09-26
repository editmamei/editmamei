/**
 * What the MODEL reads when a GIMP op times out and the session restarts, end to end through the
 * real tool handlers, `GimpBackend`, and `GimpSession` (only the GIMP process is faked). A
 * timeout kills GIMP, and every image id the model holds dies with it; both the timeout itself
 * and the first call that trips over a dead id must say so and say how to recover.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GimpBackend } from '@editmamei/backends/gimp/backend.ts';
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

describe('a timeout, then the next call, as the model sees them', () => {
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
      sessionOptions: { rootDir, spawn: fake.spawn, killTree: vi.fn() },
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
      { toolName: 'gimp_save_xcf', budgetMs: 80, deadline: Date.now() + 80 },
      () =>
        callTool(tools, 'gimp_save_xcf', {
          image: 1,
          file_path: join(rootDir, 'never-written.xcf'),
        })
    );
    expect(saveResult.isError).toBe(true);
    const saveText = (saveResult.content?.[0] as { text: string }).text;
    expect(saveText).toMatch(
      /gimp_timeout: export did not respond within \d+ms, so the GIMP session was stopped/
    );
    expect(saveText).toContain(RECOVERY);

    const histogramResult = await callTool(tools, 'gimp_get_histogram', { image: 1 });
    expect(histogramResult.isError).toBe(true);
    const histogramText = (histogramResult.content?.[0] as { text: string }).text;
    expect(histogramText).toMatch(
      /gimp_session_restarted: .*GIMP session restarted since it was opened/
    );
    expect(histogramText).toContain(RECOVERY);
    expect(fake.children).toHaveLength(2); // the timeout killed GIMP; the histogram call restarted it
  });
});
