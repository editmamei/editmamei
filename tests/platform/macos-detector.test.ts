import { describe, it, expect, afterEach, vi } from 'vitest';
import { MacOSDetector, bundleDisplayName } from '@editmamei/platform/macos-detector.ts';

/**
 * The application name this derives is how AppleScript addresses Photoshop, and
 * the macOS runner has no fallback if it comes back undefined — every script
 * then refuses to compose. That makes these cases load-bearing rather than
 * cosmetic.
 */
describe('bundleDisplayName', () => {
  it('strips the .app suffix from an ordinary bundle path', () => {
    expect(bundleDisplayName('/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app')).toBe(
      'Adobe Photoshop 2026'
    );
  });

  it('tolerates a trailing slash', () => {
    // A user-supplied PHOTOSHOP_PATH may legitimately end in one. Without the
    // strip, the last path segment is empty and the name comes back undefined,
    // leaving the runner with nothing to address for the rest of the process.
    expect(bundleDisplayName('/Applications/Adobe Photoshop 2026.app/')).toBe(
      'Adobe Photoshop 2026'
    );
    expect(bundleDisplayName('/Applications/Adobe Photoshop 2026.app///')).toBe(
      'Adobe Photoshop 2026'
    );
  });

  it('returns the leaf unchanged when there is no .app suffix', () => {
    expect(bundleDisplayName('/Applications/Photoshop')).toBe('Photoshop');
  });

  it('only strips a trailing .app, not one appearing earlier in the name', () => {
    expect(bundleDisplayName('/Applications/My.app.Thing.app')).toBe('My.app.Thing');
  });

  it('returns undefined when no leaf can be derived', () => {
    expect(bundleDisplayName('/')).toBeUndefined();
    expect(bundleDisplayName('')).toBeUndefined();
  });
});

/**
 * MacOSDetector.conventionalPaths() is a pure candidate-list builder (no
 * Spotlight/PlistBuddy/subprocess calls). We poke at it through the `as any`
 * escape hatch, mirroring tests/platform/windows-detector.test.ts.
 */
type PrivateDetector = {
  conventionalPaths(): string[];
};

function asPrivate(d: MacOSDetector): PrivateDetector {
  return d as unknown as PrivateDetector;
}

describe('MacOSDetector — pure parsing logic', () => {
  it('conventionalPaths produces a non-empty list of candidate Photoshop.app locations', () => {
    const detector = asPrivate(new MacOSDetector());
    const paths = detector.conventionalPaths();
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.every((p) => p.endsWith('.app'))).toBe(true);
    expect(paths.some((p) => p.includes('2012'))).toBe(true);
  });

  describe('conventionalPaths — clock-derived upper year bound', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('generates currentYear + 1 as the newest candidate (Adobe ships year+1 branding in the fall)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2030-03-01T00:00:00Z'));

      const detector = asPrivate(new MacOSDetector());
      const paths = detector.conventionalPaths();

      expect(paths.some((p) => p.includes('2031'))).toBe(true);
      expect(paths.some((p) => p.includes('2032'))).toBe(false);
      // floor is unchanged
      expect(paths.some((p) => p.includes('2012'))).toBe(true);
      expect(paths.some((p) => p.includes('2011'))).toBe(false);
    });

    // C8/Q9 — a wrong/reset system clock must never be able to sink the
    // upper bound below the known-good Photoshop version range.
    // Math.max(currentYear+1, 2026) clamps it.
    it('clamps the upper bound to at least 2026 when the system clock reads a year far in the past', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2005-06-01T00:00:00Z'));

      const detector = asPrivate(new MacOSDetector());
      const paths = detector.conventionalPaths();

      expect(paths.some((p) => p.includes('2026'))).toBe(true);
      expect(paths.some((p) => p.includes('2012'))).toBe(true);
      expect(paths.some((p) => p.includes('2027'))).toBe(false);
      expect(paths.some((p) => p.includes('2006'))).toBe(false);
    });
  });
});
