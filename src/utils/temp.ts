import * as fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from './logger.js';

/**
 * Per-invocation sandboxed temp directory.
 *
 * Creates a directory under the OS temp root with an unguessable random
 * suffix (via `fs.mkdtemp`), holds it open for the caller, then removes the
 * directory and everything inside on `cleanup()`. This closes three classes
 * of bugs at once:
 *
 *  1. Filename collision when two scripts are dispatched in the same ms
 *     (the old code used `Date.now()` alone).
 *  2. TOCTOU / symlink races where another local user could write into
 *     %TEMP% between our `writeFile` and `cscript`/`osascript`'s read.
 *  3. VBScript/AppleScript wrapper injection where a path-component might
 *     contain a quote or backslash that breaks the wrapper string.
 *
 * If `tmpdir()` is unwritable by the running uid (most common cause: a
 * `sudo`-inherited TMPDIR pointing at root's `/var/folders/zz/.../T/`),
 * `create()` falls back to a user-owned cache dir. The fallback is logged
 * once per process at WARN level so the user knows their env is unusual.
 *
 * Usage:
 *
 *   const dir = await TempDir.create('editmamei-script-');
 *   try {
 *     const jsx = dir.path('script.jsx');
 *     await dir.write('script.jsx', body);
 *     // ...use jsx...
 *   } finally {
 *     await dir.cleanup();
 *   }
 */

// fs ops indirected through a mutable namespace so tests can swap them.
// ESM named imports can't be spied on (the module namespace is non-
// configurable), so production code goes through this binding instead.
const fsOps = {
  mkdtemp: fs.mkdtemp,
  mkdir: fs.mkdir,
  rm: fs.rm,
  writeFile: fs.writeFile,
};

export class TempDir {
  private constructor(public readonly root: string) {}

  static async create(prefix: string): Promise<TempDir> {
    try {
      const root = await fsOps.mkdtemp(join(tmpdir(), prefix));
      return new TempDir(root);
    } catch (err) {
      if (!isPermissionError(err)) throw err;
      return TempDir.createInFallback(prefix, err);
    }
  }

  /**
   * Create a temp dir with an explicit root, bypassing `tmpdir()`. Used when
   * the default temp root has problems specific to the caller's downstream
   * consumer — the canonical case is `ps_get_preview` on macOS, where
   * `tmpdir()` can return `/tmp` and Photoshop's saveAs to `/tmp` paths
   * silently fails (sandbox / symlink quirk). Caller passes
   * `userOwnedTempRoot()` for `~/Library/Caches/editmamei/tmp` and Photoshop
   * can definitely write there.
   *
   * Creates the parent path if it doesn't already exist, the same way the
   * permission-error fallback does. No fallback chain — if the explicit root
   * is itself unwritable, the throw propagates unchanged.
   */
  static async createWithRoot(rootPath: string, prefix: string): Promise<TempDir> {
    await fsOps.mkdir(rootPath, { recursive: true });
    const root = await fsOps.mkdtemp(join(rootPath, prefix));
    return new TempDir(root);
  }

  /** Absolute path to a file inside this temp dir (does not create it). */
  path(name: string): string {
    return join(this.root, name);
  }

  /** Write a file with the given contents inside this temp dir. */
  async write(name: string, contents: string): Promise<string> {
    const full = this.path(name);
    await fsOps.writeFile(full, contents, 'utf8');
    return full;
  }

  /** Remove the directory and everything inside. Idempotent and best-effort. */
  async cleanup(): Promise<void> {
    await fsOps.rm(this.root, { recursive: true, force: true }).catch(() => undefined);
  }

  private static async createInFallback(prefix: string, primaryErr: unknown): Promise<TempDir> {
    const fbRoot = userOwnedTempRoot();
    try {
      await fsOps.mkdir(fbRoot, { recursive: true });
      const root = await fsOps.mkdtemp(join(fbRoot, prefix));
      warnFallbackOnce(fbRoot);
      return new TempDir(root);
    } catch (fbErr) {
      const primaryMsg = errorString(primaryErr);
      const fbMsg = errorString(fbErr);
      throw new Error(
        `TempDir.create: tmpdir() at ${tmpdir()} was not writable (${primaryMsg}); ` +
          `user-owned fallback ${fbRoot} also failed (${fbMsg}). ` +
          `Most common cause: TMPDIR inherited from a sudo session — start a fresh shell.`
      );
    }
  }
}

/**
 * Pick a temp root that is guaranteed user-owned and writable, regardless of
 * what `tmpdir()` returns. Used as a fallback when the system temp dir is
 * unreachable (most often because TMPDIR was inherited from a sudo session
 * and points at root's `/var/folders/zz/.../T/`).
 *
 * Exported for tests; production callers go through `TempDir.create`.
 */
export function userOwnedTempRoot(): string {
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'editmamei', 'tmp');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) return join(localAppData, 'editmamei', 'tmp');
    return join(home, 'AppData', 'Local', 'editmamei', 'tmp');
  }
  const xdgCache = process.env.XDG_CACHE_HOME;
  if (xdgCache) return join(xdgCache, 'editmamei', 'tmp');
  return join(home, '.cache', 'editmamei', 'tmp');
}

function isPermissionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === 'EACCES' || code === 'EPERM';
}

function errorString(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

let warnedAboutFallback = false;
const fallbackLogger = new Logger('TempDir');

function warnFallbackOnce(fbRoot: string): void {
  if (warnedAboutFallback) return;
  warnedAboutFallback = true;
  fallbackLogger.warn(
    `tmpdir() at ${tmpdir()} was not writable by this uid; using ${fbRoot} instead. ` +
      `Most often TMPDIR was inherited from a sudo session — start a fresh shell to clear it.`
  );
}

// ============================================================================
// Test seam — swap fs ops without depending on vitest ESM spying.
// Production code never touches these.
// ============================================================================

/**
 * Test-only — override one or more fs operations. Pair with __resetForTests.
 * @internal
 */
export function __setFsOpsForTests(overrides: Partial<typeof fsOps>): void {
  Object.assign(fsOps, overrides);
}

/**
 * Test-only — restore production fs ops and reset the one-shot warn flag.
 * @internal
 */
export function __resetForTests(): void {
  fsOps.mkdtemp = fs.mkdtemp;
  fsOps.mkdir = fs.mkdir;
  fsOps.rm = fs.rm;
  fsOps.writeFile = fs.writeFile;
  warnedAboutFallback = false;
}
