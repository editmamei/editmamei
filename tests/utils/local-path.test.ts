import { afterEach, describe, expect, it } from 'vitest';
import {
  checkOutputPath,
  localPathProblem,
  looksLikePath,
  PathArgumentError,
  recordOutputPath,
  requireLocalPath,
  resetOutputPathsForTests,
} from '@editmamei/utils/local-path.ts';

afterEach(() => resetOutputPathsForTests());

describe('localPathProblem', () => {
  it.each([
    ['\\\\attacker.example\\share\\x.jpg', 'unc_or_device'],
    ['\\\\attacker.example@SSL\\drop\\out.jpg', 'unc_or_device'],
    ['//attacker.example/share/x.jpg', 'unc_or_device'],
    ['\\\\?\\C:\\x.jpg', 'unc_or_device'],
    ['\\\\.\\PhysicalDrive0', 'unc_or_device'],
    ['\\??\\UNC\\attacker.example\\share\\x.jpg', 'no_drive'],
    ['\\x.jpg', 'no_drive'],
    ['photos\\x.jpg', 'relative'],
    ['', 'not_string'],
    ['C:/Users/me/x.jpg', undefined],
    ['D:\\Photos\\x.jpg', undefined],
  ])('win32: %s -> %s', (value, problem) => {
    expect(localPathProblem(value, 'win32')).toBe(problem);
  });

  it.each([
    ['//attacker.example/share/x.jpg', 'unc_or_device'],
    ['photos/x.jpg', 'relative'],
    ['C:/Users/me/x.jpg', 'relative'],
    ['/Users/me/x.jpg', undefined],
  ])('posix: %s -> %s', (value, problem) => {
    expect(localPathProblem(value, 'darwin')).toBe(problem);
  });

  it('refuses a non-string', () => {
    expect(localPathProblem(42, 'win32')).toBe('not_string');
    expect(localPathProblem(undefined, 'darwin')).toBe('not_string');
  });
});

describe('requireLocalPath', () => {
  it('returns a local path unchanged', () => {
    expect(requireLocalPath('file_path', 'C:/Users/me/x.jpg', { platform: 'win32' })).toBe(
      'C:/Users/me/x.jpg'
    );
    expect(requireLocalPath('file_path', '/Users/me/x.jpg', { platform: 'darwin' })).toBe(
      '/Users/me/x.jpg'
    );
  });

  it('refuses a network share, naming the field, before anything touches it', () => {
    expect(() =>
      requireLocalPath('file_path', '\\\\attacker.example\\s\\x.jpg', { platform: 'win32' })
    ).toThrow(PathArgumentError);
    expect(() =>
      requireLocalPath('file_path', '\\\\attacker.example\\s\\x.jpg', { platform: 'win32' })
    ).toThrow(/"file_path" must be a file on this computer's own drives/);
  });

  it('expands a leading ~ to the home directory, then checks the result', () => {
    expect(
      requireLocalPath('file_path', '~/Pictures/x.jpg', { platform: 'darwin', home: '/Users/me' })
    ).toBe('/Users/me/Pictures/x.jpg');
    expect(
      requireLocalPath('file_path', '~\\Pictures\\x.jpg', {
        platform: 'win32',
        home: 'C:\\Users\\me',
      })
    ).toBe('C:\\Users\\me\\Pictures\\x.jpg');
    // A home directory that is itself a share is still refused.
    expect(() =>
      requireLocalPath('file_path', '~/x.jpg', { platform: 'win32', home: '\\\\server\\home\\me' })
    ).toThrow(/own drives/);
  });
});

describe('looksLikePath', () => {
  it('tells a LUT preset name from a path', () => {
    expect(looksLikePath('TealOrangePlusContrast.3DL')).toBe(false);
    expect(looksLikePath('Kodak 5205 Fuji 3510 (by Adobe).cube')).toBe(false);
    expect(looksLikePath('C:/LUTs/x.cube')).toBe(true);
    expect(looksLikePath('\\\\server\\luts\\x.cube')).toBe(true);
    expect(looksLikePath('~/luts/x.cube')).toBe(true);
  });
});

describe('checkOutputPath', () => {
  const win = { platform: 'win32', extensions: ['.jpg', '.jpeg'] } as const;

  it('requires the format extension, in any case', () => {
    expect(checkOutputPath('output_path', 'C:/out/a.JPG', { ...win, exists: () => false })).toBe(
      'C:/out/a.JPG'
    );
    expect(() =>
      checkOutputPath('output_path', 'C:/out/a.bat', { ...win, exists: () => false })
    ).toThrow(/must end in .jpg or .jpeg/);
    expect(() =>
      checkOutputPath('output_path', 'C:/out/a', { ...win, exists: () => false })
    ).toThrow(/must end in/);
  });

  it('refuses a network share or WebDAV destination', () => {
    expect(() =>
      checkOutputPath('output_path', '\\\\attacker.example@SSL\\drop\\out.jpg', {
        ...win,
        exists: () => false,
      })
    ).toThrow(/own drives/);
  });

  it('refuses to replace a file this session did not write, unless told to', () => {
    const exists = () => true;
    expect(() =>
      checkOutputPath('output_path', 'C:/photos/IMG_001.jpg', { ...win, exists })
    ).toThrow(
      /a file already exists at "C:\/photos\/IMG_001.jpg" and was not written in this session/
    );
    expect(
      checkOutputPath('output_path', 'C:/photos/IMG_001.jpg', { ...win, exists, overwrite: true })
    ).toBe('C:/photos/IMG_001.jpg');
  });

  it("lets a later save replace this session's own output, matching case-insensitively on Windows", () => {
    const exists = () => true;
    recordOutputPath('C:/out/Final.jpg', 'win32');
    expect(checkOutputPath('output_path', 'c:\\OUT\\final.jpg', { ...win, exists })).toBe(
      'c:\\OUT\\final.jpg'
    );
    expect(() => checkOutputPath('output_path', 'C:/out/other.jpg', { ...win, exists })).toThrow(
      /already exists/
    );
  });

  it('matches case-sensitively on Linux', () => {
    const exists = () => true;
    recordOutputPath('/out/Final.jpg', 'linux');
    const linux = { platform: 'linux', extensions: ['.jpg'], exists } as const;
    expect(checkOutputPath('output_path', '/out/Final.jpg', linux)).toBe('/out/Final.jpg');
    expect(() => checkOutputPath('output_path', '/out/final.jpg', linux)).toThrow(/already exists/);
  });
});
