import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installCursor, uninstallCursor, statusCursor } from '@editmamei/cli/clients/cursor.ts';

/**
 * Cursor adapter behaves like the Claude Desktop adapter for the JSON
 * read-merge-backup-write parts (they share json-config.ts), but adds a
 * detection step: skip unless `~/.cursor/` exists or `cursor` is on PATH.
 *
 * These tests pre-create the .cursor/ parent so detection passes, then
 * exercise the same matrix of states.
 */

const npxEntry = { command: 'npx', args: ['-y', 'editmamei'] };

describe('installCursor', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editmamei-cursor-test-'));
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    configPath = join(dir, '.cursor', 'mcp.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a new config when none exists', async () => {
    const r = await installCursor(npxEntry, { configPath });
    expect(r.status).toBe('created');
    expect(r.client).toBe('Cursor');

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.mcpServers.editmamei).toEqual(npxEntry);
  });

  it('writes the config 0o600 (owner-only) so a license-key env never leaks world-readable', async () => {
    await installCursor(npxEntry, { configPath });
    // mode is cosmetic on Windows (NTFS ACLs govern there), so only assert on POSIX.
    if (process.platform === 'win32') return;
    const mode = statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('is idempotent on identical re-run', async () => {
    await installCursor(npxEntry, { configPath });
    const firstWrite = readFileSync(configPath, 'utf8');

    const r = await installCursor(npxEntry, { configPath });
    expect(r.status).toBe('unchanged');
    expect(readFileSync(configPath, 'utf8')).toBe(firstWrite);
  });

  it('updates an existing different entry', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { editmamei: { command: 'node', args: ['/old/path'] } },
      })
    );

    const r = await installCursor(npxEntry, { configPath });
    expect(r.status).toBe('updated');

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.mcpServers.editmamei).toEqual(npxEntry);
  });

  it('backs up existing config on first write', async () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));

    const r = await installCursor(npxEntry, { configPath });
    expect(r.backup).toBeDefined();
    expect(r.backup?.preserved).toBe(false);
    expect(existsSync(`${configPath}.bak`)).toBe(true);
  });

  it('preserves a pre-existing .bak across re-runs', async () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    writeFileSync(`${configPath}.bak`, 'pristine');

    const r = await installCursor(npxEntry, { configPath });
    expect(r.backup?.preserved).toBe(true);
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe('pristine');
  });

  it('skips when Cursor is not detected (no .cursor dir, no binary)', async () => {
    // Point at a config path whose parent dir does not exist.
    const undetectablePath = join(dir, 'totally-not-cursor', 'mcp.json');
    const r = await installCursor(npxEntry, { configPath: undetectablePath });
    expect(r.status).toBe('skipped');
    expect(r.detail).toMatch(/Cursor not detected/);
  });

  it('fails cleanly on malformed JSON without overwriting', async () => {
    writeFileSync(configPath, '{ not json');
    const r = await installCursor(npxEntry, { configPath });
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/not valid JSON/);
    expect(readFileSync(configPath, 'utf8')).toBe('{ not json');
    expect(existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('preserves other mcpServers entries', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { 'other-server': { command: 'x' } },
      })
    );

    await installCursor(npxEntry, { configPath });

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.mcpServers['other-server']).toEqual({ command: 'x' });
    expect(config.mcpServers.editmamei).toEqual(npxEntry);
  });
});

describe('uninstallCursor', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editmamei-cursor-uninstall-test-'));
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    configPath = join(dir, '.cursor', 'mcp.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports absent when no config exists', async () => {
    const r = await uninstallCursor({ configPath });
    expect(r.status).toBe('absent');
  });

  it('reports absent when editmamei is not in the config', async () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const r = await uninstallCursor({ configPath });
    expect(r.status).toBe('absent');
  });

  it('removes editmamei and preserves siblings', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { editmamei: npxEntry, other: { command: 'x' } },
      })
    );

    const r = await uninstallCursor({ configPath });
    expect(r.status).toBe('removed');

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.mcpServers.editmamei).toBeUndefined();
    expect(config.mcpServers.other).toBeDefined();
  });

  it('skips when Cursor not detected', async () => {
    const undetectable = join(dir, 'no-cursor-here', 'mcp.json');
    const r = await uninstallCursor({ configPath: undetectable });
    expect(r.status).toBe('skipped');
  });
});

describe('statusCursor', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editmamei-cursor-status-test-'));
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    configPath = join(dir, '.cursor', 'mcp.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports not-detected when no .cursor and no binary', async () => {
    const undetectable = join(dir, 'no-cursor-here', 'mcp.json');
    const r = await statusCursor({ configPath: undetectable });
    expect(r.status).toBe('not-detected');
  });

  it('reports not-registered when config missing', async () => {
    const r = await statusCursor({ configPath });
    expect(r.status).toBe('not-registered');
  });

  it('reports registered with command details', async () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { editmamei: npxEntry } }));
    const r = await statusCursor({ configPath });
    expect(r.status).toBe('registered');
    expect(r.command).toBe('npx -y editmamei');
  });

  it('reports error on malformed JSON', async () => {
    writeFileSync(configPath, '{ broken');
    const r = await statusCursor({ configPath });
    expect(r.status).toBe('error');
    expect(r.detail).toMatch(/not valid JSON/);
  });
});
