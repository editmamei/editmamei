import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installCodex, uninstallCodex, statusCodex } from '@editmamei/cli/clients/codex.ts';
import { getCodexConfigPath } from '@editmamei/cli/paths.ts';
import { parseDoc, upsertEntry, renderDoc } from '@editmamei/cli/clients/toml-config.ts';

/**
 * The ChatGPT desktop app and Codex share one config.toml that people also
 * edit by hand. The adapter must change only Editmamei's table and leave every
 * other byte alone, so most tests compare whole files.
 */

const npxEntry = { command: 'npx', args: ['-y', 'editmamei'] };

const FRESH_BLOCK = [
  '[mcp_servers.editmamei]',
  'command = "npx"',
  'args = ["-y", "editmamei"]',
  'startup_timeout_sec = 60',
  'tool_timeout_sec = 600',
  '',
].join('\n');

describe('getCodexConfigPath', () => {
  it('uses CODEX_HOME when set', () => {
    expect(getCodexConfigPath({ CODEX_HOME: join('x', 'codex-home') })).toBe(
      join('x', 'codex-home', 'config.toml')
    );
  });

  it('falls back to ~/.codex when CODEX_HOME is unset or blank', () => {
    expect(getCodexConfigPath({})).toMatch(/[\\/]\.codex[\\/]config\.toml$/);
    expect(getCodexConfigPath({ CODEX_HOME: '  ' })).toMatch(/[\\/]\.codex[\\/]config\.toml$/);
  });
});

describe('installCodex', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editmamei-codex-test-'));
    mkdirSync(join(dir, '.codex'), { recursive: true });
    configPath = join(dir, '.codex', 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates config.toml with the entry and both timeouts', async () => {
    const r = await installCodex(npxEntry, { configPath });
    expect(r.status).toBe('created');
    expect(r.client).toBe('ChatGPT and Codex');
    expect(readFileSync(configPath, 'utf8')).toBe(FRESH_BLOCK);
    expect(r.backup).toBeUndefined();
  });

  it('appends to an existing file without touching anything else', async () => {
    const existing = [
      '# my settings',
      'model = "gpt-6"',
      '',
      '[mcp_servers.other]',
      'command = "other-server"   # keep this comment',
      '',
      '[windows]',
      'sandbox = "elevated"',
      '',
    ].join('\n');
    writeFileSync(configPath, existing);

    const r = await installCodex(npxEntry, { configPath });
    expect(r.status).toBe('created');
    expect(readFileSync(configPath, 'utf8')).toBe(existing + '\n' + FRESH_BLOCK);
    expect(r.backup).toEqual({ path: `${configPath}.bak`, preserved: false });
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(existing);
  });

  it('is idempotent on a re-run', async () => {
    await installCodex(npxEntry, { configPath });
    const first = readFileSync(configPath, 'utf8');
    const r = await installCodex(npxEntry, { configPath });
    expect(r.status).toBe('unchanged');
    expect(readFileSync(configPath, 'utf8')).toBe(first);
  });

  it('rewrites command and args but keeps timeouts, other keys and tool tables the user set', async () => {
    const existing = [
      '[mcp_servers.editmamei]',
      'command = "node"',
      'args = [',
      '  "/old/path/index.js",',
      ']',
      'tool_timeout_sec = 900',
      'default_tools_approval_mode = "approve"',
      '',
      '[mcp_servers.editmamei.tools.ps_ping]',
      'approval_mode = "approve"',
      '',
    ].join('\n');
    writeFileSync(configPath, existing);

    const r = await installCodex(npxEntry, { configPath });
    expect(r.status).toBe('updated');
    expect(readFileSync(configPath, 'utf8')).toBe(
      [
        '[mcp_servers.editmamei]',
        'startup_timeout_sec = 60',
        'command = "npx"',
        'args = ["-y", "editmamei"]',
        'tool_timeout_sec = 900',
        'default_tools_approval_mode = "approve"',
        '',
        '[mcp_servers.editmamei.tools.ps_ping]',
        'approval_mode = "approve"',
        '',
      ].join('\n')
    );
  });

  it('reads single-quoted strings as equal, so nothing is rewritten', async () => {
    const existing = [
      "[mcp_servers.'editmamei']",
      "command = 'npx'",
      "args = ['-y', 'editmamei']",
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 600',
      '',
    ].join('\n');
    writeFileSync(configPath, existing);
    const r = await installCodex(npxEntry, { configPath });
    expect(r.status).toBe('unchanged');
    expect(readFileSync(configPath, 'utf8')).toBe(existing);
  });

  it('keeps CRLF line endings', async () => {
    const existing = 'model = "gpt-6"\r\n';
    writeFileSync(configPath, existing);
    await installCodex(npxEntry, { configPath });
    const out = readFileSync(configPath, 'utf8');
    expect(out).toBe(existing + '\r\n' + FRESH_BLOCK.replace(/\n/g, '\r\n'));
  });

  it('writes PHOTOSHOP_PATH as an escaped string, merged into an existing env table', async () => {
    const existing = [
      '[mcp_servers.editmamei]',
      'command = "npx"',
      'args = ["-y", "editmamei"]',
      'startup_timeout_sec = 60',
      'tool_timeout_sec = 600',
      'env = { LOG_LEVEL = "0" }',
      '',
    ].join('\n');
    writeFileSync(configPath, existing);
    const entry = {
      ...npxEntry,
      env: { PHOTOSHOP_PATH: 'D:\\Adobe\\Photoshop "2027"\\Photoshop.exe' },
    };
    const r = await installCodex(entry, { configPath });
    expect(r.status).toBe('updated');
    expect(readFileSync(configPath, 'utf8')).toContain(
      'env = { LOG_LEVEL = "0", PHOTOSHOP_PATH = "D:\\\\Adobe\\\\Photoshop \\"2027\\"\\\\Photoshop.exe" }'
    );
    // And the value round-trips: a second run sees it as already set.
    expect((await installCodex(entry, { configPath })).status).toBe('unchanged');
  });

  it('sets PHOTOSHOP_PATH inside an [mcp_servers.editmamei.env] table when there is one', async () => {
    const existing = [
      '[mcp_servers.editmamei]',
      'command = "npx"',
      'args = ["-y", "editmamei"]',
      'startup_timeout_sec = 60',
      'tool_timeout_sec = 600',
      '',
      '[mcp_servers.editmamei.env]',
      'LOG_LEVEL = "0"',
      '',
    ].join('\n');
    writeFileSync(configPath, existing);
    await installCodex(
      { ...npxEntry, env: { PHOTOSHOP_PATH: '/Applications/PS.app' } },
      { configPath }
    );
    const out = readFileSync(configPath, 'utf8');
    expect(out).toContain(
      '[mcp_servers.editmamei.env]\nPHOTOSHOP_PATH = "/Applications/PS.app"\nLOG_LEVEL = "0"'
    );
    expect(out).not.toMatch(/^env = /m);
  });

  it('refuses an entry written as dotted keys or an inline table, and writes nothing', async () => {
    for (const existing of [
      'mcp_servers.editmamei.command = "npx"\n',
      '[mcp_servers]\neditmamei = { command = "npx", args = ["-y", "editmamei"] }\n',
    ]) {
      writeFileSync(configPath, existing);
      const r = await installCodex(npxEntry, { configPath });
      expect(r.status).toBe('failed');
      expect(r.detail).toMatch(/dotted keys or an inline table/);
      expect(readFileSync(configPath, 'utf8')).toBe(existing);
    }
  });

  it('refuses when mcp_servers itself is an inline table, which a new table would redefine', async () => {
    for (const existing of [
      'mcp_servers = { other = { command = "x" } }\n',
      'mcp_servers = { editmamei = { command = "npx" } }\n',
    ]) {
      writeFileSync(configPath, existing);
      const r = await installCodex(npxEntry, { configPath });
      expect(r.status).toBe('failed');
      expect(readFileSync(configPath, 'utf8')).toBe(existing);
    }
  });

  it('refuses to add an env table next to dotted env keys', async () => {
    const existing = [
      '[mcp_servers.editmamei]',
      'command = "npx"',
      'args = ["-y", "editmamei"]',
      'env.LOG_LEVEL = "0"',
      '',
    ].join('\n');
    writeFileSync(configPath, existing);
    const r = await installCodex({ ...npxEntry, env: { PHOTOSHOP_PATH: '/x' } }, { configPath });
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/dotted keys/);
    expect(readFileSync(configPath, 'utf8')).toBe(existing);
  });

  it('refuses a multi-line string inside its table', async () => {
    const existing = [
      '[mcp_servers.editmamei]',
      'command = "npx"',
      'note = """',
      '[not a header]',
      '"""',
      '',
    ].join('\n');
    writeFileSync(configPath, existing);
    expect((await installCodex(npxEntry, { configPath })).status).toBe('failed');
    expect(readFileSync(configPath, 'utf8')).toBe(existing);
    expect((await uninstallCodex({ configPath })).status).toBe('failed');
    expect((await statusCodex({ configPath })).status).toBe('error');
    expect(readFileSync(configPath, 'utf8')).toBe(existing);
  });

  it('keeps values holding #, [ and ], a header comment, and an array of tables after it', async () => {
    const existing = [
      '[mcp_servers.editmamei] # mine',
      'command = "node"',
      'args = ["C:/a [b]/#c.js"]',
      '',
      '[[profiles]]',
      'name = "x"',
      '',
    ].join('\n');
    writeFileSync(configPath, existing);
    await installCodex(npxEntry, { configPath });
    expect(readFileSync(configPath, 'utf8')).toBe(
      [
        '[mcp_servers.editmamei] # mine',
        'startup_timeout_sec = 60',
        'tool_timeout_sec = 600',
        'command = "npx"',
        'args = ["-y", "editmamei"]',
        '',
        '[[profiles]]',
        'name = "x"',
        '',
      ].join('\n')
    );
  });

  it('adds the main table and keeps saved approvals when only those exist', async () => {
    const existing = '[mcp_servers.editmamei.tools.ps_ping]\napproval_mode = "approve"\n';
    writeFileSync(configPath, existing);
    const r = await installCodex(npxEntry, { configPath });
    expect(r.status).toBe('created');
    expect(readFileSync(configPath, 'utf8')).toBe(existing + '\n' + FRESH_BLOCK);
  });

  it('is not fooled by another server whose name starts with editmamei', async () => {
    const existing = '[mcp_servers.editmamei-connect]\nurl = "https://example.invalid/mcp"\n';
    writeFileSync(configPath, existing);
    const r = await installCodex(npxEntry, { configPath });
    expect(r.status).toBe('created');
    expect(readFileSync(configPath, 'utf8')).toBe(existing + '\n' + FRESH_BLOCK);
  });

  it('skips when the Codex home folder is missing and codex is not on PATH', async () => {
    const missing = join(dir, 'nope', 'config.toml');
    const r = await installCodex(npxEntry, { configPath: missing });
    // `codex` may be on a developer's PATH; only assert the no-write outcome then.
    if (r.status === 'skipped') {
      expect(r.detail).toMatch(/ChatGPT desktop app/);
      expect(existsSync(missing)).toBe(false);
    } else {
      expect(r.status).toBe('created');
    }
  });
});

describe('uninstallCodex and statusCodex', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editmamei-codex-test-'));
    mkdirSync(join(dir, '.codex'), { recursive: true });
    configPath = join(dir, '.codex', 'config.toml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes the table and its sub-tables, leaving the rest', async () => {
    const before = 'model = "gpt-6"\n\n[mcp_servers.other]\ncommand = "x"\n';
    writeFileSync(configPath, before);
    await installCodex(npxEntry, { configPath });
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8') +
        '\n[mcp_servers.editmamei.tools.ps_ping]\napproval_mode = "approve"\n\n[windows]\nsandbox = "elevated"\n'
    );

    expect((await statusCodex({ configPath })).status).toBe('registered');
    const r = await uninstallCodex({ configPath });
    expect(r.status).toBe('removed');
    expect(readFileSync(configPath, 'utf8')).toBe(before + '\n[windows]\nsandbox = "elevated"\n');
    expect((await statusCodex({ configPath })).status).toBe('not-registered');
  });

  it('reports absent when there is nothing to remove', async () => {
    writeFileSync(configPath, 'model = "gpt-6"\n');
    expect((await uninstallCodex({ configPath })).status).toBe('absent');
  });

  it('status shows the registered command', async () => {
    await installCodex(npxEntry, { configPath });
    const s = await statusCodex({ configPath });
    expect(s.command).toBe('npx -y editmamei');
  });
});

describe('upsertEntry', () => {
  it('does not treat a commented-out header as the table', () => {
    const doc = parseDoc('# [mcp_servers.editmamei]\n');
    const r = upsertEntry(doc, npxEntry);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok')
      expect(renderDoc(r.doc)).toBe('# [mcp_servers.editmamei]\n\n' + FRESH_BLOCK);
  });
});
