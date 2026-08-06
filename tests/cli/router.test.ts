import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { routeCli } from '@editmamei/cli/router.ts';

/**
 * Router-level tests. The router is the single piece of CLI surface that
 * sees raw argv, so every dispatch path needs explicit coverage. Anything
 * we miss here is a UX hole that ships to npm users.
 *
 * The router is callable from tests because it returns `{ handled, exitCode }`
 * rather than calling `process.exit` directly — that's the point of the
 * refactor done after the first QA pass.
 */

describe('routeCli', () => {
  let dir: string;
  let stderr: string;
  const collectStderr = (s: string) => {
    stderr += s;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editmamei-router-test-'));
    stderr = '';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns handled=false for no args (caller starts MCP server)', async () => {
    const r = await routeCli([], { stderr: collectStderr });
    expect(r).toEqual({ handled: false, exitCode: 0 });
    expect(stderr).toBe('');
  });

  it('returns handled=false for explicit "serve"', async () => {
    const r = await routeCli(['serve'], { stderr: collectStderr });
    expect(r).toEqual({ handled: false, exitCode: 0 });
  });

  it('handles --help cleanly', async () => {
    const r = await routeCli(['--help'], { stderr: collectStderr });
    expect(r).toEqual({ handled: true, exitCode: 0 });
  });

  it('handles -h cleanly', async () => {
    const r = await routeCli(['-h'], { stderr: collectStderr });
    expect(r).toEqual({ handled: true, exitCode: 0 });
  });

  it('handles "help" subcommand cleanly', async () => {
    const r = await routeCli(['help'], { stderr: collectStderr });
    expect(r).toEqual({ handled: true, exitCode: 0 });
  });

  it('exit 1 + help on unknown subcommand', async () => {
    const r = await routeCli(['bogus'], { stderr: collectStderr });
    expect(r).toEqual({ handled: true, exitCode: 1 });
    expect(stderr).toContain('Unknown command: bogus');
    expect(stderr).toContain('Usage:'); // help text follows
  });

  it('exit 1 + help on unknown install option', async () => {
    const r = await routeCli(['install', '--bogus'], { stderr: collectStderr });
    expect(r).toEqual({ handled: true, exitCode: 1 });
    expect(stderr).toContain('Unknown option for install: --bogus');
    expect(stderr).toContain('Usage:');
  });

  it('catches subcommand errors and exits 1', async () => {
    // Force install to throw: point at a deliberately-malformed config so
    // it raises "not valid JSON" mid-flow. We need to set the config path
    // via env-isolation here, since routeCli builds its own InstallOptions.
    // Easiest: use an unknown OS to make path resolution throw.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    try {
      const r = await routeCli(['install'], { stderr: collectStderr });
      expect(r).toEqual({ handled: true, exitCode: 1 });
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('install: --photoshop-path requires a value', async () => {
    const r = await routeCli(['install', '--photoshop-path'], { stderr: collectStderr });
    expect(r).toEqual({ handled: true, exitCode: 1 });
    expect(stderr).toContain('--photoshop-path requires a path');
  });

  it('install: --photoshop-path swallows a following value (not an unknown option)', async () => {
    // Stub the platform to make install fail at path resolution AFTER
    // arg-parsing succeeds. If arg parsing tried to also consume
    // "/some/path" as a separate flag, we'd get "Unknown option".
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    try {
      const r = await routeCli(['install', '--photoshop-path', '/some/path'], {
        stderr: collectStderr,
      });
      expect(r.exitCode).toBe(1);
      expect(stderr).not.toContain('Unknown option');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('install: --photoshop-path=VALUE form also parses', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    try {
      const r = await routeCli(['install', '--photoshop-path=/some/path'], {
        stderr: collectStderr,
      });
      expect(r.exitCode).toBe(1);
      expect(stderr).not.toContain('Unknown option');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('install with --dev parses cleanly (no error)', async () => {
    // We can't fully execute install without a config-path override that
    // the router doesn't expose, but we can confirm the --dev flag is
    // accepted (no "unknown option" error) by inducing a path-resolution
    // failure further down the stack.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    try {
      const r = await routeCli(['install', '--dev'], { stderr: collectStderr });
      // Got past arg-parsing; the install itself failed at path resolution.
      // The "unknown option" error path would set exitCode=1 with that
      // specific stderr — we'd see it before reaching the catch.
      expect(r.exitCode).toBe(1);
      expect(stderr).not.toContain('Unknown option');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});
