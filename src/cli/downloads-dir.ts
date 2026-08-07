/**
 * Cross-platform Downloads folder detection.
 *
 * The Editmamei skill bundle is copied here after `editmamei install`
 * so the user can hand-upload it to claude.ai > Settings > Customize >
 * Skills. Downloads is the conventional landing zone every OS user
 * already knows how to find — picking a less obvious location would
 * just be friction.
 *
 * Resolution order:
 *   1. `$XDG_DOWNLOAD_DIR` if set and the directory exists (POSIX
 *      override mechanism — Linux desktop environments use this to
 *      relocate Downloads).
 *   2. `<homedir>/Downloads` on every OS. Standard on Windows, macOS,
 *      and most Linux distros.
 *   3. Home directory as last resort. Better than failing; the install
 *      output tells the user where the file landed.
 *
 * Returns the chosen directory + a `kind` discriminator so callers can
 * report which path was used (helpful for support when a user can't
 * find the file).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DownloadsResolution = 'xdg' | 'home-downloads' | 'home-fallback';

export interface DownloadsDir {
  path: string;
  kind: DownloadsResolution;
}

export function detectDownloadsDir(env: typeof process.env = process.env): DownloadsDir {
  const xdg = env.XDG_DOWNLOAD_DIR;
  if (xdg && existsSync(xdg)) {
    return { path: xdg, kind: 'xdg' };
  }

  const home = homedir();
  const homeDownloads = join(home, 'Downloads');
  if (existsSync(homeDownloads)) {
    return { path: homeDownloads, kind: 'home-downloads' };
  }

  // Final fallback. Writing to $HOME always succeeds where any other
  // path is writable, and a file on the desktop side of the home dir
  // is still discoverable.
  return { path: home, kind: 'home-fallback' };
}
