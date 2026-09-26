/**
 * Locates a GIMP install, filesystem-only.
 *
 * Unlike the Photoshop detectors (`src/platform/windows-detector.ts`,
 * `macos-detector.ts`), which run at `PhotoshopConnection` construction and
 * are allowed a registry/Spotlight round trip, this runs inside
 * `detectEditors()`'s time box (`detect-editors.ts`) before the server's
 * handshake — so it never spawns anything, not even `gimp-console --version`.
 * Version gating happens later, at first session start, via the bridge's
 * `ping` (`session.ts`).
 *
 * Every external input (`platform`, `env`, `homedir`, `exists`) is injectable
 * so the OS-specific branches are testable without touching the real
 * filesystem or `process.platform`.
 */

import { platform as osPlatform, homedir as osHomedir } from 'node:os';
import { posix as pathPosix, win32 as pathWin32 } from 'node:path';
import { stat } from 'node:fs/promises';
import { exeLaunchSpec, flatpakLaunchSpec, type LaunchSpec } from './launcher.js';

export type GimpInstallSource = 'env' | 'path' | 'conventional' | 'flatpak';

export interface GimpInstall {
  readonly source: GimpInstallSource;
  readonly path: string;
  readonly launch: LaunchSpec;
}

/** Async existence check, injectable so tests never touch the real filesystem. */
export type PathExists = (path: string) => Promise<boolean>;

export interface DetectGimpOptions {
  /** Defaults to `os.platform()`. */
  platform?: string;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to `os.homedir()`. */
  homedir?: string;
  /** Defaults to a real `fs.stat`-based check. */
  exists?: PathExists;
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `PATH`/`Path` split for the platform being probed. Deliberately NOT
 * `node:path`'s `delimiter` — that reflects the *host* OS, but `platform` here
 * is injectable for tests running on a different host than the one being
 * simulated, so the delimiter must follow the simulated platform too.
 */
function splitPath(env: Record<string, string | undefined>, platform: string): string[] {
  const raw = env.PATH ?? env.Path ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  return raw.split(sep).filter((p) => p.length > 0);
}

async function firstExisting(
  candidates: readonly string[],
  exists: PathExists
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/**
 * `%LOCALAPPDATA%/Programs/GIMP 3/bin/` and `C:/Program Files/GIMP 3/bin/`,
 * unversioned + versioned exe names. Uses `path.win32`, not the bare `path`
 * module: candidates must come out backslash-joined even when this runs
 * under a test simulating `win32` on a POSIX host (`path`'s plain functions
 * follow the actual host OS, not the platform being simulated).
 */
async function detectWindows(
  env: Record<string, string | undefined>,
  exists: PathExists
): Promise<GimpInstall | null> {
  const localAppData = env.LOCALAPPDATA;
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const bases = [
    localAppData ? pathWin32.join(localAppData, 'Programs', 'GIMP 3', 'bin') : null,
    pathWin32.join(programFiles, 'GIMP 3', 'bin'),
  ].filter((b): b is string => b !== null);
  // Name-major, dir-minor, same rationale as detectLinux below: the
  // versioned name is the one this backend is actually verified against, so
  // it outranks an unversioned name even in a higher-priority base dir.
  const names = ['gimp-console-3.2.exe', 'gimp-console-3.exe'];

  const candidates = names.flatMap((name) => bases.map((base) => pathWin32.join(base, name)));
  const found = await firstExisting(candidates, exists);
  return found ? { source: 'conventional', path: found, launch: exeLaunchSpec(found) } : null;
}

/**
 * `/Applications/GIMP.app` and `~/Applications/GIMP.app`, console binary
 * inside `Contents/MacOS/`. Uses `path.posix` for the same cross-host-testing
 * reason `detectWindows` uses `path.win32`.
 */
async function detectMac(homedir: string, exists: PathExists): Promise<GimpInstall | null> {
  const bases = [
    '/Applications/GIMP.app/Contents/MacOS',
    pathPosix.join(homedir, 'Applications', 'GIMP.app', 'Contents', 'MacOS'),
  ];
  // Order matters: prefer the most specific (version-pinned) name first, so a
  // machine that happens to carry both an unversioned symlink and the real
  // versioned binary resolves to the one we actually verified against.
  const names = ['gimp-console-3.2', 'gimp-console-3', 'gimp-console'];

  const candidates = bases.flatMap((base) => names.map((name) => pathPosix.join(base, name)));
  const found = await firstExisting(candidates, exists);
  return found ? { source: 'conventional', path: found, launch: exeLaunchSpec(found) } : null;
}

/** `PATH` sweep for `gimp-console-3.2`/`gimp-console-3`/`gimp-console`, then Flatpak presence. */
async function detectLinux(
  env: Record<string, string | undefined>,
  homedir: string,
  exists: PathExists
): Promise<GimpInstall | null> {
  const dirs = splitPath(env, 'linux');
  // Name-major, dir-minor: a versioned name anywhere on PATH outranks an
  // unversioned one earlier on PATH, since the versioned binary is the one
  // this backend is actually verified against.
  const names = ['gimp-console-3.2', 'gimp-console-3', 'gimp-console'];
  for (const name of names) {
    const found = await firstExisting(
      dirs.map((dir) => pathPosix.join(dir, name)),
      exists
    );
    if (found) return { source: 'path', path: found, launch: exeLaunchSpec(found) };
  }

  const flatpakDirs = [
    '/var/lib/flatpak/app/org.gimp.GIMP',
    pathPosix.join(homedir, '.local/share/flatpak/app/org.gimp.GIMP'),
  ];
  const flatpakFound = await firstExisting(flatpakDirs, exists);
  return flatpakFound
    ? { source: 'flatpak', path: flatpakFound, launch: flatpakLaunchSpec() }
    : null;
}

/**
 * Resolve a GIMP install, or `null` if none was found. Order: an explicit
 * `EDITMAMEI_GIMP_PATH` override, then the OS-appropriate conventional
 * search. A literal `flatpak` override value means "launch via Flatpak" (the
 * Linux packaging where there is no single exe path to point at); anything
 * else is checked as a path. An override that resolves to nothing falls
 * through to the conventional search rather than failing outright — the same
 * recoverable posture `WindowsDetector`/`MacOSDetector` give `PHOTOSHOP_PATH`.
 */
export async function detectGimp(opts: DetectGimpOptions = {}): Promise<GimpInstall | null> {
  const platform = opts.platform ?? osPlatform();
  const env = opts.env ?? process.env;
  const homedir = opts.homedir ?? osHomedir();
  const exists = opts.exists ?? defaultExists;

  const override = env.EDITMAMEI_GIMP_PATH;
  if (override) {
    if (override === 'flatpak') {
      return { source: 'env', path: override, launch: flatpakLaunchSpec() };
    }
    if (await exists(override)) {
      return { source: 'env', path: override, launch: exeLaunchSpec(override) };
    }
  }

  if (platform === 'win32') return detectWindows(env, exists);
  if (platform === 'darwin') return detectMac(homedir, exists);
  if (platform === 'linux') return detectLinux(env, homedir, exists);
  return null;
}
