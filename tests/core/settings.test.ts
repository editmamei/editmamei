import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSettings,
  saveSettings,
  settingsPath,
  mintInstallId,
  applyTelemetryEnvOverrides,
  applyUpdateCheckEnvOverride,
  applyEditorEnvOverride,
  type Settings,
} from '@editmamei/core/settings.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'editmamei-settings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('mintInstallId', () => {
  it('produces a 32-char hex id that matches the server id pattern', () => {
    const id = mintInstallId();
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/); // server INSTALL_ID pattern
  });
  it('is unique per call', () => {
    expect(mintInstallId()).not.toBe(mintInstallId());
  });
});

describe('loadSettings — first run', () => {
  it('creates the file with defaults and a minted install_id, flagged created', () => {
    const { settings, created } = loadSettings({ dir });
    expect(created).toBe(true);
    expect(existsSync(settingsPath({ dir }))).toBe(true);
    expect(settings.telemetry.usage).toBe(true); // opt-out default
    expect(settings.telemetry.diagnostics).toBe(false); // opt-in default
    expect(settings.privacy.send_previews_to_llm).toBe(true);
    expect(settings.ps_path).toBeNull();
    expect(settings.update_check).toBe(true); // opt-out default
    expect(settings.editor).toBe('auto'); // the settled default, matching detect-editors' matrix
    expect(settings.gimp_path).toBeNull();
    expect(settings.telemetry.install_id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('keeps a stable install_id across loads and is not created on the second load', () => {
    const first = loadSettings({ dir });
    const second = loadSettings({ dir });
    expect(second.created).toBe(false);
    expect(second.settings.telemetry.install_id).toBe(first.settings.telemetry.install_id);
  });
});

describe('loadSettings — existing / malformed', () => {
  it('merges missing keys onto defaults while preserving user values + id', async () => {
    await writeFile(
      settingsPath({ dir }),
      JSON.stringify({ telemetry: { usage: false, install_id: 'abc123def456' } }),
      'utf8'
    );
    const { settings } = loadSettings({ dir });
    expect(settings.telemetry.usage).toBe(false); // preserved
    expect(settings.telemetry.diagnostics).toBe(false); // defaulted
    expect(settings.telemetry.install_id).toBe('abc123def456'); // preserved
    expect(settings.privacy.send_previews_to_llm).toBe(true); // defaulted
    expect(settings.automation.allow_execute_script).toBe(true); // defaulted
    expect(settings.update_check).toBe(true); // defaulted for an older file lacking the key
    expect(settings.editor).toBe('auto'); // defaulted for an older file lacking the key
    expect(settings.gimp_path).toBeNull();
  });

  it('preserves an explicit editor pin + gimp_path from disk', async () => {
    // Absolute on whichever OS runs the suite (the load-time check uses host path rules).
    const gimpPath = join(dir, 'tools', 'gimp-console-3.2.exe');
    await writeFile(
      settingsPath({ dir }),
      JSON.stringify({
        editor: 'gimp',
        gimp_path: gimpPath,
        telemetry: { install_id: 'keep0000000000' },
      }),
      'utf8'
    );
    const { settings } = loadSettings({ dir });
    expect(settings.editor).toBe('gimp');
    expect(settings.gimp_path).toBe(gimpPath);
  });

  it.each([
    ['a relative path', 'tools/gimp-console-3.2.exe'],
    ['a UNC share', '\\\\server\\share\\gimp-console-3.2.exe'],
  ])(
    'drops a hand-edited gimp_path that is %s back to auto-detect instead of spawning it',
    async (_label, gimpPath) => {
      await writeFile(
        settingsPath({ dir }),
        JSON.stringify({ gimp_path: gimpPath, telemetry: { install_id: 'keep0000000000' } }),
        'utf8'
      );
      const { settings } = loadSettings({ dir });
      expect(settings.gimp_path).toBeNull();
    }
  );

  it('falls back editor to the default on an unrecognized value rather than throwing', async () => {
    await writeFile(
      settingsPath({ dir }),
      JSON.stringify({ editor: 'nonsense', telemetry: { install_id: 'keep0000000000' } }),
      'utf8'
    );
    const { settings } = loadSettings({ dir });
    expect(settings.editor).toBe('auto');
  });

  it('preserves an explicit update_check=false from disk', async () => {
    await writeFile(
      settingsPath({ dir }),
      JSON.stringify({ update_check: false, telemetry: { install_id: 'keep0000000000' } }),
      'utf8'
    );
    const { settings } = loadSettings({ dir });
    expect(settings.update_check).toBe(false); // preserved, not re-defaulted
  });

  it('mints + persists an install_id for a hand-created file that lacks one', async () => {
    await writeFile(settingsPath({ dir }), JSON.stringify({ telemetry: { usage: true } }), 'utf8');
    const { settings } = loadSettings({ dir });
    expect(settings.telemetry.install_id).toMatch(/^[a-f0-9]{32}$/);
    // Persisted: a re-read sees the same id.
    expect(loadSettings({ dir }).settings.telemetry.install_id).toBe(settings.telemetry.install_id);
  });

  it('degrades to defaults (no throw) on malformed JSON', async () => {
    await writeFile(settingsPath({ dir }), '{ not valid json', 'utf8');
    const { settings, created } = loadSettings({ dir });
    expect(created).toBe(false);
    expect(settings.telemetry.usage).toBe(true);
    expect(settings.telemetry.install_id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('treats an empty file as defaults (mints an id)', async () => {
    await writeFile(settingsPath({ dir }), '   \n', 'utf8');
    const { settings } = loadSettings({ dir });
    expect(settings.telemetry.usage).toBe(true);
    expect(settings.telemetry.diagnostics).toBe(false);
    expect(settings.telemetry.install_id).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe('applyTelemetryEnvOverrides (Claude Desktop manifest toggles)', () => {
  const base: Settings = {
    telemetry: { usage: true, diagnostics: false, install_id: 'x'.repeat(32) },
    privacy: { send_previews_to_llm: true },
    automation: { allow_execute_script: true },
    ps_path: null,
    update_check: true,
    editor: 'auto',
    gimp_path: null,
  };

  it('returns the same object (no override) when no telemetry env vars are set', () => {
    expect(applyTelemetryEnvOverrides(base, {})).toBe(base);
  });

  it('disables usage on EDITMAMEI_TELEMETRY_USAGE=false, non-mutating', () => {
    const out = applyTelemetryEnvOverrides(base, { EDITMAMEI_TELEMETRY_USAGE: 'false' });
    expect(out.telemetry.usage).toBe(false);
    expect(out.telemetry.diagnostics).toBe(false);
    expect(base.telemetry.usage).toBe(true); // original untouched
  });

  it('enables diagnostics on EDITMAMEI_TELEMETRY_DIAGNOSTICS=true', () => {
    const out = applyTelemetryEnvOverrides(base, { EDITMAMEI_TELEMETRY_DIAGNOSTICS: 'true' });
    expect(out.telemetry.diagnostics).toBe(true);
    expect(out.telemetry.usage).toBe(true);
  });

  it('treats an unsubstituted ${...} token / junk as no override (file value stands)', () => {
    const out = applyTelemetryEnvOverrides(base, {
      EDITMAMEI_TELEMETRY_USAGE: '${user_config.telemetry_usage}',
    });
    expect(out).toBe(base);
  });

  it('accepts 1/0 and preserves install_id + other settings', () => {
    const out = applyTelemetryEnvOverrides(base, { EDITMAMEI_TELEMETRY_USAGE: '0' });
    expect(out.telemetry.usage).toBe(false);
    expect(out.telemetry.install_id).toBe('x'.repeat(32));
    expect(out.privacy.send_previews_to_llm).toBe(true);
  });
});

describe('applyUpdateCheckEnvOverride (Claude Desktop manifest toggle)', () => {
  const base: Settings = {
    telemetry: { usage: true, diagnostics: false, install_id: 'y'.repeat(32) },
    privacy: { send_previews_to_llm: true },
    automation: { allow_execute_script: true },
    ps_path: null,
    update_check: true,
    editor: 'auto',
    gimp_path: null,
  };

  it('returns the same object when EDITMAMEI_UPDATE_CHECK is unset', () => {
    expect(applyUpdateCheckEnvOverride(base, {})).toBe(base);
  });

  it('disables the check on EDITMAMEI_UPDATE_CHECK=false, non-mutating', () => {
    const out = applyUpdateCheckEnvOverride(base, { EDITMAMEI_UPDATE_CHECK: 'false' });
    expect(out.update_check).toBe(false);
    expect(base.update_check).toBe(true); // original untouched
  });

  it('treats an unsubstituted ${...} token as no override (file value stands)', () => {
    expect(
      applyUpdateCheckEnvOverride(base, { EDITMAMEI_UPDATE_CHECK: '${user_config.update_check}' })
    ).toBe(base);
  });
});

describe('applyEditorEnvOverride (Claude Desktop manifest toggle)', () => {
  const base: Settings = {
    telemetry: { usage: true, diagnostics: false, install_id: 'z'.repeat(32) },
    privacy: { send_previews_to_llm: true },
    automation: { allow_execute_script: true },
    ps_path: null,
    update_check: true,
    editor: 'auto',
    gimp_path: null,
  };

  it('returns the same object when EDITMAMEI_EDITOR is unset', () => {
    expect(applyEditorEnvOverride(base, {})).toBe(base);
  });

  it('overrides the pin on a recognized value, non-mutating', () => {
    const out = applyEditorEnvOverride(base, { EDITMAMEI_EDITOR: 'gimp' });
    expect(out.editor).toBe('gimp');
    expect(base.editor).toBe('auto'); // original untouched
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(applyEditorEnvOverride(base, { EDITMAMEI_EDITOR: ' Photoshop ' }).editor).toBe(
      'photoshop'
    );
  });

  it('treats an unrecognized value as no override (file value stands)', () => {
    expect(applyEditorEnvOverride(base, { EDITMAMEI_EDITOR: 'nonsense' })).toBe(base);
  });
});

describe('automation.allow_execute_script', () => {
  it('defaults to true on first run', () => {
    expect(loadSettings({ dir }).settings.automation.allow_execute_script).toBe(true);
  });

  it('survives a load/save round trip when false', () => {
    const { settings } = loadSettings({ dir });
    settings.automation.allow_execute_script = false;
    saveSettings(settings, { dir });
    expect(loadSettings({ dir }).settings.automation.allow_execute_script).toBe(false);
  });

  it('coerces a non-boolean to the default', async () => {
    await writeFile(
      settingsPath({ dir }),
      JSON.stringify({ automation: { allow_execute_script: 'no' } }),
      'utf8'
    );
    expect(loadSettings({ dir }).settings.automation.allow_execute_script).toBe(true);
  });
});

describe('saveSettings', () => {
  it('round-trips and leaves no tmp file behind', async () => {
    const s: Settings = {
      telemetry: { usage: false, diagnostics: true, install_id: mintInstallId() },
      privacy: { send_previews_to_llm: false },
      automation: { allow_execute_script: true },
      ps_path: '/Applications/Adobe Photoshop 2026/Photoshop.app',
      update_check: false,
      editor: 'auto',
      gimp_path: null,
    };
    saveSettings(s, { dir });
    const raw = JSON.parse(await readFile(settingsPath({ dir }), 'utf8')) as Settings;
    expect(raw).toEqual(s);
    expect(existsSync(join(dir, `.settings.${process.pid}.tmp`))).toBe(false);
  });
});
