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
import { toolsInTier } from '@editmamei/core/tool-tiers.ts';

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

// Derived from the live tier table rather than assumed — this must keep
// passing whichever way today's gimp_* tiers happen to be set (e.g. a
// release-candidate branch that has flipped them from 'dev' to 'community'),
// not just the "nothing ships yet" state this repo is usually in.
const someGimpToolShipsInCommunity = toolsInTier('community').some((name) =>
  name.startsWith('gimp_')
);

describe("resolveBootEditors on a community-edition build, pinned to 'gimp'", () => {
  it('registers ps_* or gimp_* according to whatever the live tier table actually ships at community tier', async () => {
    // GIMP genuinely found — proves the outcome is driven by the edition
    // filter (via the tier table), not by detection coming up empty.
    const detectEditorsFn = vi.fn(async () => ({ gimp: SAMPLE_INSTALL, timedOut: false }));
    const result = await resolveBootEditors({
      settings: makeSettings({ editor: 'gimp' }),
      env: {},
      detectEditorsFn,
    });
    if (someGimpToolShipsInCommunity) {
      // At least one gimp_* tool survives the community filter — the 'gimp'
      // pin registers the GIMP surface for real, using what boot detected.
      expect(result).toEqual({
        registerPhotoshop: false,
        registerGimp: true,
        gimpInstall: SAMPLE_INSTALL,
        gimpDetectionTimedOut: false,
      });
    } else {
      // No gimp_* tool ships at community tier — pinning 'gimp' would leave
      // almost no tools registered, so it falls back to ps_* instead.
      expect(result).toEqual({
        registerPhotoshop: true,
        registerGimp: false,
        gimpInstall: null,
        gimpDetectionTimedOut: false,
      });
    }
  });
});
