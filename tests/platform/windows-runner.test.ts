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

describe('WindowsScriptRunner — which Photoshop the shim addresses', () => {
  const install = (comProgId?: string) => ({
    version: '2027',
    path: 'C:\\Program Files\\Adobe\\Adobe Photoshop 2027\\Photoshop.exe',
    comProgId,
  });

  it('attaches through the versioned ProgID the install carries', () => {
    // The unversioned ProgID follows whichever release registered last, so it
    // must not be used when the install names a versioned one.
    const runner = new WindowsScriptRunner();
    runner.useInstall(install('Photoshop.Application.210'));
    const shim = asPrivate(runner).buildComShim('C:\\tmp\\script.jsx');
    expect(shim).toContain('CreateObject("Photoshop.Application.210")');
  });

  it('falls back to the unversioned ProgID when the install has none', () => {
    const runner = new WindowsScriptRunner();
    runner.useInstall(install('Photoshop.Application.210'));
    runner.useInstall(install(undefined));
    const shim = asPrivate(runner).buildComShim('C:\\tmp\\script.jsx');
    expect(shim).toContain('CreateObject("Photoshop.Application")');
  });

  it('drops an earlier versioned ProgID when a later one is refused', () => {
    const runner = new WindowsScriptRunner();
    runner.useInstall(install('Photoshop.Application.210'));
    expect(() => runner.useInstall(install('Excel.Application'))).toThrow();
    expect(asPrivate(runner).buildComShim('C:\\tmp\\script.jsx')).toContain(
      'CreateObject("Photoshop.Application")'
    );
  });

  it.each([
    'Excel.Application',
    'Photoshop.Application.210.1',
    'Photoshop.Application.210")\nWScript.Quit 0\n("',
    'Photoshop.Application.',
  ])('refuses %j, since the ProgID is composed into VBScript', (progId) => {
    const runner = new WindowsScriptRunner();
    expect(() => runner.useInstall(install(progId))).toThrow(/not a Photoshop\.Application ProgID/);
    expect(asPrivate(runner).buildComShim('C:\\tmp\\script.jsx')).toContain(
      'CreateObject("Photoshop.Application")'
    );
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
