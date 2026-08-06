import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseListForEntry } from '@editmamei/cli/clients/claude-code.ts';

/**
 * Claude Code adapter wraps the `claude mcp` CLI. We can't safely shell
 * out from the test runner (the developer's real Claude Code state would
 * be touched), so spawn-level integration is mocked: vi.mock replaces
 * `shell.ts` with deterministic stubs and we assert the adapter chose
 * the right CLI calls in the right order.
 *
 * The pure `parseListForEntry` helper is tested separately — no mocking
 * needed since it's a regex over a string.
 */

describe('parseListForEntry', () => {
  it('returns the right-of-colon command for a present entry', () => {
    const out = `
some-other-server: foo
editmamei: npx -y editmamei
another: bar baz
`;
    expect(parseListForEntry(out)).toBe('npx -y editmamei');
  });

  it('handles --dev style entries', () => {
    const out = 'editmamei: node /path/to/dist/index.js';
    expect(parseListForEntry(out)).toBe('node /path/to/dist/index.js');
  });

  it('returns null when editmamei is absent', () => {
    expect(parseListForEntry('other: stuff\nanother: thing')).toBeNull();
  });

  it('returns null on empty output', () => {
    expect(parseListForEntry('')).toBeNull();
  });

  it('does not match a partial-name row', () => {
    expect(parseListForEntry('editmamei-tester: should-not-match')).toBeNull();
  });
});

describe('Claude Code adapter (mocked shell)', () => {
  type RunResult = { exitCode: number; stdout: string; stderr: string };
  type RunFn = (cmd: string, args: string[]) => Promise<RunResult>;

  // Mutable handles so individual tests can override per-call behavior.
  let onPathHandler: (cmd: string) => Promise<boolean>;
  let runCaptureHandler: RunFn;

  beforeEach(() => {
    // The first describe statically imports from claude-code.ts (line 2),
    // caching it AND shell.ts before this doMock runs. resetModules only ran
    // in afterEach, so the FIRST test here loaded the real (unmocked) shell and
    // failed on any box where `claude` is actually on PATH — it passed in CI
    // only because the real isOnPath returns false there. Reset up front so
    // every test, including the first, picks up the mock.
    vi.resetModules();
    onPathHandler = async () => true;
    runCaptureHandler = async () => ({ exitCode: 0, stdout: '', stderr: '' });

    vi.doMock('@editmamei/cli/clients/shell.ts', () => ({
      isOnPath: (cmd: string) => onPathHandler(cmd),
      runCapture: (cmd: string, args: string[]) => runCaptureHandler(cmd, args),
    }));
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@editmamei/cli/clients/shell.ts');
  });

  it('install: skips cleanly when `claude` is not on PATH', async () => {
    onPathHandler = async () => false;
    const { installClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');

    const r = await installClaudeCode({ command: 'npx', args: ['-y', 'editmamei'] });
    expect(r.status).toBe('skipped');
    expect(r.detail).toMatch(/claude binary not on PATH/);
  });

  it('install: no-op when an identical entry is already registered', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    runCaptureHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === 'mcp' && args[1] === 'list') {
        return { exitCode: 0, stdout: 'editmamei: npx -y editmamei', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const { installClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');
    const r = await installClaudeCode({ command: 'npx', args: ['-y', 'editmamei'] });

    expect(r.status).toBe('unchanged');
    // Only the `list` call should have been made — no `add`.
    expect(calls.length).toBe(1);
    expect(calls[0].args[1]).toBe('list');
  });

  it('install: removes-then-adds when an existing different entry is registered', async () => {
    const calls: string[] = [];
    runCaptureHandler = async (cmd, args) => {
      calls.push(args.join(' '));
      if (args[1] === 'list') {
        return { exitCode: 0, stdout: 'editmamei: node /old/path', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const { installClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');
    const r = await installClaudeCode({ command: 'npx', args: ['-y', 'editmamei'] });

    expect(r.status).toBe('updated');
    // Expect: list, remove, add.
    expect(calls.length).toBe(3);
    expect(calls[0]).toContain('list');
    expect(calls[1]).toContain('remove');
    expect(calls[2]).toContain('add');
    expect(calls[2]).toContain('npx');
    expect(calls[2]).toContain('-y');
    expect(calls[2]).toContain('editmamei');
  });

  it('install: creates when no editmamei entry exists', async () => {
    let lastAddArgs: string[] = [];
    runCaptureHandler = async (cmd, args) => {
      if (args[1] === 'list') {
        return { exitCode: 0, stdout: 'other-server: blah', stderr: '' };
      }
      if (args[1] === 'add') lastAddArgs = args;
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const { installClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');
    const r = await installClaudeCode({ command: 'npx', args: ['-y', 'editmamei'] });

    expect(r.status).toBe('created');
    // The add call uses --scope user.
    expect(lastAddArgs).toContain('--scope');
    expect(lastAddArgs[lastAddArgs.indexOf('--scope') + 1]).toBe('user');
  });

  it('install: env vars are passed as -e KEY=VALUE flags before the server name', async () => {
    let lastAddArgs: string[] = [];
    runCaptureHandler = async (cmd, args) => {
      if (args[1] === 'list') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[1] === 'add') lastAddArgs = args;
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const { installClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');
    await installClaudeCode({
      command: 'npx',
      args: ['-y', 'editmamei'],
      env: { PHOTOSHOP_PATH: '/Applications/Photoshop' },
    });

    // The -e flag appears before the server name 'editmamei'.
    const eIndex = lastAddArgs.indexOf('-e');
    const nameIndex = lastAddArgs.indexOf('editmamei');
    expect(eIndex).toBeGreaterThan(-1);
    expect(eIndex).toBeLessThan(nameIndex);
    // And the value is KEY=VALUE format.
    expect(lastAddArgs[eIndex + 1]).toBe('PHOTOSHOP_PATH=/Applications/Photoshop');
    // The separator and command still come after the name.
    const dashDashIndex = lastAddArgs.indexOf('--');
    expect(dashDashIndex).toBeGreaterThan(nameIndex);
  });

  it('install: multiple env vars produce multiple -e flags', async () => {
    let lastAddArgs: string[] = [];
    runCaptureHandler = async (cmd, args) => {
      if (args[1] === 'list') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[1] === 'add') lastAddArgs = args;
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const { installClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');
    await installClaudeCode({
      command: 'npx',
      args: ['-y', 'editmamei'],
      env: { PHOTOSHOP_PATH: '/p', LOG_LEVEL: '0' },
    });

    const eCount = lastAddArgs.filter((a) => a === '-e').length;
    expect(eCount).toBe(2);
    expect(lastAddArgs.some((a) => a.startsWith('PHOTOSHOP_PATH='))).toBe(true);
    expect(lastAddArgs.some((a) => a.startsWith('LOG_LEVEL='))).toBe(true);
  });

  it('install: surfaces a failed claude mcp add as failed status', async () => {
    runCaptureHandler = async (cmd, args) => {
      if (args[1] === 'list') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[1] === 'add') return { exitCode: 2, stdout: '', stderr: 'something broke' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const { installClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');
    const r = await installClaudeCode({ command: 'npx', args: ['-y', 'editmamei'] });

    expect(r.status).toBe('failed');
    expect(r.error).toContain('something broke');
  });

  it('uninstall: skips when claude not on PATH', async () => {
    onPathHandler = async () => false;
    const { uninstallClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');
    const r = await uninstallClaudeCode();
    expect(r.status).toBe('skipped');
  });

  it('uninstall: absent when claude mcp list shows no editmamei entry', async () => {
    runCaptureHandler = async (cmd, args) => {
      if (args[1] === 'list') {
        return { exitCode: 0, stdout: 'unrelated: foo', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const { uninstallClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');
    const r = await uninstallClaudeCode();
    expect(r.status).toBe('absent');
  });

  it('uninstall: removes when entry is present', async () => {
    const calls: string[] = [];
    runCaptureHandler = async (cmd, args) => {
      calls.push(args.join(' '));
      if (args[1] === 'list') {
        return { exitCode: 0, stdout: 'editmamei: npx -y editmamei', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const { uninstallClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');
    const r = await uninstallClaudeCode();
    expect(r.status).toBe('removed');
    expect(calls.some((c) => c.includes('remove'))).toBe(true);
  });

  it('status: not-detected when claude missing', async () => {
    onPathHandler = async () => false;
    const { statusClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');
    const r = await statusClaudeCode();
    expect(r.status).toBe('not-detected');
  });

  it('status: registered with the parsed command on success', async () => {
    runCaptureHandler = async () => ({
      exitCode: 0,
      stdout: 'editmamei: npx -y editmamei',
      stderr: '',
    });
    const { statusClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');
    const r = await statusClaudeCode();
    expect(r.status).toBe('registered');
    expect(r.command).toBe('npx -y editmamei');
  });

  it('status: error when claude mcp list fails', async () => {
    runCaptureHandler = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'config corrupted',
    });
    const { statusClaudeCode } = await import('@editmamei/cli/clients/claude-code.ts');
    const r = await statusClaudeCode();
    expect(r.status).toBe('error');
    expect(r.error).toContain('config corrupted');
  });
});
