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
  applyDesktopToggles,
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

describe('applyDesktopToggles (Claude Desktop manifest toggles)', () => {
  const base = (
    overrides: Partial<Settings> = {},
    usage = true,
    diagnostics = false
  ): Settings => ({
    telemetry: { usage, diagnostics, install_id: 'x'.repeat(32) },
    privacy: { send_previews_to_llm: true },
    automation: { allow_execute_script: true },
    ps_path: null,
    update_check: true,
    editor: 'auto',
    gimp_path: null,
    ...overrides,
  });
  const onDisk = () => loadSettings({ dir }).settings;
  const desktop = (usage: string, diagnostics: string, updateCheck: string) => ({
    EDITMAMEI_TELEMETRY_USAGE: usage,
    EDITMAMEI_TELEMETRY_DIAGNOSTICS: diagnostics,
    EDITMAMEI_UPDATE_CHECK: updateCheck,
  });

  it('returns the same object and writes nothing off Desktop', () => {
    const settings = base();
    expect(applyDesktopToggles(settings, {}, { dir })).toBe(settings);
    expect(existsSync(settingsPath({ dir }))).toBe(false);
  });

  it('treats an unsubstituted ${...} token or junk as no toggle', () => {
    const settings = base();
    expect(
      applyDesktopToggles(
        settings,
        {
          EDITMAMEI_TELEMETRY_USAGE: '${user_config.telemetry_usage}',
          EDITMAMEI_UPDATE_CHECK: 'maybe',
        },
        { dir }
      )
    ).toBe(settings);
    expect(existsSync(settingsPath({ dir }))).toBe(false);
  });

  it('does not mutate its input and keeps install_id and other settings', () => {
    const settings = base();
    const out = applyDesktopToggles(settings, desktop('0', '0', '1'), { dir });
    expect(settings.telemetry.usage).toBe(true);
    expect(settings.desktop_toggles).toBeUndefined();
    expect(out.telemetry.usage).toBe(false);
    expect(out.telemetry.install_id).toBe('x'.repeat(32));
    expect(out.privacy.send_previews_to_llm).toBe(true);
  });

  describe('first launch that sees the toggles', () => {
    it('keeps a CLI opt-out when the toggle is at its on default', () => {
      const out = applyDesktopToggles(base({}, false), desktop('true', 'false', 'true'), { dir });
      expect(out.telemetry.usage).toBe(false);
      expect(onDisk().telemetry.usage).toBe(false);
    });

    it('keeps an update-check opt-out when the toggle is at its on default', () => {
      const out = applyDesktopToggles(
        base({ update_check: false }),
        desktop('true', 'false', 'true'),
        { dir }
      );
      expect(out.update_check).toBe(false);
      expect(onDisk().update_check).toBe(false);
    });

    it('honors a toggle already switched off', () => {
      const out = applyDesktopToggles(base(), desktop('false', 'false', 'false'), { dir });
      expect(out.telemetry.usage).toBe(false);
      expect(out.update_check).toBe(false);
      expect(onDisk().telemetry.usage).toBe(false);
    });

    it('honors a diagnostics opt-in already switched on', () => {
      const out = applyDesktopToggles(base(), desktop('true', 'true', 'true'), { dir });
      expect(out.telemetry.diagnostics).toBe(true);
      expect(onDisk().telemetry.diagnostics).toBe(true);
    });

    it('does not send diagnostics from Desktop on a file opt-in while the toggle is off', () => {
      const out = applyDesktopToggles(base({}, true, true), desktop('true', 'false', 'true'), {
        dir,
      });
      expect(out.telemetry.diagnostics).toBe(false);
      expect(onDisk().telemetry.diagnostics).toBe(true);
    });

    it('records what it saw', () => {
      applyDesktopToggles(base(), desktop('true', 'false', 'true'), { dir });
      expect(onDisk().desktop_toggles).toEqual({
        usage: true,
        diagnostics: false,
        update_check: true,
      });
    });
  });

  describe('later launches', () => {
    const seen = { usage: true, diagnostics: false, update_check: true };

    it('keeps a CLI opt-out made after the toggle was seen', () => {
      saveSettings(base({ desktop_toggles: seen }, false), { dir });
      const out = applyDesktopToggles(onDisk(), desktop('true', 'false', 'true'), { dir });
      expect(out.telemetry.usage).toBe(false);
      expect(onDisk().telemetry.usage).toBe(false);
    });

    it('keeps a diagnostics withdrawal made in the CLI while the toggle stays on', () => {
      saveSettings(base({ desktop_toggles: { ...seen, diagnostics: true } }), { dir });
      const out = applyDesktopToggles(onDisk(), desktop('true', 'true', 'true'), { dir });
      expect(out.telemetry.diagnostics).toBe(false);
    });

    it('applies and saves a toggle moved off', () => {
      saveSettings(base({ desktop_toggles: seen }), { dir });
      const out = applyDesktopToggles(onDisk(), desktop('false', 'false', 'true'), { dir });
      expect(out.telemetry.usage).toBe(false);
      expect(onDisk().telemetry.usage).toBe(false);
      expect(onDisk().desktop_toggles?.usage).toBe(false);
    });

    it('applies and saves a toggle moved back on', () => {
      saveSettings(base({ desktop_toggles: { ...seen, usage: false } }, false), { dir });
      const out = applyDesktopToggles(onDisk(), desktop('true', 'false', 'true'), { dir });
      expect(out.telemetry.usage).toBe(true);
      expect(onDisk().telemetry.usage).toBe(true);
    });

    it('keeps sending off while the toggle is off, even after the file says on', () => {
      saveSettings(base({ desktop_toggles: { ...seen, usage: false } }, true), { dir });
      const out = applyDesktopToggles(onDisk(), desktop('false', 'false', 'true'), { dir });
      expect(out.telemetry.usage).toBe(false);
      expect(onDisk().telemetry.usage).toBe(true);
    });

    it('writes nothing when nothing changed', async () => {
      saveSettings(base({ desktop_toggles: seen }), { dir });
      const marked = (await readFile(settingsPath({ dir }), 'utf8')) + '\n';
      await writeFile(settingsPath({ dir }), marked);
      applyDesktopToggles(onDisk(), desktop('true', 'false', 'true'), { dir });
      expect(await readFile(settingsPath({ dir }), 'utf8')).toBe(marked);
    });
  });

  it('never overwrites a settings file it could not read', async () => {
    saveSettings(base({}, false), { dir });
    const malformed = '{ "telemetry": { "usage": false, } }';
    await writeFile(settingsPath({ dir }), malformed);
    const { settings, degraded } = loadSettings({ dir });
    expect(degraded).toBe(true);
    const out = applyDesktopToggles(settings, desktop('false', 'false', 'true'), {
      dir,
      persist: false,
    });
    expect(out.telemetry.usage).toBe(false);
    expect(await readFile(settingsPath({ dir }), 'utf8')).toBe(malformed);
  });

  it('does not flag a readable file as degraded', () => {
    saveSettings(base(), { dir });
    expect(loadSettings({ dir }).degraded).toBeUndefined();
  });

  it('keeps the seen value of a toggle missing from this launch', () => {
    saveSettings(
      base({ desktop_toggles: { usage: true, diagnostics: true, update_check: true } }, true, true),
      { dir }
    );
    const out = applyDesktopToggles(onDisk(), { EDITMAMEI_TELEMETRY_USAGE: 'false' }, { dir });
    expect(out.telemetry.usage).toBe(false);
    expect(out.telemetry.diagnostics).toBe(true);
    expect(out.update_check).toBe(true);
    expect(onDisk().desktop_toggles).toEqual({
      usage: false,
      diagnostics: true,
      update_check: true,
    });
  });

  it('tracks each toggle separately on later launches', () => {
    saveSettings(
      base({ desktop_toggles: { usage: true, diagnostics: false, update_check: true } }),
      { dir }
    );
    const moved = applyDesktopToggles(onDisk(), desktop('true', 'true', 'false'), { dir });
    expect(moved.telemetry.usage).toBe(true);
    expect(moved.telemetry.diagnostics).toBe(true);
    expect(moved.update_check).toBe(false);
    expect(onDisk().telemetry.diagnostics).toBe(true);
    expect(onDisk().update_check).toBe(false);
    const movedBack = applyDesktopToggles(onDisk(), desktop('true', 'false', 'true'), { dir });
    expect(movedBack.telemetry.diagnostics).toBe(false);
    expect(movedBack.update_check).toBe(true);
    expect(onDisk().telemetry.diagnostics).toBe(false);
    expect(onDisk().update_check).toBe(true);
  });

  it('still honors the result for this launch when the save fails', async () => {
    const blocked = join(dir, 'not-a-dir');
    await writeFile(blocked, '');
    const out = applyDesktopToggles(base(), desktop('false', 'false', 'true'), { dir: blocked });
    expect(out.telemetry.usage).toBe(false);
  });

  it('survives a settings round trip and ignores a malformed record', async () => {
    saveSettings(base({ desktop_toggles: { usage: true } }), { dir });
    expect(onDisk().desktop_toggles).toEqual({ usage: true });
    const raw = JSON.parse(await readFile(settingsPath({ dir }), 'utf8'));
    raw.desktop_toggles = { usage: 'yes', diagnostics: 1 };
    await writeFile(settingsPath({ dir }), JSON.stringify(raw));
    expect(onDisk().desktop_toggles).toBeUndefined();
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
