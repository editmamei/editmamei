import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile, mkdtemp as realMkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  TempDir,
  userOwnedTempRoot,
  __setFsOpsForTests,
  __resetForTests,
} from '@editmamei/utils/temp.ts';

describe('TempDir', () => {
  afterEach(() => {
    __resetForTests();
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Happy path — when tmpdir() is writable, create a temp dir there.
  // ===========================================================================
  it('creates a temp directory under tmpdir() in the normal case', async () => {
    const dir = await TempDir.create('editmamei-test-');
    try {
      expect(dir.root.startsWith(tmpdir())).toBe(true);
      expect(dir.path('foo.txt')).toBe(join(dir.root, 'foo.txt'));
      const written = await dir.write('hello.txt', 'world');
      const contents = await readFile(written, 'utf8');
      expect(contents).toBe('world');
    } finally {
      await dir.cleanup();
    }
  });

  it('cleanup() is idempotent and best-effort (second call does not throw)', async () => {
    const dir = await TempDir.create('editmamei-test-');
    await dir.cleanup();
    await expect(dir.cleanup()).resolves.toBeUndefined();
  });

  // ===========================================================================
  // EACCES fallback — the install-time bug surfaced 2026-05-30.
  //
  // User's macOS install hit:
  //   EACCES: permission denied, mkdtemp '/var/folders/zz/.../T/editmamei-mac-...'
  // because TMPDIR was inherited from a prior sudo session (root's per-uid
  // folder) and the running uid couldn't write there. The fix: catch
  // EACCES/EPERM, fall back to a user-owned cache dir guaranteed writable.
  // ===========================================================================
  it('falls back to a user-owned cache dir when tmpdir() mkdtemp throws EACCES', async () => {
    let callCount = 0;
    __setFsOpsForTests({
      mkdtemp: (async (prefix: string) => {
        callCount += 1;
        if (callCount === 1) {
          const err = new Error(`EACCES: permission denied, mkdtemp '${prefix}'`);
          (err as Error & { code: string }).code = 'EACCES';
          throw err;
        }
        return realMkdtemp(prefix);
      }) as typeof realMkdtemp,
    });

    const dir = await TempDir.create('editmamei-test-fallback-');
    try {
      expect(callCount).toBe(2);
      // Returned dir lives under the user-owned fallback root.
      expect(dir.root.startsWith(userOwnedTempRoot())).toBe(true);
    } finally {
      await dir.cleanup();
    }
  });

  it('rethrows non-permission errors from the primary mkdtemp without falling back', async () => {
    let callCount = 0;
    __setFsOpsForTests({
      mkdtemp: (async () => {
        callCount += 1;
        const err = new Error('ENOSPC: no space left on device');
        (err as Error & { code: string }).code = 'ENOSPC';
        throw err;
      }) as typeof realMkdtemp,
    });

    await expect(TempDir.create('editmamei-test-no-fallback-')).rejects.toThrow(/ENOSPC/);
    expect(callCount).toBe(1);
  });

  // ===========================================================================
  // Warn-once behavior — the fallback log line is informational; firing it on
  // every script invocation would flood the user's terminal. The module-level
  // flag must suppress repeats until the process exits (or until tests reset).
  // ===========================================================================
  it('warns about the fallback at most once per process boot', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let callCount = 0;
    __setFsOpsForTests({
      mkdtemp: (async (prefix: string) => {
        callCount += 1;
        // First call of each create() throws EACCES; second (fallback) succeeds.
        if (callCount % 2 === 1) {
          const err = new Error(`EACCES: permission denied, mkdtemp '${prefix}'`);
          (err as Error & { code: string }).code = 'EACCES';
          throw err;
        }
        return realMkdtemp(prefix);
      }) as typeof realMkdtemp,
    });

    const d1 = await TempDir.create('editmamei-test-warn-1-');
    const d2 = await TempDir.create('editmamei-test-warn-2-');
    try {
      // Both invocations hit the fallback (callCount == 4: 2 fail + 2 succeed).
      expect(callCount).toBe(4);
      // But only one warn line was emitted to stderr (look for the marker).
      const warnLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('was not writable'));
      expect(warnLines.length).toBe(1);
    } finally {
      await d1.cleanup();
      await d2.cleanup();
    }
  });

  it('throws a combined diagnostic when both primary AND fallback fail', async () => {
    __setFsOpsForTests({
      mkdtemp: (async () => {
        const err = new Error("EACCES: permission denied, mkdtemp '/var/folders/zz/.../T/x'");
        (err as Error & { code: string }).code = 'EACCES';
        throw err;
      }) as typeof realMkdtemp,
      mkdir: (async () => {
        const err = new Error('EROFS: read-only file system, mkdir');
        (err as Error & { code: string }).code = 'EROFS';
        throw err;
      }) as never,
    });

    await expect(TempDir.create('editmamei-test-double-fail-')).rejects.toThrow(
      /tmpdir.+was not writable.+fallback.+also failed/i
    );
  });

  // ===========================================================================
  // 2026-06-08 v0.5.5 — TempDir.createWithRoot() lets the caller override the
  // default tmpdir() resolution. Added because macOS Photoshop's saveAs to
  // `/tmp` paths silently fails (sandbox / symlink quirk); the get_preview
  // handler now uses createWithRoot(userOwnedTempRoot()) on darwin to write
  // previews to a path PS can definitely write to.
  // ===========================================================================
  it('createWithRoot creates the temp dir under the explicit root', async () => {
    // Spy on mkdtemp to confirm the join target.
    const seenPaths: string[] = [];
    __setFsOpsForTests({
      mkdir: (async () => undefined) as never,
      mkdtemp: (async (pathPrefix: string) => {
        seenPaths.push(String(pathPrefix));
        // Return a fake path; we don't actually create on disk in this test.
        return String(pathPrefix) + 'aaaaaa';
      }) as unknown as typeof realMkdtemp,
    });
    const explicitRoot = join(homedir(), 'Library', 'Caches', 'editmamei', 'tmp');
    const dir = await TempDir.createWithRoot(explicitRoot, 'editmamei-preview-');
    expect(dir.root).toContain(explicitRoot);
    expect(dir.root).toContain('editmamei-preview-');
    expect(seenPaths[0]).toBe(join(explicitRoot, 'editmamei-preview-'));
    // mkdtemp should NOT have been called with tmpdir() — the whole point.
    expect(seenPaths.some((p) => p.startsWith(tmpdir()))).toBe(false);
  });
});

describe('userOwnedTempRoot', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns a path inside the user home dir on every platform', () => {
    const root = userOwnedTempRoot();
    expect(root.includes('editmamei')).toBe(true);
    // Must NOT live under /var/folders (where the original EACCES happened).
    expect(root.startsWith('/var/folders/zz')).toBe(false);
  });

  it('honors LOCALAPPDATA on win32 when present', () => {
    if (process.platform !== 'win32') return;
    process.env.LOCALAPPDATA = 'D:\\Custom\\AppData\\Local';
    const root = userOwnedTempRoot();
    expect(root).toBe(join('D:\\Custom\\AppData\\Local', 'editmamei', 'tmp'));
  });

  it('honors XDG_CACHE_HOME on linux when present', () => {
    if (process.platform !== 'linux') return;
    process.env.XDG_CACHE_HOME = '/tmp/custom-xdg-cache';
    const root = userOwnedTempRoot();
    expect(root).toBe(join('/tmp/custom-xdg-cache', 'editmamei', 'tmp'));
  });

  it('anchors at homedir/Library/Caches on darwin', () => {
    if (process.platform !== 'darwin') return;
    const root = userOwnedTempRoot();
    expect(root).toBe(join(homedir(), 'Library', 'Caches', 'editmamei', 'tmp'));
  });
});
