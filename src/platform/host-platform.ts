/**
 * Resolves which operating system we are on and hands back everything the rest
 * of the server needs from it.
 *
 * The `win32` / `darwin` / otherwise-throw decision used to be written out in
 * three places — the connection's constructor, the detector's constructor, and
 * the detector's `detect()` — which meant adding a platform, or changing how an
 * unsupported one fails, was a three-site edit with no compiler help if you
 * missed one. It lives here now, once.
 */

import { platform } from 'os';
import { MacOSDetector } from './macos-detector.js';
import { MacOSScriptRunner } from './macos-runner.js';
import type { PhotoshopInfo, PlatformAdapter } from './ports.js';
import { WindowsDetector } from './windows-detector.js';
import { WindowsScriptRunner } from './windows-runner.js';

/** The operating systems Adobe ships Photoshop on. */
export type SupportedPlatform = 'win32' | 'darwin';

/**
 * Locates the Photoshop install, however this platform goes about it.
 *
 * Resolving to null means "looked, found nothing" — distinct from rejecting,
 * which means the search itself failed. Both real detectors reject today, but
 * the connection handles a null result and callers should not have to assume
 * which of the two a future detector picks.
 */
export interface InstallDetector {
  detect(): Promise<PhotoshopInfo | null>;
}

/** The host, resolved. */
export interface HostPlatform {
  readonly os: SupportedPlatform;
  /** Runs scripts and manages the Photoshop process. */
  readonly adapter: PlatformAdapter;
  /** Finds the install to run them against. */
  readonly detector: InstallDetector;
}

/**
 * Resolve the host platform, or throw if Photoshop cannot exist here.
 *
 * Throwing is the intended behaviour on an unsupported OS, and it is why
 * `Session` builds its connection lazily: CLI subcommands that never touch
 * Photoshop (`editmamei install`, `editmamei status`) must stay usable
 * anywhere, so the throw has to land when something actually tries to drive
 * Photoshop rather than at process start.
 */
export function resolveHostPlatform(): HostPlatform {
  const os = platform();

  if (os === 'win32') {
    return { os, adapter: new WindowsScriptRunner(), detector: new WindowsDetector() };
  }

  if (os === 'darwin') {
    return { os, adapter: new MacOSScriptRunner(), detector: new MacOSDetector() };
  }

  throw new Error(
    `Editmamei runs on Windows and macOS; this process is on "${os}". ` +
      'Adobe ships no Linux build of Photoshop, so there is nothing here to drive.'
  );
}
