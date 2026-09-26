/**
 * A COMMUNITY-edition boot, GIMP detected and unpinned: the full `ps_*`
 * surface must still register even though every `gimp_*` tool is 'dev'
 * tier and so drops out of a community build entirely. Mirrors the
 * `EDITION` mock pattern used by `ce-loads-pro-module.test.ts` /
 * `server-module-load.test.ts` — a dedicated file, not a case inside
 * `server.test.ts`, because `vi.mock('@editmamei/edition.ts', ...)` applies
 * to every test in the file it's declared in.
 */
import { vi, describe, it, expect } from 'vitest';

vi.mock('@editmamei/edition.ts', () => ({ EDITION: 'community' }));

import { EditmameiServer } from '@editmamei/core/server.ts';
import { resolveEditorRegistration } from '@editmamei/backends/detect-editors.ts';
import type { GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { useSessionLogSandbox } from '../fixtures/session-log-sandbox.ts';

useSessionLogSandbox();

const SAMPLE_GIMP_INSTALL: GimpInstall = {
  source: 'conventional',
  path: 'C:/Program Files/GIMP 3/bin/gimp-console-3.2.exe',
  launch: { command: 'C:/Program Files/GIMP 3/bin/gimp-console-3.2.exe', args: [] },
};

describe('community edition, GIMP detected, unpinned', () => {
  it('registers the full ps_* surface (gimp_* tiers at dev do not remove it)', () => {
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

    // Every gimp_* tool is 'dev' tier — a community build carries none of
    // them, by the SAME edition filter (isToolAllowedInEdition) that already
    // keeps every other dev-tier tool out of a shipped build.
    expect(names.some((n) => n.startsWith('gimp_'))).toBe(false);
  });
});
