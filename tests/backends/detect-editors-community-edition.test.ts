import { vi, describe, it, expect } from 'vitest';

// Isolated in its own file (mirrors tests/integration/server-community-edition-gimp.test.ts)
// because mocking EDITION module-wide would change the pin='gimp' behavior
// every other test in detect-editors.test.ts relies on. This file exercises
// resolveBootEditors' real wiring to TOOL_TIERS + EDITION (not an injected
// gimpToolsAllowed boolean) under an actual community-edition build.
vi.mock('@editmamei/edition.ts', () => ({ EDITION: 'community' }));

import { resolveBootEditors } from '@editmamei/backends/detect-editors.ts';
import type { GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import type { Settings } from '@editmamei/core/settings.ts';

const SAMPLE_INSTALL: GimpInstall = {
  source: 'conventional',
  path: 'C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.exe',
  launch: { command: 'C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.exe', args: [] },
};

function makeSettings(over: Partial<Settings> = {}): Settings {
  return {
    telemetry: { usage: true, diagnostics: false, install_id: 'a'.repeat(32) },
    privacy: { send_previews_to_llm: true },
    ps_path: null,
    update_check: true,
    editor: 'auto',
    gimp_path: null,
    ...over,
  };
}

describe("resolveBootEditors on a community-edition build, pinned to 'gimp'", () => {
  it('falls back to registering ps_* only — every gimp_* tool ships at tier "dev", so none of them survive the community edition filter regardless of what boot detected', async () => {
    // GIMP genuinely found — proves the fallback is driven by the edition
    // filter, not by detection coming up empty.
    const detectEditorsFn = vi.fn(async () => ({ gimp: SAMPLE_INSTALL, timedOut: false }));
    const result = await resolveBootEditors({
      settings: makeSettings({ editor: 'gimp' }),
      env: {},
      detectEditorsFn,
    });
    expect(result).toEqual({
      registerPhotoshop: true,
      registerGimp: false,
      gimpInstall: null,
      gimpDetectionTimedOut: false,
    });
  });
});
