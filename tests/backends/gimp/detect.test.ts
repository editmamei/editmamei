import { describe, it, expect } from 'vitest';
import { detectGimp } from '@editmamei/backends/gimp/detect.ts';

/** Builds an `exists()` seam that reports true for exactly the given paths. */
function existsAmong(paths: readonly string[]): (p: string) => Promise<boolean> {
  const set = new Set(paths);
  return async (p) => set.has(p);
}

describe('detectGimp', () => {
  describe('env override', () => {
    it('wins over everything else when the override path exists', async () => {
      const install = await detectGimp({
        platform: 'win32',
        env: { EDITMAMEI_GIMP_PATH: 'D:\\custom\\gimp-console.exe' },
        exists: existsAmong([
          'D:\\custom\\gimp-console.exe',
          'C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.exe',
        ]),
      });
      expect(install).toEqual({
        source: 'env',
        path: 'D:\\custom\\gimp-console.exe',
        launch: { command: 'D:\\custom\\gimp-console.exe', args: [] },
      });
    });

    it('a literal "flatpak" value launches via Flatpak without any filesystem check', async () => {
      let checked = false;
      const install = await detectGimp({
        platform: 'linux',
        env: { EDITMAMEI_GIMP_PATH: 'flatpak' },
        exists: async () => {
          checked = true;
          return false;
        },
      });
      expect(checked).toBe(false);
      expect(install).toEqual({
        source: 'env',
        path: 'flatpak',
        launch: {
          command: 'flatpak',
          args: ['run', '--command=gimp-console-3.2', 'org.gimp.GIMP'],
        },
      });
    });

    it('falls through to conventional detection when the override path does not exist', async () => {
      const install = await detectGimp({
        platform: 'win32',
        env: {
          EDITMAMEI_GIMP_PATH: 'D:\\nowhere\\gimp-console.exe',
          ProgramFiles: 'C:\\Program Files',
        },
        exists: existsAmong(['C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.exe']),
      });
      expect(install?.source).toBe('conventional');
      expect(install?.path).toBe('C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.exe');
    });
  });

  describe('windows', () => {
    it('finds the unversioned exe in %LOCALAPPDATA%', async () => {
      const install = await detectGimp({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local' },
        exists: existsAmong([
          'C:\\Users\\alex\\AppData\\Local\\Programs\\GIMP 3\\bin\\gimp-console-3.exe',
        ]),
      });
      expect(install).toEqual({
        source: 'conventional',
        path: 'C:\\Users\\alex\\AppData\\Local\\Programs\\GIMP 3\\bin\\gimp-console-3.exe',
        launch: {
          command: 'C:\\Users\\alex\\AppData\\Local\\Programs\\GIMP 3\\bin\\gimp-console-3.exe',
          args: [],
        },
      });
    });

    it('accepts the versioned exe name when the unversioned one is absent', async () => {
      const install = await detectGimp({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files' },
        exists: existsAmong(['C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.2.exe']),
      });
      expect(install?.path).toBe('C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.2.exe');
    });

    it('prefers the versioned exe name even when it is in a lower-priority base dir (same rationale as Linux)', async () => {
      const install = await detectGimp({
        platform: 'win32',
        env: {
          LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local',
          ProgramFiles: 'C:\\Program Files',
        },
        exists: existsAmong([
          // Unversioned in the higher-priority %LOCALAPPDATA% base...
          'C:\\Users\\alex\\AppData\\Local\\Programs\\GIMP 3\\bin\\gimp-console-3.exe',
          // ...versioned in the lower-priority Program Files base still wins.
          'C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.2.exe',
        ]),
      });
      expect(install?.path).toBe('C:\\Program Files\\GIMP 3\\bin\\gimp-console-3.2.exe');
    });

    it('returns null when nothing conventional exists', async () => {
      const install = await detectGimp({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
        exists: existsAmong([]),
      });
      expect(install).toBeNull();
    });
  });

  describe('macOS', () => {
    it('finds GIMP.app in /Applications', async () => {
      const install = await detectGimp({
        platform: 'darwin',
        homedir: '/Users/alex',
        exists: existsAmong(['/Applications/GIMP.app/Contents/MacOS/gimp-console-3.2']),
      });
      expect(install?.source).toBe('conventional');
      expect(install?.path).toBe('/Applications/GIMP.app/Contents/MacOS/gimp-console-3.2');
    });

    it('falls back to ~/Applications and accepts the unversioned binary name', async () => {
      const install = await detectGimp({
        platform: 'darwin',
        homedir: '/Users/alex',
        exists: existsAmong(['/Users/alex/Applications/GIMP.app/Contents/MacOS/gimp-console']),
      });
      expect(install?.path).toBe('/Users/alex/Applications/GIMP.app/Contents/MacOS/gimp-console');
    });

    it('returns null when neither location has a console binary', async () => {
      const install = await detectGimp({
        platform: 'darwin',
        homedir: '/Users/alex',
        exists: existsAmong([]),
      });
      expect(install).toBeNull();
    });
  });

  describe('linux', () => {
    it('sweeps PATH and prefers the versioned name across directories', async () => {
      const install = await detectGimp({
        platform: 'linux',
        env: { PATH: '/usr/bin:/usr/local/bin' },
        homedir: '/home/alex',
        exists: existsAmong(['/usr/bin/gimp-console', '/usr/local/bin/gimp-console-3.2']),
      });
      // gimp-console-3.2 outranks the plain name even though it's later on PATH.
      expect(install).toEqual({
        source: 'path',
        path: '/usr/local/bin/gimp-console-3.2',
        launch: { command: '/usr/local/bin/gimp-console-3.2', args: [] },
      });
    });

    it('falls back to the system Flatpak install when nothing is on PATH', async () => {
      const install = await detectGimp({
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        homedir: '/home/alex',
        exists: existsAmong(['/var/lib/flatpak/app/org.gimp.GIMP']),
      });
      expect(install).toEqual({
        source: 'flatpak',
        path: '/var/lib/flatpak/app/org.gimp.GIMP',
        launch: {
          command: 'flatpak',
          args: ['run', '--command=gimp-console-3.2', 'org.gimp.GIMP'],
        },
      });
    });

    it('falls back to the per-user Flatpak install', async () => {
      const install = await detectGimp({
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        homedir: '/home/alex',
        exists: existsAmong(['/home/alex/.local/share/flatpak/app/org.gimp.GIMP']),
      });
      expect(install?.source).toBe('flatpak');
      expect(install?.path).toBe('/home/alex/.local/share/flatpak/app/org.gimp.GIMP');
    });

    it('returns null when PATH and both Flatpak locations miss', async () => {
      const install = await detectGimp({
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        homedir: '/home/alex',
        exists: existsAmong([]),
      });
      expect(install).toBeNull();
    });
  });

  it('returns null on an unsupported platform with no override', async () => {
    const install = await detectGimp({ platform: 'sunos', exists: existsAmong([]) });
    expect(install).toBeNull();
  });
});
