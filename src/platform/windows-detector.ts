import { execFile } from 'child_process';
import { promisify } from 'util';
import { access, constants } from 'fs/promises';
import { win32 } from 'path';
import { Logger } from '../utils/logger.js';
import type { PhotoshopInfo } from './ports.js';
import { windowsSystemTool } from './windows-system-tool.js';

const execFileAsync = promisify(execFile);

/** Cap on each registry query made while resolving the COM ProgID. */
const REG_QUERY_TIMEOUT_MS = 5_000;

interface RegistryEntry {
  version: string;
  path: string;
}

/**
 * Locates the Photoshop install on Windows.
 *
 * Three strategies, cheapest and most authoritative first: an explicit override
 * from the environment, then what Adobe's installer recorded in the registry,
 * then a sweep of the paths Adobe conventionally installs into. The sweep is
 * the fallback for installs whose registry entries are missing or damaged,
 * which happens often enough to be worth the probes.
 */
export class WindowsDetector {
  private readonly logger = new Logger('WindowsDetector');

  async detect(): Promise<PhotoshopInfo> {
    this.logger.info('Looking for a Photoshop install on Windows');

    const install = await this.findInstall();
    const comProgId = await this.resolveComProgId(install.path);
    if (comProgId) {
      this.logger.info('Addressing Photoshop over COM as', comProgId);
      return { ...install, comProgId };
    }

    this.logger.warn(
      'No versioned COM registration points at this install; falling back to Photoshop.Application',
      install.path
    );
    return install;
  }

  private async findInstall(): Promise<PhotoshopInfo> {
    const override = process.env.PHOTOSHOP_PATH;
    if (override) {
      this.logger.debug('Trying PHOTOSHOP_PATH override', override);
      const info = await this.inspectPath(override);
      if (info) return info;
    }

    try {
      const fromRegistry = await this.findViaRegistry();
      if (fromRegistry) return fromRegistry;
    } catch (error) {
      // Not fatal — the path sweep below is the whole reason this is recoverable.
      this.logger.warn('Registry lookup did not resolve an install', error);
    }

    const fromConventionalPaths = await this.probeCandidates(this.conventionalPaths());
    if (fromConventionalPaths) return fromConventionalPaths;

    throw new Error('No Photoshop install could be found on this machine');
  }

  /**
   * Ask the registry where Photoshop lives.
   *
   * Two sources: Adobe's own product keys, and a COM class registration that
   * Photoshop publishes so it can be scripted. Which ProgID scripts then attach
   * through is resolved separately, against the install chosen here (see
   * `resolveComProgId`).
   */
  private async findViaRegistry(): Promise<PhotoshopInfo | null> {
    try {
      const productKeys = [
        'HKLM\\SOFTWARE\\Adobe\\Photoshop',
        'HKLM\\SOFTWARE\\WOW6432Node\\Adobe\\Photoshop',
      ];

      for (const key of productKeys) {
        try {
          const { stdout } = await execFileAsync(
            windowsSystemTool('reg.exe'),
            ['query', key, '/s'],
            { windowsHide: true }
          );
          const entries = this.readRegistryEntries(stdout);
          if (entries.length > 0) {
            // Numeric, not lexical: as strings, `90.0` would sort above `210.0`.
            const newest = entries.sort((a, b) => parseFloat(b.version) - parseFloat(a.version))[0];
            const info = await this.inspectPath(newest.path);
            if (info) return info;
          }
        } catch {
          // This key is absent on this machine; try the next.
          continue;
        }
      }

      const comRegistrations = [
        'HKCR\\CLSID\\{06870682-6f3c-4b97-9143-f03e85c0bd3e}\\LocalServer32',
        'HKCR\\Wow6432Node\\CLSID\\{06870682-6f3c-4b97-9143-f03e85c0bd3e}\\LocalServer32',
      ];

      for (const key of comRegistrations) {
        try {
          const { stdout } = await execFileAsync(
            windowsSystemTool('reg.exe'),
            ['query', key, '/ve'],
            { windowsHide: true }
          );
          const exePath = this.readComServerPath(stdout);
          if (exePath) {
            const info = await this.inspectPath(exePath);
            if (info) return info;
          }
        } catch {
          continue;
        }
      }
    } catch (err) {
      this.logger.error('Registry query failed outright', err);
    }

    return null;
  }

  /** Pull `version → install path` pairs out of `reg query /s` output. */
  private readRegistryEntries(output: string): RegistryEntry[] {
    const entries: RegistryEntry[] = [];
    let currentVersion = '';

    for (const line of output.split('\n')) {
      const versionMatch = line.match(/Photoshop\\(\d+\.\d+)/);
      if (versionMatch) {
        currentVersion = versionMatch[1];
      }

      const pathMatch = line.match(/ApplicationPath\s+REG_SZ\s+(.+)/);
      if (pathMatch && currentVersion) {
        entries.push({ version: currentVersion, path: pathMatch[1].trim() });
      }
    }

    return entries;
  }

  /**
   * Extract the executable path from a COM `LocalServer32` registration.
   *
   * The value appears in four shapes in the wild — quoted or not, with or
   * without trailing launch arguments:
   *
   *     C:\Path\Photoshop.exe
   *     "C:\Path\Photoshop.exe"
   *     "C:\Path\Photoshop.exe" /background
   *     C:\Path\Photoshop.exe /background
   *
   * A lazy capture with the quote anchors kept *outside* the group handles all
   * four. A greedy one does not: it stops at `.exe` having already consumed the
   * closing quote, so a subsequent strip-the-quotes pass finds an unbalanced
   * leading quote and leaves it in place.
   */
  private readComServerPath(output: string): string | null {
    const match = output.match(/REG_SZ\s+"?(.+?\.exe)"?/i);
    if (!match) return null;
    return match[1].trim();
  }

  /**
   * Find the versioned COM ProgID whose server is this install's executable.
   *
   * Each release registers `Photoshop.Application.<N>` (`.200` for 2026, `.210`
   * for 2027) pointing at its own executable. The unversioned
   * `Photoshop.Application` follows whichever release registered last, so an
   * update to an older release installed alongside a newer one takes it back
   * and scripts reach the wrong application. Matching on the executable rather
   * than guessing from a version number also covers a `PHOTOSHOP_PATH`
   * override and installs found by the path sweep.
   *
   * Returns null when nothing matches; the runner then uses the unversioned
   * ProgID, which is what every install had before this lookup existed.
   */
  private async resolveComProgId(exePath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        windowsSystemTool('reg.exe'),
        ['query', 'HKCR', '/f', 'Photoshop.Application.', '/k'],
        { windowsHide: true, timeout: REG_QUERY_TIMEOUT_MS }
      );
      const target = this.normalizePath(exePath);
      for (const progId of this.readVersionedProgIds(stdout)) {
        const server = await this.readProgIdServer(progId);
        if (server && this.normalizePath(server) === target) return progId;
      }
    } catch (error) {
      this.logger.debug('COM ProgID lookup failed', error);
    }
    return null;
  }

  /**
   * Pull the versioned ProgIDs out of `reg query HKCR /f ... /k` output, newest
   * first.
   *
   * Only the `Photoshop.Application.<N>` form is taken. Releases also register
   * `Photoshop.Application.<N>.1`, and on a machine with two releases those can
   * point at the other release's executable, so they are not trusted.
   */
  private readVersionedProgIds(output: string): string[] {
    const found: Array<{ progId: string; release: number }> = [];
    for (const line of output.split('\n')) {
      const match = line.trim().match(/^HKEY_CLASSES_ROOT\\(Photoshop\.Application\.(\d+))$/);
      if (match) found.push({ progId: match[1], release: Number(match[2]) });
    }
    return found.sort((a, b) => b.release - a.release).map((entry) => entry.progId);
  }

  /** Resolve a ProgID to the executable its COM class launches, or null. */
  private async readProgIdServer(progId: string): Promise<string | null> {
    try {
      const { stdout: clsidOutput } = await execFileAsync(
        windowsSystemTool('reg.exe'),
        ['query', `HKCR\\${progId}\\CLSID`, '/ve'],
        { windowsHide: true, timeout: REG_QUERY_TIMEOUT_MS }
      );
      const clsid = clsidOutput.match(/REG_SZ\s+(\{[0-9A-Fa-f-]+\})/)?.[1];
      if (!clsid) return null;

      const { stdout: serverOutput } = await execFileAsync(
        windowsSystemTool('reg.exe'),
        ['query', `HKCR\\CLSID\\${clsid}\\LocalServer32`, '/ve'],
        { windowsHide: true, timeout: REG_QUERY_TIMEOUT_MS }
      );
      return this.readComServerPath(serverOutput);
    } catch {
      return null;
    }
  }

  /** Windows paths compare case-insensitively and tolerate either separator. */
  private normalizePath(path: string): string {
    return win32.normalize(path.trim().replace(/^"|"$/g, '')).toLowerCase();
  }

  /**
   * Build the list of paths Adobe conventionally installs into.
   *
   * The upper bound tracks the clock because Adobe brands releases a year
   * ahead — Photoshop "2026" shipped during 2025 — so a hardcoded ceiling goes
   * stale every autumn. It is floored at a known-good year so that a machine
   * with a wrong clock (a dead CMOS battery, a VM booting at the epoch) cannot
   * collapse the ceiling down onto the 2012 floor and find nothing.
   */
  private conventionalPaths(): string[] {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    const paths: string[] = [];
    const newestYear = Math.max(new Date().getFullYear() + 1, 2026);

    for (let year = newestYear; year >= 2012; year--) {
      paths.push(
        `${programFiles}\\Adobe\\Adobe Photoshop ${year}\\Photoshop.exe`,
        `${programFilesX86}\\Adobe\\Adobe Photoshop ${year}\\Photoshop.exe`,
        `${programFiles}\\Adobe\\Adobe Photoshop CC ${year}\\Photoshop.exe`,
        `${programFilesX86}\\Adobe\\Adobe Photoshop CC ${year}\\Photoshop.exe`
      );
    }

    // Installs from before Adobe put the year in the folder name.
    paths.push(
      `${programFiles}\\Adobe\\Adobe Photoshop CC\\Photoshop.exe`,
      `${programFiles}\\Adobe\\Photoshop CC\\Photoshop.exe`
    );

    return paths;
  }

  /**
   * Probe a list of candidate paths at once and take the best hit.
   *
   * Each probe is a cheap existence check, so they run concurrently rather than
   * as a sequential chain of roughly sixty awaits. Priority still comes from
   * the candidate ordering — newest release first — not from whichever probe
   * happens to settle first.
   *
   * Takes the candidates rather than building them so that the probing and
   * selection rules can be exercised against a small, explicit list.
   */
  private async probeCandidates(candidates: string[]): Promise<PhotoshopInfo | null> {
    const results = await Promise.all(candidates.map((path) => this.inspectPath(path)));
    const selected = results.find((result): result is PhotoshopInfo => result !== null) ?? null;

    // Logged here rather than inside inspectPath: with several Photoshop
    // releases installed, every one of them resolves during the sweep above, so
    // logging at the probe would announce each of them as though it had been
    // chosen. Only the pick is worth an INFO line.
    if (selected) {
      this.logger.info('Using Photoshop at', selected.path);
    }

    return selected;
  }

  /** Resolve one candidate path into an install record, or null if it is not one. */
  private async inspectPath(path: string): Promise<PhotoshopInfo | null> {
    try {
      let cleanPath = path.trim().replace(/^"|"$/g, '');

      // Callers may hand us the install directory rather than the executable —
      // the registry's ApplicationPath value is exactly that, and it carries a
      // trailing separator. Strip it before appending, or the composed path
      // reads as ...\Adobe Photoshop 2026\\Photoshop.exe. Windows resolves that
      // anyway, but it is the path we then store on the install record and hand
      // to launch(), so it is worth having right.
      if (!cleanPath.toLowerCase().endsWith('.exe')) {
        cleanPath = `${cleanPath.replace(/[\\/]+$/, '')}\\Photoshop.exe`;
      }

      await access(cleanPath, constants.F_OK);
      this.logger.debug('Candidate install exists', cleanPath);

      return { version: this.readVersionFromPath(cleanPath), path: cleanPath };
    } catch {
      return null;
    }
  }

  /**
   * Read a version out of an install path.
   *
   * Windows offers no cheap way to read the real product version, so the path
   * is what we have: the release year if it is in there, a bare version number
   * otherwise.
   */
  private readVersionFromPath(path: string): string {
    const yearMatch = path.match(/(\d{4})/);
    if (yearMatch) return yearMatch[1];

    const versionMatch = path.match(/(\d+\.\d+)/);
    if (versionMatch) return versionMatch[1];

    return 'Unknown';
  }
}
