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
  /**
   * The Node platform string — the real OS name, even where Photoshop cannot
   * exist. Narrowed to `SupportedPlatform` only on the two real branches.
   */
  readonly os: string;
  /** Runs scripts and manages the Photoshop process. */
  readonly adapter: PlatformAdapter;
  /** Finds the install to run them against. */
  readonly detector: InstallDetector;
}

/** The one sentence every refused call on an unsupported OS carries. */
function noPhotoshopHere(os: string): string {
  return (
    `Editmamei runs on Windows and macOS; this process is on "${os}". ` +
    'Adobe ships no Linux build of Photoshop, so there is nothing here to drive.'
  );
}

/**
 * A host where Photoshop cannot exist. Resolution still succeeds — the server
 * boots, completes the MCP handshake, and lists its tools — but every attempt
 * to actually drive Photoshop refuses with the reason. MCP directory scanners
 * run exactly this path in Linux sandboxes: the listing needs the handshake
 * and the tool inventory, never a real edit. (This used to throw at
 * construction instead, which killed the process before the handshake and
 * before the boot telemetry that makes such runs visible.)
 */
function unsupportedHost(os: string): HostPlatform {
  const refuse = (): never => {
    throw new Error(noPhotoshopHere(os));
  };
  return {
    os,
    adapter: {
      run: async () => refuse(),
      isRunning: async () => refuse(),
      launch: async () => refuse(),
    },
    detector: { detect: async () => refuse() },
  };
}

/**
 * Resolve the host platform — eagerly, exactly once, on every OS.
 *
 * The two real branches hand back the platform's runner and detector. Every
 * other OS resolves to `unsupportedHost` rather than throwing: CLI subcommands
 * that never touch Photoshop (`editmamei install`, `editmamei status`) and the
 * MCP handshake itself must work anywhere, so the refusal lands on the call
 * that genuinely needs Photoshop, with the OS named in the message.
 */
export function resolveHostPlatform(): HostPlatform {
  const os = platform();

  if (os === 'win32') {
    return { os, adapter: new WindowsScriptRunner(), detector: new WindowsDetector() };
  }

  if (os === 'darwin') {
    return { os, adapter: new MacOSScriptRunner(), detector: new MacOSDetector() };
  }

  return unsupportedHost(os);
}
