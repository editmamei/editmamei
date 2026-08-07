import { execFile } from 'child_process';
import { promisify } from 'util';
import { access, constants, readFile } from 'fs/promises';
import { Logger } from '../utils/logger.js';
import type { PhotoshopInfo } from './ports.js';

/**
 * Every subprocess here goes through `execFile` with an argument array, never a
 * composed shell command.
 *
 * The paths this file handles come from Spotlight results and from splitting
 * those results apart, so they are influenced by anything that can place a
 * bundle where Spotlight will index it. macOS filenames may legally contain
 * quotes, backticks and `$()`; interpolated into a shell string those become
 * injection points. `execFile` never involves a shell, so argv is passed
 * through as data. The threat model is local-only — planting an indexed bundle
 * already implies running as the user — but the discipline is uniform here so
 * no future edit has to rediscover which call sites were safe.
 */
const execFileAsync = promisify(execFile);

/**
 * Derive the application's display name — how AppleScript addresses it — from
 * a bundle path.
 *
 * Trailing slashes are stripped first. A user-supplied `PHOTOSHOP_PATH` may
 * legitimately end in one, and without this the last path segment is empty and
 * the name comes back undefined, which leaves the macOS runner with nothing to
 * address for the rest of the process.
 */
export function bundleDisplayName(bundlePath: string): string | undefined {
  const leaf = bundlePath.replace(/\/+$/, '').split('/').pop();
  if (!leaf) return undefined;
  return leaf.endsWith('.app') ? leaf.slice(0, -'.app'.length) : leaf;
}

/**
 * Locates the Photoshop install on macOS.
 *
 * Three strategies, most authoritative first: an explicit override from the
 * environment, then Spotlight (which knows about installs anywhere on the
 * volume, not just `/Applications`), then a sweep of the conventional bundle
 * paths for machines where the Spotlight index is disabled or stale.
 */
export class MacOSDetector {
  private readonly logger = new Logger('MacOSDetector');

  async detect(): Promise<PhotoshopInfo> {
    this.logger.info('Looking for a Photoshop install on macOS');

    const override = process.env.PHOTOSHOP_PATH;
    if (override) {
      this.logger.debug('Trying PHOTOSHOP_PATH override', override);
      const info = await this.inspectBundle(override);
      if (info) return info;
    }

    try {
      const fromSpotlight = await this.findViaSpotlight();
      if (fromSpotlight) return fromSpotlight;
    } catch (error) {
      // Not fatal — the path sweep below covers a disabled or stale index.
      this.logger.warn('Spotlight lookup did not resolve an install', error);
    }

    for (const path of this.conventionalPaths()) {
      const info = await this.inspectBundle(path);
      if (info) return info;
    }

    throw new Error('No Photoshop install could be found on this machine');
  }

  /**
   * Ask Spotlight for anything registering Photoshop's bundle identifier.
   *
   * Results are sorted descending so that the newest release wins when several
   * are installed side by side — the same preference the conventional-path
   * ordering encodes.
   */
  private async findViaSpotlight(): Promise<PhotoshopInfo | null> {
    try {
      const { stdout } = await execFileAsync('mdfind', [
        'kMDItemCFBundleIdentifier == com.adobe.Photoshop',
      ]);

      const bundles = stdout
        .split('\n')
        .filter((line) => line.trim() && line.endsWith('.app'))
        .sort((a, b) => b.localeCompare(a));

      for (const bundlePath of bundles) {
        const info = await this.inspectBundle(bundlePath);
        if (info) return info;
      }
    } catch (error) {
      this.logger.debug('Spotlight query failed', error);
    }

    return null;
  }

  /**
   * Build the list of bundle paths Adobe conventionally installs into.
   *
   * As on Windows, the upper bound tracks the clock because Adobe brands
   * releases a year ahead, and it is floored at a known-good year so a machine
   * with a wrong clock cannot collapse the range to nothing.
   */
  private conventionalPaths(): string[] {
    const paths: string[] = [];
    const newestYear = Math.max(new Date().getFullYear() + 1, 2026);

    for (let year = newestYear; year >= 2012; year--) {
      paths.push(
        `/Applications/Adobe Photoshop ${year}/Adobe Photoshop ${year}.app`,
        `/Applications/Adobe Photoshop CC ${year}/Adobe Photoshop CC ${year}.app`,
        `/Applications/Adobe Photoshop ${year}.app`
      );
    }

    // Installs from before Adobe put the year in the bundle name.
    paths.push(
      '/Applications/Adobe Photoshop CC/Adobe Photoshop CC.app',
      '/Applications/Adobe Photoshop/Adobe Photoshop.app',
      '/Applications/Adobe Photoshop.app'
    );

    return paths;
  }

  /** Resolve one candidate bundle into an install record, or null if it is not one. */
  private async inspectBundle(path: string): Promise<PhotoshopInfo | null> {
    try {
      const cleanPath = path.trim();
      await access(cleanPath, constants.F_OK);

      const version = await this.readBundleVersion(cleanPath);
      // The bundle's folder name is how AppleScript addresses the application.
      // Left undefined when it cannot be derived rather than guessed at: the
      // runner reports a missing name clearly, where a wrong one produces an
      // opaque "application isn't running" from AppleScript instead.
      const appName = bundleDisplayName(cleanPath);

      this.logger.info('Using Photoshop at', cleanPath);

      return { version, path: cleanPath, appName };
    } catch {
      return null;
    }
  }

  /**
   * Read the release version out of a bundle's `Info.plist`.
   *
   * `PlistBuddy` first because it understands binary plists, which Adobe ships.
   * If it is unavailable, fall back to reading the file as text — that only
   * works for the XML form, hence the ordering. Failing both, the release year
   * in the path is better than nothing.
   */
  private async readBundleVersion(bundlePath: string): Promise<string> {
    try {
      const plistPath = `${bundlePath}/Contents/Info.plist`;

      try {
        await access(plistPath, constants.F_OK);
        const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', [
          '-c',
          'Print :CFBundleShortVersionString',
          plistPath,
        ]);
        if (stdout.trim()) return stdout.trim();
      } catch {
        const content = await readFile(plistPath, 'utf8');
        const versionMatch = content.match(
          /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
        );
        if (versionMatch) return versionMatch[1];
      }

      const yearMatch = bundlePath.match(/(\d{4})/);
      if (yearMatch) return yearMatch[1];
    } catch (err) {
      this.logger.debug('Could not read a version from the bundle', err);
    }

    return 'Unknown';
  }
}
