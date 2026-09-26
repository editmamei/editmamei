/**
 * The one absolute-path rule every `gimp_*` path goes through (tool arguments, and the
 * `gimp_path` setting at load). Its own module, dependency-light, so `core/settings.ts` can use
 * it without importing the tool layer.
 */

import { win32 as pathWin32, posix as pathPosix } from 'node:path';
import { GimpError } from '../backends/gimp/errors.js';

// Two leading slashes/backslashes in any combination — covers a UNC share
// (`\\server\share\...`), and the `\\?\` / `\\.\` device-path prefixes
// (`\\?\C:\...`, `\\?\UNC\...`, `\\.\PhysicalDrive0`). None of these name an
// ordinary local file the way the bridge's plain `open()`/`os.path.exists()`
// calls expect, and several (`\\.\...`) can address a device rather than a
// file at all.
const UNC_OR_DEVICE_PATH_RE = /^[\\/]{2}/;
// A Windows path rooted at a specific drive letter: `C:\...` or `C:/...`.
const WIN32_DRIVE_ROOTED_RE = /^[A-Za-z]:[\\/]/;

/**
 * Every `file_path` / region-export / mask path a `gimp_*` tool accepts is
 * validated HERE, in the tool layer — the bridge (`bridge/ops.py`) trusts
 * whatever path it's given, so nothing but a plain, unambiguous local path
 * must ever reach it. Throws `GimpError('invalid_argument', …)` naming the
 * field; every gimp_* handler's catch tail (`toolGimpErrorResult`) turns
 * that into the same error shape a bridge-side `invalid_argument` would
 * produce, so the caller can't tell "rejected before dispatch" from
 * "rejected by GIMP" from the text alone.
 *
 * `platform` picks WHICH path semantics validate against — `path.win32` for
 * `'win32'`, `path.posix` for everything else — never the host process's own
 * platform implicitly. A GIMP install path or a caller-supplied file path is
 * data describing a target machine's filesystem, not the CI runner's; a test
 * asserting Windows-path behavior must pass `platform: 'win32'` explicitly
 * and get the same answer on a macOS runner as on a Windows one.
 *
 * Refuses, in order:
 *  1. Anything not a non-empty string.
 *  2. UNC shares and `\\?\` / `\\.\` device-path prefixes — `path.isAbsolute`
 *     happily accepts these as "absolute", but the bridge has no reason to
 *     ever reach a network share or a raw device.
 *  3. A genuinely relative path (`isAbsolute` says no).
 *  4. On win32 only: an absolute path with NO drive letter (e.g. `\x.jpg`)
 *     — `path.win32.isAbsolute` treats a bare leading slash as absolute
 *     (root of "the current drive"), which is exactly the ambiguity this
 *     tool layer can't afford: "current drive" according to WHICH process,
 *     at WHICH moment, is not a question a headless GIMP session's caller
 *     should ever have to reason about.
 *  5. A path whose `resolve()`-normalized form lands under a DIFFERENT root
 *     than the one it was written with — the final sanity check that "what
 *     the caller wrote" and "where it actually resolves" agree.
 */
export function requireAbsoluteGimpPath(
  field: string,
  value: unknown,
  platform: string = process.platform
): string {
  const pathImpl = platform === 'win32' ? pathWin32 : pathPosix;
  if (typeof value !== 'string' || value.length === 0) {
    throw new GimpError(
      'invalid_argument',
      `"${field}" is required and must be a non-empty string`
    );
  }
  if (UNC_OR_DEVICE_PATH_RE.test(value)) {
    throw new GimpError(
      'invalid_argument',
      `"${field}" must be a plain local path — UNC shares and \\\\?\\ / \\\\.\\ device paths are ` +
        `refused, got "${value}". Pass a path on a local drive, e.g. C:/Users/you/photo.jpg.`
    );
  }
  if (!pathImpl.isAbsolute(value)) {
    throw new GimpError(
      'invalid_argument',
      `"${field}" must be an absolute path, got "${value}" — pass a full filesystem path, not one relative to a working directory the GIMP session doesn't share.`
    );
  }
  if (platform === 'win32' && !WIN32_DRIVE_ROOTED_RE.test(value)) {
    throw new GimpError(
      'invalid_argument',
      `"${field}" must include a drive letter, got "${value}" — a path rooted at "\\" alone is ` +
        `ambiguous about which drive it resolves on. Pass e.g. C:/Users/you/photo.jpg.`
    );
  }
  // Slash direction alone must never trip this — `resolve` always
  // normalizes to that platform's native separator, so an input written with
  // forward slashes (`C:/photos/dog.jpg`, encouraged elsewhere in these
  // tools' own schema examples) legitimately resolves to a backslash root
  // (`C:\`) without anything actually being ambiguous.
  const normalizeRoot = (root: string) => root.replace(/\//g, '\\').toLowerCase();
  const resolved = pathImpl.resolve(value);
  if (normalizeRoot(pathImpl.parse(resolved).root) !== normalizeRoot(pathImpl.parse(value).root)) {
    throw new GimpError(
      'invalid_argument',
      `"${field}" does not resolve to a stable absolute path ("${value}" -> "${resolved}") — pass a plain, fully-qualified path.`
    );
  }
  return value;
}
