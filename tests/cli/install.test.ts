import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runInstall, buildEntry } from '@editmamei/cli/install.ts';
import { runUninstall } from '@editmamei/cli/uninstall.ts';
import { runStatus } from '@editmamei/cli/status.ts';

/**
 * These tests exercise the orchestrator pinned to Claude Desktop only.
 * Each call sets `skipCursor: true` and `skipClaudeCode: true` so the
 * test environment's real Cursor / Claude Code state never leaks in.
 * Cursor and Claude Code each have their own test files.
 *
 * The `claudeDesktopConfigPath` test hook redirects writes into a temp
 * dir so the real Claude Desktop config is never touched.
 */

const onlyClaudeDesktop = { skipCursor: true as const, skipClaudeCode: true as const };

describe('runInstall — Claude Desktop slice', () => {
  let dir: string;
  let claudeDesktopConfigPath: string;
  let out: string;
  const stdout = (s: string) => {
    out += s;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editmamei-install-test-'));
    claudeDesktopConfigPath = join(dir, 'claude_desktop_config.json');
    out = '';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a new config when none exists', async () => {
    await runInstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });

    expect(existsSync(claudeDesktopConfigPath)).toBe(true);
    const config = JSON.parse(readFileSync(claudeDesktopConfigPath, 'utf8'));
    expect(config.mcpServers.editmamei).toEqual({ command: 'npx', args: ['-y', 'editmamei'] });
    expect(out).toContain('✓ Claude Desktop');
    expect(out).toContain('registered');
  });

  it('preserves other mcpServers entries when merging', async () => {
    writeFileSync(
      claudeDesktopConfigPath,
      JSON.stringify({
        mcpServers: {
          'other-server': { command: 'other-bin', args: ['--flag'] },
        },
      })
    );

    await runInstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });

    const config = JSON.parse(readFileSync(claudeDesktopConfigPath, 'utf8'));
    expect(config.mcpServers['other-server']).toEqual({
      command: 'other-bin',
      args: ['--flag'],
    });
    expect(config.mcpServers.editmamei).toEqual({ command: 'npx', args: ['-y', 'editmamei'] });
  });

  it('preserves top-level non-mcpServers config keys', async () => {
    writeFileSync(
      claudeDesktopConfigPath,
      JSON.stringify({
        someUnrelatedKey: { foo: 'bar' },
        mcpServers: {},
      })
    );

    await runInstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });

    const config = JSON.parse(readFileSync(claudeDesktopConfigPath, 'utf8'));
    expect(config.someUnrelatedKey).toEqual({ foo: 'bar' });
    expect(config.mcpServers.editmamei).toBeDefined();
  });

  it('backs up an existing config to .bak before writing', async () => {
    const originalContent = JSON.stringify({ mcpServers: { x: { command: 'x' } } });
    writeFileSync(claudeDesktopConfigPath, originalContent);

    await runInstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });

    expect(existsSync(`${claudeDesktopConfigPath}.bak`)).toBe(true);
    expect(readFileSync(`${claudeDesktopConfigPath}.bak`, 'utf8')).toBe(originalContent);
    expect(out).toContain('.bak');
    expect(out).toContain('Backed up prior config');
  });

  it('does not back up when no existing config (nothing to back up)', async () => {
    await runInstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });

    expect(existsSync(`${claudeDesktopConfigPath}.bak`)).toBe(false);
  });

  it('is idempotent — second run with same args makes no changes', async () => {
    await runInstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });
    const firstWrite = readFileSync(claudeDesktopConfigPath, 'utf8');

    out = '';
    await runInstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });

    expect(readFileSync(claudeDesktopConfigPath, 'utf8')).toBe(firstWrite);
    expect(out).toContain('already registered');
  });

  it('replaces an existing editmamei entry with different args', async () => {
    writeFileSync(
      claudeDesktopConfigPath,
      JSON.stringify({
        mcpServers: {
          editmamei: { command: 'node', args: ['/old/path/dist/index.js'] },
        },
      })
    );

    await runInstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });

    const config = JSON.parse(readFileSync(claudeDesktopConfigPath, 'utf8'));
    expect(config.mcpServers.editmamei).toEqual({ command: 'npx', args: ['-y', 'editmamei'] });
    expect(out).toContain('updated');
  });

  it('refuses to overwrite malformed JSON and throws when no other client succeeded', async () => {
    writeFileSync(claudeDesktopConfigPath, '{ this is not json');

    await expect(
      runInstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop })
    ).rejects.toThrow(/all MCP clients failed/);

    expect(out).toContain('not valid JSON');
    expect(readFileSync(claudeDesktopConfigPath, 'utf8')).toBe('{ this is not json');
    expect(existsSync(`${claudeDesktopConfigPath}.bak`)).toBe(false);
  });

  it('treats an empty existing file as a fresh config', async () => {
    writeFileSync(claudeDesktopConfigPath, '');

    await runInstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });

    const config = JSON.parse(readFileSync(claudeDesktopConfigPath, 'utf8'));
    expect(config.mcpServers.editmamei).toBeDefined();
  });

  it('preserves a pre-existing .bak rather than clobbering it', async () => {
    writeFileSync(claudeDesktopConfigPath, JSON.stringify({ mcpServers: {} }));
    writeFileSync(`${claudeDesktopConfigPath}.bak`, 'pristine pre-install state');

    await runInstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });

    expect(readFileSync(`${claudeDesktopConfigPath}.bak`, 'utf8')).toBe(
      'pristine pre-install state'
    );
    expect(out).toContain('Pre-existing backup preserved');
  });

  it('surfaces mkdir failure in output and throws when no other client succeeded', async () => {
    const blockerFile = join(dir, 'i-am-a-file');
    writeFileSync(blockerFile, 'block');
    const blockedPath = join(blockerFile, 'subdir', 'claude_desktop_config.json');

    await expect(
      runInstall({ claudeDesktopConfigPath: blockedPath, stdout, ...onlyClaudeDesktop })
    ).rejects.toThrow(/all MCP clients failed/);

    expect(out).toContain('Could not create');
    expect(out).toContain('Claude Desktop');
  });
});

describe('buildEntry', () => {
  it('emits the npx form by default', () => {
    expect(buildEntry({})).toEqual({ command: 'npx', args: ['-y', 'editmamei'] });
  });

  it('emits a node + absolute path under --dev (path is normalized)', () => {
    const entry = buildEntry({ dev: true, devBinaryPath: '/path/to/dist/index.js' });
    expect(entry).toEqual({
      command: 'node',
      args: [resolve('/path/to/dist/index.js')],
    });
  });

  it('throws under --dev when no path is derivable', () => {
    expect(() => buildEntry({ dev: true, devBinaryPath: '' })).toThrow(/--dev/);
  });

  it('adds PHOTOSHOP_PATH to env when photoshopPath is set', () => {
    const entry = buildEntry({ photoshopPath: '/Applications/Adobe Photoshop 2025/Photoshop' });
    expect(entry.env).toEqual({
      PHOTOSHOP_PATH: resolve('/Applications/Adobe Photoshop 2025/Photoshop'),
    });
    // Default command form is unchanged.
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual(['-y', 'editmamei']);
  });

  it('combines --dev and --photoshop-path correctly', () => {
    const entry = buildEntry({
      dev: true,
      devBinaryPath: '/some/dist/index.js',
      photoshopPath: '/path/to/Photoshop.exe',
    });
    expect(entry.command).toBe('node');
    expect(entry.args).toEqual([resolve('/some/dist/index.js')]);
    expect(entry.env).toEqual({ PHOTOSHOP_PATH: resolve('/path/to/Photoshop.exe') });
  });

  it('omits env entirely when photoshopPath is not set', () => {
    const entry = buildEntry({});
    expect(entry.env).toBeUndefined();
  });
});

describe('runUninstall — Claude Desktop slice', () => {
  let dir: string;
  let claudeDesktopConfigPath: string;
  let out: string;
  const stdout = (s: string) => {
    out += s;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editmamei-uninstall-test-'));
    claudeDesktopConfigPath = join(dir, 'claude_desktop_config.json');
    out = '';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports nothing-to-do when config file does not exist', async () => {
    await runUninstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });
    expect(out).toContain('not registered');
    expect(existsSync(claudeDesktopConfigPath)).toBe(false);
  });

  it('reports nothing-to-do when editmamei is not registered', async () => {
    writeFileSync(
      claudeDesktopConfigPath,
      JSON.stringify({ mcpServers: { other: { command: 'x' } } })
    );

    await runUninstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });

    expect(out).toContain('not registered');
    const config = JSON.parse(readFileSync(claudeDesktopConfigPath, 'utf8'));
    expect(config.mcpServers.other).toBeDefined();
  });

  it('removes editmamei and preserves other entries', async () => {
    writeFileSync(
      claudeDesktopConfigPath,
      JSON.stringify({
        mcpServers: {
          editmamei: { command: 'npx', args: ['-y', 'editmamei'] },
          other: { command: 'other' },
        },
      })
    );

    await runUninstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });

    const config = JSON.parse(readFileSync(claudeDesktopConfigPath, 'utf8'));
    expect(config.mcpServers.editmamei).toBeUndefined();
    expect(config.mcpServers.other).toBeDefined();
    expect(existsSync(`${claudeDesktopConfigPath}.bak`)).toBe(true);
  });

  it('refuses to operate on malformed JSON and throws when no other client succeeded', async () => {
    writeFileSync(claudeDesktopConfigPath, '{ this is not json');

    await expect(
      runUninstall({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop })
    ).rejects.toThrow(/all MCP clients failed/);

    expect(out).toContain('not valid JSON');
    expect(readFileSync(claudeDesktopConfigPath, 'utf8')).toBe('{ this is not json');
    expect(existsSync(`${claudeDesktopConfigPath}.bak`)).toBe(false);
  });
});

describe('runStatus — Claude Desktop slice', () => {
  let dir: string;
  let claudeDesktopConfigPath: string;
  let out: string;
  const stdout = (s: string) => {
    out += s;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editmamei-status-test-'));
    claudeDesktopConfigPath = join(dir, 'claude_desktop_config.json');
    out = '';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports not-registered when config does not exist', async () => {
    await runStatus({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });
    expect(out).toContain('Claude Desktop');
    expect(out).toContain('not registered');
  });

  it('reports registered when editmamei is in the config', async () => {
    writeFileSync(
      claudeDesktopConfigPath,
      JSON.stringify({
        mcpServers: { editmamei: { command: 'npx', args: ['-y', 'editmamei'] } },
      })
    );

    await runStatus({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });

    expect(out).toContain('Status: registered');
    expect(out).toContain('npx');
    expect(out).toContain('editmamei');
  });

  it('surfaces a parse error rather than silently treating it as unregistered', async () => {
    writeFileSync(claudeDesktopConfigPath, '{ not valid');
    await runStatus({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });
    expect(out).toContain('error');
    expect(out).toContain('not valid JSON');
  });

  it('reports not-registered when config exists but has no mcpServers key', async () => {
    writeFileSync(claudeDesktopConfigPath, JSON.stringify({ someOtherKey: { foo: 'bar' } }));
    await runStatus({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });
    expect(out).toContain('not registered');
  });

  it('reports not-registered when config exists with empty mcpServers', async () => {
    writeFileSync(claudeDesktopConfigPath, JSON.stringify({ mcpServers: {} }));
    await runStatus({ claudeDesktopConfigPath, stdout, ...onlyClaudeDesktop });
    expect(out).toContain('not registered');
  });
});

describe('runInstall — multi-client orchestration', () => {
  let dir: string;
  let claudeDesktopConfigPath: string;
  let cursorConfigPath: string;
  let out: string;
  const stdout = (s: string) => {
    out += s;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editmamei-multi-test-'));
    claudeDesktopConfigPath = join(dir, 'cd', 'claude_desktop_config.json');
    cursorConfigPath = join(dir, '.cursor', 'mcp.json');
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    out = '';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers Claude Desktop + Cursor in one pass', async () => {
    await runInstall({
      claudeDesktopConfigPath,
      cursorConfigPath,
      stdout,
      skipClaudeCode: true,
    });

    expect(existsSync(claudeDesktopConfigPath)).toBe(true);
    expect(existsSync(cursorConfigPath)).toBe(true);

    const cd = JSON.parse(readFileSync(claudeDesktopConfigPath, 'utf8'));
    const cur = JSON.parse(readFileSync(cursorConfigPath, 'utf8'));
    expect(cd.mcpServers.editmamei).toEqual({ command: 'npx', args: ['-y', 'editmamei'] });
    expect(cur.mcpServers.editmamei).toEqual({ command: 'npx', args: ['-y', 'editmamei'] });

    expect(out).toContain('✓ Claude Desktop');
    expect(out).toContain('✓ Cursor');
  });

  it('reports a per-client line for each adapter', async () => {
    await runInstall({
      claudeDesktopConfigPath,
      cursorConfigPath,
      stdout,
      skipClaudeCode: true,
    });

    expect(out.match(/Claude Desktop:/g)?.length).toBe(1);
    expect(out.match(/Cursor:/g)?.length).toBe(1);
  });

  it('partial failure: one client failing does not abort the others', async () => {
    const blockerFile = join(dir, 'block');
    writeFileSync(blockerFile, 'x');
    const blockedCdPath = join(blockerFile, 'sub', 'config.json');

    await runInstall({
      claudeDesktopConfigPath: blockedCdPath,
      cursorConfigPath,
      stdout,
      skipClaudeCode: true,
    });

    expect(existsSync(cursorConfigPath)).toBe(true);
    expect(out).toContain('✗ Claude Desktop');
    expect(out).toContain('✓ Cursor');
  });

  it('--photoshop-path bakes PHOTOSHOP_PATH into both JSON-config clients', async () => {
    const psPath = '/Applications/Adobe Photoshop 2025/Photoshop';

    await runInstall({
      claudeDesktopConfigPath,
      cursorConfigPath,
      photoshopPath: psPath,
      stdout,
      skipClaudeCode: true,
    });

    const cd = JSON.parse(readFileSync(claudeDesktopConfigPath, 'utf8'));
    const cur = JSON.parse(readFileSync(cursorConfigPath, 'utf8'));

    expect(cd.mcpServers.editmamei.env).toEqual({ PHOTOSHOP_PATH: resolve(psPath) });
    expect(cur.mcpServers.editmamei.env).toEqual({ PHOTOSHOP_PATH: resolve(psPath) });
    expect(out).toContain('PHOTOSHOP_PATH=');
  });

  it('preserves user-added env vars when re-running install', async () => {
    // The multi-client beforeEach pre-creates .cursor/ but not cd/ —
    // create the Claude Desktop parent dir before writing into it.
    mkdirSync(join(dir, 'cd'), { recursive: true });
    // Simulate a user who hand-added LOG_LEVEL after the first install.
    writeFileSync(
      claudeDesktopConfigPath,
      JSON.stringify({
        mcpServers: {
          editmamei: {
            command: 'npx',
            args: ['-y', 'editmamei'],
            env: { LOG_LEVEL: '0', CUSTOM_VAR: 'kept' },
          },
        },
      })
    );

    await runInstall({
      claudeDesktopConfigPath,
      cursorConfigPath,
      photoshopPath: '/path/to/Photoshop.exe',
      stdout,
      skipClaudeCode: true,
    });

    const cd = JSON.parse(readFileSync(claudeDesktopConfigPath, 'utf8'));
    expect(cd.mcpServers.editmamei.env).toEqual({
      LOG_LEVEL: '0',
      CUSTOM_VAR: 'kept',
      PHOTOSHOP_PATH: resolve('/path/to/Photoshop.exe'),
    });
  });
});

describe('runInstall — skill bundle copy', () => {
  let dir: string;
  let claudeDesktopConfigPath: string;
  let skillSource: string;
  let downloadsDir: string;
  let out: string;
  const stdout = (s: string) => {
    out += s;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editmamei-skill-test-'));
    claudeDesktopConfigPath = join(dir, 'claude_desktop_config.json');
    skillSource = join(dir, 'editmamei-skill.zip');
    downloadsDir = join(dir, 'Downloads');
    mkdirSync(downloadsDir);
    // Fake skill source — content doesn't matter, just needs to exist
    // so the copy succeeds. The build-skill-zip.test.ts covers actual
    // zip correctness.
    writeFileSync(skillSource, 'PK\x03\x04 fake zip bytes', 'utf8');
    out = '';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies the skill bundle into the destination directory and prints upload guidance', async () => {
    await runInstall({
      claudeDesktopConfigPath,
      stdout,
      ...onlyClaudeDesktop,
      skillBundleSourcePath: skillSource,
      skillBundleDestDir: downloadsDir,
    });
    const expectedDest = join(downloadsDir, 'editmamei-skill.zip');
    expect(existsSync(expectedDest)).toBe(true);
    expect(out).toContain('Setting up Claude skill');
    expect(out).toContain('editmamei skill bundle copied to');
    expect(out).toContain(expectedDest);
    expect(out).toContain('Upload the editmamei skill');
    expect(out).toContain('claude.ai/settings');
    expect(out).toContain('Customize > Skills');
  });

  it('soft-fails when the skill source is missing — MCP install still succeeds', async () => {
    rmSync(skillSource);
    await runInstall({
      claudeDesktopConfigPath,
      stdout,
      ...onlyClaudeDesktop,
      skillBundleSourcePath: skillSource,
      skillBundleDestDir: downloadsDir,
    });
    // MCP server registration succeeded.
    expect(existsSync(claudeDesktopConfigPath)).toBe(true);
    // Skill copy reports missing-source but doesn't throw.
    expect(out).toContain('Setting up Claude skill');
    expect(out).toContain('skill bundle missing');
    expect(out).toContain('Rebuild with');
    // Upload guidance is omitted when the copy didn't happen.
    expect(out).not.toContain('Upload the editmamei skill');
    // Final assertion: no skill file in the destination.
    expect(existsSync(join(downloadsDir, 'editmamei-skill.zip'))).toBe(false);
  });

  it('skipSkill=true bypasses the skill copy entirely', async () => {
    await runInstall({
      claudeDesktopConfigPath,
      stdout,
      ...onlyClaudeDesktop,
      skillBundleSourcePath: skillSource,
      skillBundleDestDir: downloadsDir,
      skipSkill: true,
    });
    // MCP install proceeded normally.
    expect(existsSync(claudeDesktopConfigPath)).toBe(true);
    // No skill section in output at all when skipped.
    expect(out).not.toContain('Setting up Claude skill');
    expect(out).not.toContain('Upload the editmamei skill');
    // No file created.
    expect(existsSync(join(downloadsDir, 'editmamei-skill.zip'))).toBe(false);
  });
});
