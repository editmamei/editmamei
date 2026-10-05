/**
 * The local-path rule every file path a tool takes goes through: Photoshop paths here
 * (`requireLocalPath`, `checkOutputPath`), GIMP paths in `gimp-path.ts`. A path reaches
 * Photoshop, GIMP or Node file APIs as-is, and on Windows those resolve a UNC or WebDAV path by
 * connecting to that host and authenticating as the user. So a path must name a file on this
 * machine's own drives.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { win32 as pathWin32, posix as pathPosix } from 'node:path';

// Two leading slashes/backslashes in any combination: a UNC share (`\\server\share\...`, which
// WebDAV paths like `\\host@SSL\...` also are) and the `\\?\` / `\\.\` device-path prefixes
// (`\\?\C:\...`, `\\?\UNC\...`, `\\.\PhysicalDrive0`).
const UNC_OR_DEVICE_PATH_RE = /^[\\/]{2}/;
// A Windows path rooted at a specific drive letter: `C:\...` or `C:/...`.
const WIN32_DRIVE_ROOTED_RE = /^[A-Za-z]:[\\/]/;
// `~/...` or `~\...`: the user's home directory, as ExtendScript's File reads it.
const HOME_RELATIVE_RE = /^~[\\/]/;

/**
 * Why `value` isn't a plain local absolute path, or undefined when it is. In order:
 *  - `not_string`: not a non-empty string.
 *  - `unc_or_device`: a UNC share or `\\?\` / `\\.\` device path. `path.isAbsolute` accepts
 *    these, but none names a file on this machine's own drives.
 *  - `relative`: not absolute.
 *  - `no_drive`: on win32, rooted at `\` with no drive letter, which resolves against whichever
 *    drive is current (and covers NT-namespace forms like `\??\UNC\...`).
 *  - `unstable`: `resolve()` lands under a different root than the one written.
 *
 * `platform` picks the path semantics (`path.win32` for 'win32', `path.posix` otherwise), never
 * the host's implicitly: a path is data about a target machine, and a test of Windows paths
 * must get the same answer on a macOS runner.
 */
export type LocalPathProblem =
  'not_string' | 'unc_or_device' | 'relative' | 'no_drive' | 'unstable';

export function localPathProblem(
  value: unknown,
  platform: string = process.platform
): LocalPathProblem | undefined {
  const pathImpl = platform === 'win32' ? pathWin32 : pathPosix;
  if (typeof value !== 'string' || value.length === 0) return 'not_string';
  if (UNC_OR_DEVICE_PATH_RE.test(value)) return 'unc_or_device';
  if (!pathImpl.isAbsolute(value)) return 'relative';
  if (platform === 'win32' && !WIN32_DRIVE_ROOTED_RE.test(value)) return 'no_drive';
  // Slash direction alone must never trip this: `resolve` normalizes to the platform's native
  // separator, so `C:/photos/dog.jpg` legitimately resolves to a `C:\` root.
  const normalizeRoot = (root: string) => root.replace(/\//g, '\\').toLowerCase();
  const resolved = pathImpl.resolve(value);
  if (normalizeRoot(pathImpl.parse(resolved).root) !== normalizeRoot(pathImpl.parse(value).root))
    return 'unstable';
  return undefined;
}

/** A tool argument naming a file path that this machine refuses to use. */
export class PathArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathArgumentError';
  }
}

/** Tests only: the platform whose path rules apply when a call names none (see setPathPlatformForTests). */
let platformOverride: string | undefined;

/**
 * Tests only: apply `platform`'s path rules by default (undefined: the host's again), so a test
 * written with Windows paths gets the same answer on a macOS runner.
 */
export function setPathPlatformForTests(platform: string | undefined): void {
  platformOverride = platform;
}

export interface LocalPathOptions {
  platform?: string;
  /** The home directory a leading `~` stands for. */
  home?: string;
}

/**
 * A Photoshop tool's file-path argument, checked: returned as the path to hand on (a leading
 * `~/` expanded to the home directory), or a PathArgumentError naming `field`.
 */
export function requireLocalPath(
  field: string,
  value: unknown,
  opts: LocalPathOptions = {}
): string {
  const platform = opts.platform ?? platformOverride ?? process.platform;
  const path =
    typeof value === 'string' && HOME_RELATIVE_RE.test(value)
      ? (platform === 'win32' ? pathWin32 : pathPosix).join(opts.home ?? homedir(), value.slice(2))
      : value;
  switch (localPathProblem(path, platform)) {
    case undefined:
      return path as string;
    case 'not_string':
      throw new PathArgumentError(`"${field}" is required and must be a non-empty string.`);
    case 'unc_or_device':
      throw new PathArgumentError(
        `"${field}" must be a file on this computer's own drives: network shares (\\\\server\\share), ` +
          `WebDAV addresses and \\\\?\\ or \\\\.\\ device paths are refused, got "${String(value)}". ` +
          'Copy the file to a local folder first.'
      );
    case 'relative':
      throw new PathArgumentError(
        `"${field}" must be an absolute path, got "${String(value)}". Pass a full path, e.g. ` +
          `${platform === 'win32' ? 'C:/Users/you/Pictures/photo.jpg' : '/Users/you/Pictures/photo.jpg'}.`
      );
    case 'no_drive':
      throw new PathArgumentError(
        `"${field}" must start with a drive letter, got "${String(value)}". Pass e.g. C:/Users/you/Pictures/photo.jpg.`
      );
    case 'unstable':
      throw new PathArgumentError(
        `"${field}" does not resolve to a stable absolute path ("${String(value)}"). Pass a plain, full path.`
      );
  }
}

/** Whether a name-or-path argument (e.g. a LUT preset name) is written as a path. */
export function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || HOME_RELATIVE_RE.test(value);
}

/**
 * Files this server process has written through checkOutputPath, keyed case-insensitively on
 * Windows and macOS (their default filesystems are), so a later save may replace them.
 */
const written = new Set<string>();

function outputKey(path: string, platform: string): string {
  const resolved = (platform === 'win32' ? pathWin32 : pathPosix).resolve(path);
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

export interface OutputPathOptions extends LocalPathOptions {
  /** Accepted extensions, lower case with the dot (e.g. ['.jpg', '.jpeg']). */
  extensions: readonly string[];
  /** The caller said to replace an existing file. */
  overwrite?: boolean;
  /** Whether a file exists at a path; defaults to the filesystem. */
  exists?: (path: string) => boolean;
}

/**
 * A save or export path, checked: a local path (requireLocalPath) ending in one of `extensions`,
 * and not an existing file unless this process wrote it or `overwrite` is set. A model can be
 * steered by text in an image or a page it read; this keeps a save from replacing a user's
 * original, or writing anything that isn't an image, unless asked to. Call recordOutputPath
 * once the write has succeeded.
 */
export function checkOutputPath(field: string, value: unknown, opts: OutputPathOptions): string {
  const platform = opts.platform ?? platformOverride ?? process.platform;
  const path = requireLocalPath(field, value, opts);
  const lower = path.toLowerCase();
  if (!opts.extensions.some((ext) => lower.endsWith(ext))) {
    throw new PathArgumentError(
      `"${field}" must end in ${opts.extensions.join(' or ')}, got "${path}".`
    );
  }
  const exists = opts.exists ?? existsSync;
  if (opts.overwrite !== true && exists(path) && !written.has(outputKey(path, platform))) {
    throw new PathArgumentError(
      `"${field}": a file already exists at "${path}" and was not written in this session. Choose a new ` +
        'name, or pass overwrite: true only if the user asked to replace that file.'
    );
  }
  return path;
}

/** Note a file this process wrote, so a later save to the same path may replace it. */
export function recordOutputPath(
  path: string,
  platform: string = platformOverride ?? process.platform
): void {
  written.add(outputKey(path, platform));
}

/** Tests only: forget every recorded output. */
export function resetOutputPathsForTests(): void {
  written.clear();
}
