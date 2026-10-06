/**
 * A COMMUNITY-edition boot, GIMP detected and unpinned: the full `ps_*`
 * surface registers alongside every community-tier `gimp_*` tool, whatever
 * tier the gimp_* tools carry (the edition filter decides which of them
 * ship; it never removes the Photoshop tools). Mirrors the
 * `EDITION` mock pattern used by `ce-loads-pro-module.test.ts` /
 * `server-module-load.test.ts` — a dedicated file, not a case inside
 * `server.test.ts`, because `vi.mock('@editmamei/edition.ts', ...)` applies
 * to every test in the file it's declared in.
 */
import { vi, describe, it, expect } from 'vitest';

vi.mock('@editmamei/edition.ts', () => ({ EDITION: 'community' }));

import { EditmameiServer } from '@editmamei/core/server.ts';
import { resolveEditorRegistration } from '@editmamei/backends/detect-editors.ts';
import { toolsInTier } from '@editmamei/core/tool-tiers.ts';
import type { GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';

useSessionLogSandbox();

const SAMPLE_GIMP_INSTALL: GimpInstall = {
  source: 'conventional',
  path: 'C:/Program Files/GIMP 3/bin/gimp-console-3.2.exe',
  launch: { command: 'C:/Program Files/GIMP 3/bin/gimp-console-3.2.exe', args: [] },
};

describe('community edition, GIMP detected, unpinned', () => {
  it('registers the full ps_* surface plus the gimp_* tools the edition allows', () => {
    const editors = resolveEditorRegistration(
      { gimp: SAMPLE_GIMP_INSTALL, timedOut: false },
      'auto'
    );
    const server = new EditmameiServer({ editors }) as unknown as {
      toolRegistry: { list(): Array<{ name: string }>; count(): number };
    };
    const names = server.toolRegistry.list().map((t) => t.name);

    expect(names).toContain('ps_ping');
    expect(names).toContain('ps_list_capabilities');
    expect(names).toContain('ps_report_problem');
    for (const n of ['ps_select', 'ps_add_adjustment_layer', 'ps_export', 'ps_filter']) {
      expect(names).toContain(n);
    }
    // A count floor, not an exact pin — the community ps_* surface today is
    // 60+ tools; this only needs to prove it's the FULL surface, not a
    // truncated one.
    expect(server.toolRegistry.count()).toBeGreaterThan(50);

    // The gimp_* tools a community build carries are exactly the ones the
    // tier table allows there, through the SAME edition filter
    // (isToolAllowedInEdition) that governs every other tool. All 23 ship in
    // the beta; pinning the count keeps an empty tier from passing as equal.
    const expectedGimp = toolsInTier('community')
      .filter((n) => n.startsWith('gimp_'))
      .sort();
    expect(expectedGimp).toHaveLength(23);
    expect(names.filter((n) => n.startsWith('gimp_')).sort()).toEqual(expectedGimp);
  });
});
