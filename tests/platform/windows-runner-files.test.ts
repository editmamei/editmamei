import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The bytes the Windows runner writes for each call. Photoshop and cscript
 * decode these files themselves, so their encodings are part of the contract:
 * a script file without a UTF-8 byte-order mark is decoded in the system code
 * page once its non-ASCII text sits past ExtendScript's sniffing window, and a
 * shim without a UTF-16 one is read in the ANSI code page, garbling a
 * non-ASCII temp path.
 */

const written = vi.hoisted(() => ({ script: null as Buffer | null, shim: null as Buffer | null }));

vi.mock('@editmamei/platform/run-child.ts', () => ({
  runChildWithTimeout: vi.fn(async (_cmd: string, args: string[]) => {
    // Read the files while they exist: the runner removes its temp dir after.
    const shimPath = args[1];
    written.shim = await readFile(shimPath);
    written.script = await readFile(join(dirname(shimPath), 'script.jsx'));
    return { stdout: 'pong\r\n', stderr: '', exitCode: 0 };
  }),
}));

const { WindowsScriptRunner, encodeScriptFile, encodeShimFile } =
  await import('@editmamei/platform/windows-runner.ts');

const NON_ASCII = "// Plain object \u2014 enumerate. var s = '\uD55C\uAE00 \u00FC \uD83D\uDE00';";

describe('encodeScriptFile', () => {
  it('writes UTF-8 behind a byte-order mark, keeping every character', () => {
    const bytes = encodeScriptFile(NON_ASCII);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString('utf8')).toBe(NON_ASCII);
  });
});

describe('encodeShimFile', () => {
  it('writes UTF-16LE behind a byte-order mark, keeping a non-ASCII path', () => {
    const shim = 'scriptResult = ps.DoJavaScript("C:\\Users\\\uD64D\uAE38\uB3D9\\script.jsx")';
    const bytes = encodeShimFile(shim);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString('utf16le')).toBe(shim);
  });
});

describe('WindowsScriptRunner — files on disk', () => {
  beforeEach(() => {
    written.script = null;
    written.shim = null;
  });

  it('writes the script and the shim in those encodings', async () => {
    const runner = new WindowsScriptRunner();
    await expect(runner.run(NON_ASCII)).resolves.toBe('pong');

    expect(written.script).not.toBeNull();
    expect(written.script!.equals(encodeScriptFile(NON_ASCII))).toBe(true);

    expect(written.shim).not.toBeNull();
    expect([...written.shim!.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const shimText = written.shim!.subarray(2).toString('utf16le');
    expect(shimText).toContain('DoJavaScript');
    expect(shimText).toContain('script.jsx');
  });
});
