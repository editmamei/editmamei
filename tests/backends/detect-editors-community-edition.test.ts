import { vi, describe, it, expect } from 'vitest';

// Isolated in its own file (mirrors tests/integration/server-community-edition-gimp.test.ts)
// because mocking EDITION module-wide would change the pin='gimp' behavior
// every other test in detect-editors.test.ts relies on. This file exercises
// resolveBootEditors' real wiring to TOOL_TIERS + EDITION (not an injected
// gimpToolsAllowed boolean) under an actual community-edition build.
vi.mock('@editmamei/edition.ts', () => ({ EDITION: 'community' }));

// The tier SOURCE itself is mocked too, and made controllable per test (via
// `fx.gimpCommunityTier`, flipped before each call below) — this is what
// lets both branches be asserted deterministically on EVERY run, rather
// than only whichever branch today's real tier table happens to produce
// (before this, the test read the live `toolsInTier('community')` and
// skipped whichever branch wasn't true right now — the RC branch that
// flips gimp_* tiers to 'community' would only ever exercise ONE of the
// two shapes, never both, on any given run).
const fx = vi.hoisted(() => ({ gimpCommunityTier: false }));
vi.mock('@editmamei/core/tool-tiers.ts', () => ({
  // Only the presence of a `gimp_*` key matters to
  // `anyGimpToolAllowedInEdition` (detect-editors.ts) — it filters
  // `Object.keys(TOOL_TIERS)` for a `gimp_` prefix and asks
  // `isToolAllowedInEdition` about each one it finds.
  TOOL_TIERS: { gimp_ping: 'dev' },
  isToolAllowedInEdition: (name: string) =>
    name === 'gimp_ping' ? fx.gimpCommunityTier : true,
}));

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
  it('falls back to registering ps_* only when no gimp_* tool ships at community tier', async () => {
    fx.gimpCommunityTier = false;
    // GIMP genuinely found — proves the fallback is driven by the edition
    // filter (via the tier table), not by detection coming up empty.
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

  it('registers gimp_* (using what boot detected) when at least one gimp_* tool ships at community tier', async () => {
    fx.gimpCommunityTier = true;
    const detectEditorsFn = vi.fn(async () => ({ gimp: SAMPLE_INSTALL, timedOut: false }));
    const result = await resolveBootEditors({
      settings: makeSettings({ editor: 'gimp' }),
      env: {},
      detectEditorsFn,
    });
    expect(result).toEqual({
      registerPhotoshop: false,
      registerGimp: true,
      gimpInstall: SAMPLE_INSTALL,
      gimpDetectionTimedOut: false,
    });
  });
});
