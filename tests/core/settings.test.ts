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
    expect(settings.update_check).toBe(true); // defaulted for an older file lacking the key
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
    ps_path: null,
    update_check: true,
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
    ps_path: null,
    update_check: true,
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

describe('saveSettings', () => {
  it('round-trips and leaves no tmp file behind', async () => {
    const s: Settings = {
      telemetry: { usage: false, diagnostics: true, install_id: mintInstallId() },
      privacy: { send_previews_to_llm: false },
      ps_path: '/Applications/Adobe Photoshop 2026/Photoshop.app',
      update_check: false,
    };
    saveSettings(s, { dir });
    const raw = JSON.parse(await readFile(settingsPath({ dir }), 'utf8')) as Settings;
    expect(raw).toEqual(s);
    expect(existsSync(join(dir, `.settings.${process.pid}.tmp`))).toBe(false);
  });
});
