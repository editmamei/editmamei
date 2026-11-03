import { describe, it, expect } from 'vitest';
import { WindowsScriptRunner } from '@editmamei/platform/windows-runner.ts';

/**
 * The runner mostly drives external processes (cscript, tasklist, spawn). What
 * can be verified in isolation is the COM shim it composes — a deterministic
 * string operation. The child-process path itself is exercised through the
 * spawn seam in `run-child.test.ts`.
 */
type PrivateRunner = {
  buildComShim(scriptPath: string): string;
};

function asPrivate(r: WindowsScriptRunner): PrivateRunner {
  return r as unknown as PrivateRunner;
}

describe('WindowsScriptRunner — COM shim', () => {
  it('wires COM object creation and a DoJavaScript call', () => {
    const shim = asPrivate(new WindowsScriptRunner()).buildComShim('C:\\tmp\\script.jsx');
    expect(shim).toContain('CreateObject("Photoshop.Application")');
    expect(shim).toContain('DoJavaScript');
    expect(shim).toContain('On Error Resume Next');
    expect(shim).toContain('WScript.Quit 1');
    expect(shim).toContain('C:\\tmp\\script.jsx');
  });

  it('emits the failure marker the decoder recognizes', () => {
    // The shim and decodeScriptResult are two halves of one convention; if the
    // shim stops emitting the marker, failures decode as ordinary values.
    const shim = asPrivate(new WindowsScriptRunner()).buildComShim('C:\\tmp\\script.jsx');
    expect(shim).toContain('WScript.Echo "ERROR:');
  });

  // ===========================================================================
  // Composition refusal. The path is interpolated only inside a double-quoted
  // VBScript literal, so only a literal `"` can break it — an apostrophe there
  // is an ordinary character, since a VBScript comment starts with `'` only
  // outside a string.
  // ===========================================================================
  it('refuses a script path containing a double quote', () => {
    const runner = asPrivate(new WindowsScriptRunner());
    expect(() => runner.buildComShim('C:\\has"quote\\script.jsx')).toThrow(/quote/i);
  });

  it('composes a path containing an apostrophe', () => {
    // Windows account names may legally contain an apostrophe, which lands
    // straight in %TEMP%. Refusing it made the server unusable for those users.
    const runner = asPrivate(new WindowsScriptRunner());
    const scriptPath =
      "C:\\Users\\D'Angelo\\AppData\\Local\\Temp\\editmamei-win-abc123\\script.jsx";
    let shim = '';
    expect(() => {
      shim = runner.buildComShim(scriptPath);
    }).not.toThrow();
    expect(shim).toContain(scriptPath);
  });

  it('composes a path containing a space', () => {
    const runner = asPrivate(new WindowsScriptRunner());
    const scriptPath = 'C:\\Users\\John Smith\\AppData\\Local\\Temp\\editmamei-win-y\\script.jsx';
    let shim = '';
    expect(() => {
      shim = runner.buildComShim(scriptPath);
    }).not.toThrow();
    expect(shim).toContain(scriptPath);
  });

  it('doubles the path backslashes — load-bearing, pins the Replace', () => {
    // The composed VBScript replaces each backslash with two so that
    // ExtendScript's own string parser resolves the path back to single ones.
    // A refactor that drops or inverts this would corrupt every Windows path
    // at runtime while leaving every other test in this file green.
    const runner = asPrivate(new WindowsScriptRunner());
    const scriptPath = 'C:\\Users\\me\\AppData\\Local\\Temp\\editmamei-win-x\\script.jsx';
    expect(runner.buildComShim(scriptPath)).toContain(`Replace("${scriptPath}", "\\", "\\\\")`);
  });
});

describe('WindowsScriptRunner — launch', () => {
  it('guards the readiness poll against resolving after the spawn errors', () => {
    // Source-string assertion: spawning Photoshop in a unit test is not
    // practical. Without the guard, a spawn error that rejects the promise
    // could still be followed by the readiness poll resolving it a second
    // time. The poll itself is exercised in launch-readiness.test.ts. Pins
    // intent, not bytes — quote style is left unpinned since transformers vary.
    const launchSrc = (
      new WindowsScriptRunner() as unknown as {
        launch: (...args: unknown[]) => unknown;
      }
    ).launch.toString();
    expect(launchSrc).toMatch(/['"]error['"]/);
    expect(launchSrc).toContain('aborted');
  });
});
