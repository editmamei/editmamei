import { describe, it, expect, afterEach, vi } from 'vitest';
import { WindowsDetector } from '@editmamei/platform/windows-detector.ts';
import type { PhotoshopInfo } from '@editmamei/platform/ports.ts';
import { Logger } from '@editmamei/utils/logger.ts';

// Fake the fs/promises access() seam so probeCandidates()/inspectPath() can be
// exercised without touching a real filesystem. Hoisted per Vitest's
// vi.mock() hoisting rules (the factory runs before this file's other
// top-level statements, so the mock fn must be created via vi.hoisted()).
const { accessMock, execMock } = vi.hoisted(() => ({
  accessMock: vi.fn(async (_path: string): Promise<void> => {
    throw new Error('ENOENT');
  }),
  execMock: vi.fn(
    (_cmd: string, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) =>
      cb(null, { stdout: '', stderr: '' })
  ),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, access: accessMock };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, exec: execMock };
});

/**
 * WindowsDetector has several pure parsers that don't need a real registry
 * or Photoshop binary. We poke at them through the `as any` escape hatch
 * because they're marked `private` for stylistic reasons, not for safety.
 */
type PrivateDetector = {
  readRegistryEntries(output: string): Array<{ version: string; path: string }>;
  readComServerPath(output: string): string | null;
  readVersionFromPath(path: string): string;
  conventionalPaths(): string[];
  probeCandidates(paths: string[]): Promise<PhotoshopInfo | null>;
  inspectPath(path: string): Promise<PhotoshopInfo | null>;
};

function asPrivate(d: WindowsDetector): PrivateDetector {
  return d as unknown as PrivateDetector;
}

describe('WindowsDetector — pure parsing logic', () => {
  it('readRegistryEntries pulls (version, path) tuples out of `reg query /s` output', () => {
    const sample = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Adobe\\Photoshop\\25.0',
      '    ApplicationPath    REG_SZ    C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\',
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Adobe\\Photoshop\\24.0',
      '    ApplicationPath    REG_SZ    C:\\Program Files\\Adobe\\Adobe Photoshop 2023\\',
    ].join('\n');

    const detector = asPrivate(new WindowsDetector());
    const entries = detector.readRegistryEntries(sample);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      version: '25.0',
      path: 'C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\',
    });
    expect(entries[1].version).toBe('24.0');
  });

  it('readRegistryEntries returns an empty list when nothing matches', () => {
    const detector = asPrivate(new WindowsDetector());
    expect(detector.readRegistryEntries('garbage')).toEqual([]);
  });

  it('readComServerPath pulls an unquoted .exe path out of REG_SZ output', () => {
    const sample =
      '(Default)    REG_SZ    C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe';
    const detector = asPrivate(new WindowsDetector());
    expect(detector.readComServerPath(sample)).toBe(
      'C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe'
    );
  });

  it('readComServerPath strips surrounding quotes around a quoted path with trailing args', () => {
    // 2026-06-07: the prior implementation used /^"(.+)".*$/ on a string
    // already truncated at `.exe`, which meant the trailing `"` was gone
    // by the time the strip ran and the leading `"` survived. The strip
    // is now anchored to a tail-quote that's present at end-of-input, so
    // a quoted path with trailing args is captured cleanly. inspectPath
    // still re-strips quotes defensively but no longer has to do so on
    // the hot path.
    const sample =
      '(Default)    REG_SZ    "C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe" /someflag';
    const detector = asPrivate(new WindowsDetector());
    expect(detector.readComServerPath(sample)).toBe(
      'C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe'
    );
  });

  it('readComServerPath strips surrounding quotes around a quoted path with no trailing args', () => {
    const sample =
      '(Default)    REG_SZ    "C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe"';
    const detector = asPrivate(new WindowsDetector());
    expect(detector.readComServerPath(sample)).toBe(
      'C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe'
    );
  });

  it('readComServerPath handles unquoted path with trailing args', () => {
    const sample =
      '(Default)    REG_SZ    C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe /background';
    const detector = asPrivate(new WindowsDetector());
    expect(detector.readComServerPath(sample)).toBe(
      'C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe'
    );
  });

  it('readComServerPath returns null when no .exe is present', () => {
    const detector = asPrivate(new WindowsDetector());
    expect(detector.readComServerPath('nothing useful')).toBeNull();
  });

  it('readVersionFromPath prefers the 4-digit year', () => {
    const detector = asPrivate(new WindowsDetector());
    expect(
      detector.readVersionFromPath('C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe')
    ).toBe('2024');
  });

  it('readVersionFromPath falls back to N.N when no year exists', () => {
    const detector = asPrivate(new WindowsDetector());
    expect(detector.readVersionFromPath('C:\\Adobe\\Photoshop 25.0\\Photoshop.exe')).toBe('25.0');
  });

  it("readVersionFromPath returns 'Unknown' for paths with no version", () => {
    const detector = asPrivate(new WindowsDetector());
    expect(detector.readVersionFromPath('C:\\Adobe\\Photoshop\\Photoshop.exe')).toBe('Unknown');
  });

  it('conventionalPaths produces a non-empty list of candidate Photoshop.exe locations', () => {
    const detector = asPrivate(new WindowsDetector());
    const paths = detector.conventionalPaths();
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.every((p) => p.endsWith('Photoshop.exe'))).toBe(true);
    // covers a wide year range
    expect(paths.some((p) => p.includes('2025'))).toBe(true);
    expect(paths.some((p) => p.includes('2012'))).toBe(true);
  });

  describe('conventionalPaths — clock-derived upper year bound', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('generates currentYear + 1 as the newest candidate (Adobe ships year+1 branding in the fall)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2030-03-01T00:00:00Z'));

      const detector = asPrivate(new WindowsDetector());
      const paths = detector.conventionalPaths();

      expect(paths.some((p) => p.includes('2031'))).toBe(true);
      expect(paths.some((p) => p.includes('2032'))).toBe(false);
      // floor is unchanged
      expect(paths.some((p) => p.includes('2012'))).toBe(true);
      expect(paths.some((p) => p.includes('2011'))).toBe(false);
    });

    // C8/Q9: the year+1 bound is clamped to a floor of 2026 (below), so a
    // "different pinned year" case that still exercises the DYNAMIC
    // (non-clamped) branch needs a year whose year+1 is already above that
    // floor — 2013 (year+1 = 2014) no longer qualifies post-clamp; see the
    // dedicated clamp test further down for the below-floor case.
    it('keeps the 2012 floor and the bound tracks a different pinned year too', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2028-11-01T00:00:00Z'));

      const detector = asPrivate(new WindowsDetector());
      const paths = detector.conventionalPaths();

      expect(paths.some((p) => p.includes('2029'))).toBe(true);
      expect(paths.some((p) => p.includes('2030'))).toBe(false);
      expect(paths.some((p) => p.includes('2012'))).toBe(true);
    });

    // C8/Q9 — a wrong/reset system clock (dead CMOS battery, a VM booting at
    // the Unix epoch) must never be able to sink the upper bound below the
    // known-good Photoshop version range. Math.max(currentYear+1, 2026)
    // clamps it.
    it('clamps the upper bound to at least 2026 when the system clock reads a year far in the past', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2005-06-01T00:00:00Z'));

      const detector = asPrivate(new WindowsDetector());
      const paths = detector.conventionalPaths();

      expect(paths.some((p) => p.includes('2026'))).toBe(true);
      expect(paths.some((p) => p.includes('2012'))).toBe(true);
      expect(paths.some((p) => p.includes('2027'))).toBe(false);
      expect(paths.some((p) => p.includes('2006'))).toBe(false);
    });
  });

  describe('inspectPath — composing an executable path from a directory', () => {
    afterEach(() => {
      accessMock.mockReset();
      accessMock.mockImplementation(async () => {
        throw new Error('ENOENT');
      });
    });

    it('does not double the separator when the directory ends in one', async () => {
      // The registry's ApplicationPath value is a directory WITH a trailing
      // backslash, which is the common real-world input here. Windows resolves
      // a doubled separator anyway, but this path is stored on the install
      // record and handed to launch(), so it should be well-formed.
      accessMock.mockImplementation(async () => undefined);
      const detector = asPrivate(new WindowsDetector());
      const info = await detector.inspectPath('C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\');

      expect(info?.path).toBe('C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe');
    });

    it('appends the executable to a directory with no trailing separator', async () => {
      accessMock.mockImplementation(async () => undefined);
      const detector = asPrivate(new WindowsDetector());
      const info = await detector.inspectPath('C:\\Program Files\\Adobe\\Adobe Photoshop 2026');

      expect(info?.path).toBe('C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe');
    });

    it('leaves an executable path alone', async () => {
      accessMock.mockImplementation(async () => undefined);
      const detector = asPrivate(new WindowsDetector());
      const info = await detector.inspectPath(
        'C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe'
      );

      expect(info?.path).toBe('C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe');
    });
  });

  describe('probeCandidates — concurrent probing preserves candidate priority order', () => {
    afterEach(() => {
      accessMock.mockReset();
      accessMock.mockImplementation(async () => {
        throw new Error('ENOENT');
      });
    });

    it('returns the first-in-order hit even when a lower-priority candidate resolves faster', async () => {
      const newerPath = 'C:\\Program Files\\Adobe\\Adobe Photoshop 2027\\Photoshop.exe';
      const olderPath = 'C:\\Program Files\\Adobe\\Adobe Photoshop 2020\\Photoshop.exe';

      accessMock.mockImplementation(async (path: string) => {
        if (path === olderPath) {
          // Resolves immediately — would win a "first to settle" race.
          return;
        }
        if (path === newerPath) {
          // Resolves slower, but is earlier in candidate (priority) order.
          await new Promise((resolve) => setTimeout(resolve, 15));
          return;
        }
        throw new Error('ENOENT');
      });

      const detector = asPrivate(new WindowsDetector());
      // newerPath listed first, matching conventionalPaths' newest-year-first order.
      const result = await detector.probeCandidates([newerPath, olderPath]);

      expect(result?.path).toBe(newerPath);
    });

    it('falls through to a lower-priority candidate when higher-priority ones are absent', async () => {
      const missingPath = 'C:\\Program Files\\Adobe\\Adobe Photoshop 2027\\Photoshop.exe';
      const presentPath = 'C:\\Program Files\\Adobe\\Adobe Photoshop 2020\\Photoshop.exe';

      accessMock.mockImplementation(async (path: string) => {
        if (path === presentPath) return;
        throw new Error('ENOENT');
      });

      const detector = asPrivate(new WindowsDetector());
      const result = await detector.probeCandidates([missingPath, presentPath]);

      expect(result?.path).toBe(presentPath);
    });

    it('returns null when no candidate exists', async () => {
      const detector = asPrivate(new WindowsDetector());
      const result = await detector.probeCandidates([
        'C:\\Program Files\\Adobe\\Adobe Photoshop 2027\\Photoshop.exe',
      ]);

      expect(result).toBeNull();
    });

    // With several candidates installed, the per-candidate line used to fire at
    // INFO for every one of them under the concurrent fan-out above — announcing
    // each as though it had been chosen. The per-candidate line is DEBUG now;
    // exactly one INFO line fires, naming the selected (priority-first) path.
    it('logs exactly one INFO line, for the selected path, even when multiple candidates exist', async () => {
      const infoSpy = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined);
      const debugSpy = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      try {
        const newerPath = 'C:\\Program Files\\Adobe\\Adobe Photoshop 2027\\Photoshop.exe';
        const olderPath = 'C:\\Program Files\\Adobe\\Adobe Photoshop 2020\\Photoshop.exe';
        accessMock.mockImplementation(async () => undefined); // both candidates exist

        const detector = asPrivate(new WindowsDetector());
        await detector.probeCandidates([newerPath, olderPath]);

        // Joined across the whole call, so it holds whether the path is
        // interpolated into the message or passed as a detail argument.
        const selectionLines = infoSpy.mock.calls
          .map((call) => call.map(String).join(' '))
          .filter((line) => line.includes('Using Photoshop at'));
        expect(selectionLines).toHaveLength(1);
        expect(selectionLines[0]).toContain(newerPath);

        const candidateLines = debugSpy.mock.calls
          .map((call) => call.map(String).join(' '))
          .filter((line) => line.includes('Candidate install exists'));
        expect(candidateLines).toHaveLength(2); // one per existing candidate, at debug
      } finally {
        infoSpy.mockRestore();
        debugSpy.mockRestore();
      }
    });
  });
});
