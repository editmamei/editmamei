import { vi, describe, it, expect, afterEach } from 'vitest';

// Isolated in its own file (mirrors tests/integration/server-community-edition-gimp.test.ts)
// because mocking EDITION module-wide would change the pin='gimp' behavior
// every other test in detect-editors.test.ts relies on. This file exercises
// resolveBootEditors' real wiring to TOOL_TIERS + EDITION (not an injected
// gimpToolsAllowed boolean) under an actual community-edition build.
vi.mock('@editmamei/edition.ts', () => ({ EDITION: 'community' }));

import { resolveBootEditors } from '@editmamei/backends/detect-editors.ts';
import { TOOL_TIERS, type Tier } from '@editmamei/core/tool-tiers.ts';
import type { GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import type { Settings } from '@editmamei/core/settings.ts';

// Both branches are asserted on every run, whatever today's tier table says: each test sets the
// gimp_* entries of the REAL table, and the real isToolAllowedInEdition gate reads them with the
// edition detect-editors actually passes. A mocked gate would pass even if detect-editors asked
// about the wrong edition.
const GIMP_TOOLS = Object.keys(TOOL_TIERS).filter((name) => name.startsWith('gimp_'));
const saved = Object.fromEntries(GIMP_TOOLS.map((name) => [name, TOOL_TIERS[name]!]));

function setGimpTiers(tier: Tier): void {
  for (const name of GIMP_TOOLS) TOOL_TIERS[name] = tier;
}

afterEach(() => {
  Object.assign(TOOL_TIERS, saved);
});

const SAMPLE_INSTALL: GimpInstall = {
  source: 'conventional',
  path: 'C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.exe',
  launch: { command: 'C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.exe', args: [] },
};

function makeSettings(over: Partial<Settings> = {}): Settings {
  return {
    telemetry: { usage: true, diagnostics: false, install_id: 'a'.repeat(32) },
    privacy: { send_previews_to_llm: true },
    automation: { allow_execute_script: true },
    ps_path: null,
    update_check: true,
    editor: 'auto',
    gimp_path: null,
    ...over,
  };
}

describe("resolveBootEditors on a community-edition build, pinned to 'gimp'", () => {
  it('has gimp_* tools in the tier table to vary (the tests below are not vacuous)', () => {
    expect(GIMP_TOOLS.length).toBeGreaterThanOrEqual(16);
  });

  it('falls back to registering ps_* only when no gimp_* tool ships at community tier', async () => {
    setGimpTiers('dev');
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

  it('skips GIMP detection entirely when no gimp_* tool ships at community tier', async () => {
    setGimpTiers('dev');
    const detectEditorsFn = vi.fn(async () => ({ gimp: SAMPLE_INSTALL, timedOut: false }));
    await resolveBootEditors({ settings: makeSettings(), env: {}, detectEditorsFn });
    expect(detectEditorsFn).not.toHaveBeenCalled();
  });

  it('registers gimp_* (using what boot detected) when the gimp_* tools ship at community tier', async () => {
    setGimpTiers('community');
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

  it('treats Pro-tier gimp_* tools as absent from a community build', async () => {
    setGimpTiers('pro');
    const detectEditorsFn = vi.fn(async () => ({ gimp: SAMPLE_INSTALL, timedOut: false }));
    const result = await resolveBootEditors({
      settings: makeSettings({ editor: 'gimp' }),
      env: {},
      detectEditorsFn,
    });
    expect(result.registerGimp).toBe(false);
    expect(result.registerPhotoshop).toBe(true);
  });
});
