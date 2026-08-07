import { exec } from 'child_process';
import { promisify } from 'util';
import { access, constants } from 'fs/promises';
import { Logger } from '../utils/logger.js';
import type { PhotoshopInfo } from './ports.js';

const execAsync = promisify(exec);

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
   * Two sources: Adobe's own product keys, and the COM class registration that
   * Photoshop publishes so it can be scripted at all. The second is worth
   * consulting because it is the very registration this server depends on — if
   * it is present, Photoshop can be driven; if it is missing, an install found
   * any other way would not have worked anyway.
   */
  private async findViaRegistry(): Promise<PhotoshopInfo | null> {
    try {
      const productKeys = [
        'HKLM\\SOFTWARE\\Adobe\\Photoshop',
        'HKLM\\SOFTWARE\\WOW6432Node\\Adobe\\Photoshop',
      ];

      for (const key of productKeys) {
        try {
          const { stdout } = await execAsync(`reg query "${key}" /s`);
          const entries = this.readRegistryEntries(stdout);
          if (entries.length > 0) {
            const newest = entries.sort((a, b) => b.version.localeCompare(a.version))[0];
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
          const { stdout } = await execAsync(`reg query "${key}" /ve`);
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
