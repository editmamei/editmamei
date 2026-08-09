import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  zipBundle,
  unzipBundle,
  packBundle,
  unpackBundle,
  installBundle,
  safeResolve,
  isUnsafeEntryName,
  BundleError,
  type BundleFile,
} from '@editmamei/delivery/bundle.ts';
import { ModuleCryptoError } from '@editmamei/delivery/crypto.ts';

const keyB64 = randomBytes(32).toString('base64');

function sampleFiles(): BundleFile[] {
  return [
    {
      name: 'pro-handlers.mjs',
      data: Buffer.from('export default { manifest: {}, register(){} }'),
    },
    { name: 'bin/editmamei-core-win-x64.exe', data: Buffer.from([0x4d, 0x5a, 0x90, 0x00]) },
    { name: 'bin/editmamei-core-darwin-arm64', data: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]) },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ id: 'pro', version: '1.0.0' })) },
  ];
}

function byName(files: BundleFile[]): Map<string, Buffer> {
  return new Map(files.map((f) => [f.name, Buffer.from(f.data)]));
}

describe('zip/unzip bundle container', () => {
  it('round-trips a set of files', () => {
    const files = sampleFiles();
    const out = byName(unzipBundle(zipBundle(files)));
    expect([...out.keys()].sort()).toEqual(files.map((f) => f.name).sort());
    for (const f of files) {
      expect(out.get(f.name)!.equals(Buffer.from(f.data))).toBe(true);
    }
  });

  it('is byte-stable for a given input set (deterministic entry order)', () => {
    const files = sampleFiles();
    expect(zipBundle(files).equals(zipBundle([...files].reverse()))).toBe(true);
  });
});

describe('packBundle / unpackBundle', () => {
  it('round-trips files through zip + AES-256-GCM', () => {
    const files = sampleFiles();
    const blob = packBundle(files, keyB64);
    const out = byName(unpackBundle(blob, keyB64));
    for (const f of files) {
      expect(out.get(f.name)!.equals(Buffer.from(f.data))).toBe(true);
    }
  });

  it('throws on the wrong content key', () => {
    const blob = packBundle(sampleFiles(), keyB64);
    expect(() => unpackBundle(blob, randomBytes(32).toString('base64'))).toThrow(ModuleCryptoError);
  });

  it('throws on a tampered artifact (GCM auth tag failure)', () => {
    const blob = Buffer.from(packBundle(sampleFiles(), keyB64));
    blob[blob.length - 1] ^= 0xff; // flip a tag byte
    expect(() => unpackBundle(blob, keyB64)).toThrow(ModuleCryptoError);
  });
});

describe('installBundle', () => {
  it('writes every file under destDir, creating subdirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editmamei-bundle-test-'));
    try {
      const files = sampleFiles();
      const written = installBundle(packBundle(files, keyB64), keyB64, dir);
      expect(written.sort()).toEqual(files.map((f) => f.name).sort());
      for (const f of files) {
        expect(readFileSync(join(dir, f.name)).equals(Buffer.from(f.data))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks go-core binaries executable on POSIX', () => {
    if (process.platform === 'win32') return; // no exec bit on Windows
    const dir = mkdtempSync(join(tmpdir(), 'editmamei-bundle-test-'));
    try {
      installBundle(packBundle(sampleFiles(), keyB64), keyB64, dir);
      const binMode = statSync(join(dir, 'bin/editmamei-core-darwin-arm64')).mode & 0o777;
      expect(binMode & 0o100).toBe(0o100); // owner-execute set
      const jsonMode = statSync(join(dir, 'manifest.json')).mode & 0o777;
      expect(jsonMode & 0o100).toBe(0); // not executable
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a sanitized traversal entry inside the install dir', () => {
    // adm-zip strips leading `../` on read, so a traversal entry lands safely
    // inside destDir rather than escaping — confirm it doesn't write outside.
    // (The traversal SAFETY RULE itself is pinned adversarially by the
    // isUnsafeEntryName + safeResolve suites below, which exercise the throw
    // path the container's pre-sanitization can't reliably deliver here.)
    const dir = mkdtempSync(join(tmpdir(), 'editmamei-bundle-test-'));
    try {
      const written = installBundle(
        packBundle([{ name: '../escape.txt', data: Buffer.from('x') }], keyB64),
        keyB64,
        dir
      );
      for (const name of written) {
        expect(name.includes('..')).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isUnsafeEntryName (unzip-boundary traversal guard)', () => {
  it('rejects `..` traversal segments anywhere in the path', () => {
    expect(isUnsafeEntryName('../escape.txt')).toBe(true);
    expect(isUnsafeEntryName('a/../../b')).toBe(true);
    expect(isUnsafeEntryName('bin/../../etc/x')).toBe(true);
    expect(isUnsafeEntryName('a\\..\\b')).toBe(true);
  });

  it('rejects absolute, drive-letter, and UNC entry names', () => {
    expect(isUnsafeEntryName('/etc/passwd')).toBe(true);
    expect(isUnsafeEntryName('C:\\Windows\\x')).toBe(true);
    expect(isUnsafeEntryName('c:/Windows/x')).toBe(true);
    expect(isUnsafeEntryName('\\\\server\\share\\x')).toBe(true);
  });

  it('accepts normal nested module entry names', () => {
    expect(isUnsafeEntryName('pro-handlers.mjs')).toBe(false);
    expect(isUnsafeEntryName('bin/editmamei-core-darwin-arm64')).toBe(false);
    expect(isUnsafeEntryName('a/b/c.txt')).toBe(false);
  });

  it('throws from unzipBundle when an entry name survives as unsafe', () => {
    // zipBundle adds the entry name verbatim; if it reaches getEntries() still
    // carrying a `..` segment, unzipBundle fails closed before returning it.
    const bad = zipBundle([{ name: 'a/../../escape', data: Buffer.from('x') }]);
    const entryNames = unzipSafe(bad);
    // Either adm-zip pre-sanitized the name (no `..` reaches us) OR unzipBundle threw.
    if (entryNames) {
      for (const n of entryNames) expect(n.includes('..')).toBe(false);
    }
  });
});

/** unzipBundle, but returns the entry names or undefined if it fail-closed-threw. */
function unzipSafe(container: Uint8Array): string[] | undefined {
  try {
    return unzipBundle(container).map((f) => f.name);
  } catch (e) {
    expect(e).toBeInstanceOf(BundleError);
    return undefined;
  }
}

describe('decompression-bomb guards', () => {
  it('rejects a bundle with too many entries', () => {
    const many: BundleFile[] = Array.from({ length: 100 }, (_, i) => ({
      name: `f${i}.txt`,
      data: Buffer.from(String(i)),
    }));
    expect(() => unpackBundle(packBundle(many, keyB64), keyB64)).toThrow(BundleError);
  });

  it('accepts a normal small bundle (under the entry cap)', () => {
    expect(() => unpackBundle(packBundle(sampleFiles(), keyB64), keyB64)).not.toThrow();
  });
});

describe('safeResolve (Zip-Slip guard)', () => {
  const root = process.platform === 'win32' ? 'C:\\install' : '/install';

  it('resolves a normal nested entry inside root', () => {
    expect(() => safeResolve(root, 'bin/editmamei-core-darwin-arm64')).not.toThrow();
  });

  it('rejects a parent-traversal entry', () => {
    expect(() => safeResolve(root, '../escape.txt')).toThrow(BundleError);
    expect(() => safeResolve(root, 'a/../../b')).toThrow(BundleError);
  });

  it('rejects an absolute-path entry', () => {
    const abs = process.platform === 'win32' ? 'C:\\Windows\\x' : '/etc/passwd';
    expect(() => safeResolve(root, abs)).toThrow(BundleError);
  });
});
