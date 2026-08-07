import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '@editmamei/cli/config.ts';
import { loadSettings } from '@editmamei/core/settings.ts';

let dir: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'editmamei-config-'));
  out = [];
  err = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const io = () => ({ dir, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });

describe('config list', () => {
  it('prints the full settings JSON', () => {
    runConfig(['list'], io());
    const printed = JSON.parse(out.join('')) as { telemetry: { usage: boolean } };
    expect(printed.telemetry.usage).toBe(true);
  });

  it('defaults to list when no action is given', () => {
    runConfig([], io());
    const printed = JSON.parse(out.join('')) as { privacy: { send_previews_to_llm: boolean } };
    expect(printed.privacy.send_previews_to_llm).toBe(true);
  });
});

describe('config unknown action', () => {
  it('errors and prints usage', () => {
    expect(() => runConfig(['frobnicate'], io())).toThrow();
    expect(err.join('')).toContain('Unknown config action');
  });
});

describe('config get', () => {
  it('returns a single value', () => {
    runConfig(['get', 'telemetry.usage'], io());
    expect(out.join('').trim()).toBe('true');
  });
  it('errors on an unknown key', () => {
    expect(() => runConfig(['get', 'telemetry.nope'], io())).toThrow();
    expect(err.join('')).toContain('Unknown or missing config key');
  });
});

describe('config set', () => {
  it('flips a boolean and persists it', () => {
    runConfig(['set', 'telemetry.usage', 'false'], io());
    expect(loadSettings({ dir }).settings.telemetry.usage).toBe(false);
  });

  it('opts in to diagnostics', () => {
    runConfig(['set', 'telemetry.diagnostics', 'on'], io());
    expect(loadSettings({ dir }).settings.telemetry.diagnostics).toBe(true);
  });

  it('opts out of the boot update check and reads it back', () => {
    expect(loadSettings({ dir }).settings.update_check).toBe(true); // default
    runConfig(['set', 'update_check', 'false'], io());
    expect(loadSettings({ dir }).settings.update_check).toBe(false);
    out.length = 0;
    runConfig(['get', 'update_check'], io());
    expect(out.join('').trim()).toBe('false');
  });

  it('sets ps_path and clears it with "null" or empty string', () => {
    runConfig(['set', 'ps_path', '/Applications/PS/Photoshop.app'], io());
    expect(loadSettings({ dir }).settings.ps_path).toBe('/Applications/PS/Photoshop.app');
    runConfig(['set', 'ps_path', 'null'], io());
    expect(loadSettings({ dir }).settings.ps_path).toBeNull();
    runConfig(['set', 'ps_path', '/tmp/x'], io());
    runConfig(['set', 'ps_path', ''], io());
    expect(loadSettings({ dir }).settings.ps_path).toBeNull();
  });

  it('rejects a non-boolean value for a boolean key', () => {
    expect(() => runConfig(['set', 'telemetry.usage', 'maybe'], io())).toThrow();
    expect(err.join('')).toContain('Invalid value');
  });

  it('refuses to set the read-only install_id', () => {
    expect(() => runConfig(['set', 'telemetry.install_id', 'x'], io())).toThrow();
    expect(err.join('')).toContain('read-only');
  });

  it('errors when no value is supplied', () => {
    expect(() => runConfig(['set', 'telemetry.usage'], io())).toThrow();
  });
});
