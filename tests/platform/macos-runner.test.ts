import { describe, it, expect } from 'vitest';
import { MacOSScriptRunner } from '@editmamei/platform/macos-runner.ts';
import type { PhotoshopInfo } from '@editmamei/platform/ports.ts';

/**
 * As on Windows, what is verifiable without a live Photoshop is the wrapper
 * this composes. The `osascript` child path is exercised through the spawn seam
 * in `run-child.test.ts`.
 */
type PrivateRunner = {
  buildAppleScriptWrapper(scriptPath: string, timeoutMs?: number): string;
};

function asPrivate(r: MacOSScriptRunner): PrivateRunner {
  return r as unknown as PrivateRunner;
}

function install(appName: string): PhotoshopInfo {
  return { version: '27.2.0', path: `/Applications/${appName}.app`, appName };
}

/** A runner that has been told which application to address. */
function readyRunner(appName = 'Adobe Photoshop 2026'): MacOSScriptRunner {
  const runner = new MacOSScriptRunner();
  runner.useInstall(install(appName));
  return runner;
}

describe('MacOSScriptRunner — addressing the application', () => {
  it('refuses to compose a wrapper before an install has been supplied', () => {
    // Previously this fell back to a hardcoded application name, which named a
    // release the product no longer targets. AppleScript answered a wrong name
    // with an opaque "application isn't running", so the failure surfaced far
    // from its cause. Failing here, with a reason, is the point of the change.
    const runner = asPrivate(new MacOSScriptRunner());
    expect(() => runner.buildAppleScriptWrapper('/tmp/x/s.jsx')).toThrow(/useInstall/);
  });

  it('addresses the application the install names', () => {
    const wrapper = asPrivate(readyRunner()).buildAppleScriptWrapper('/tmp/x/s.jsx');
    expect(wrapper).toContain('tell application "Adobe Photoshop 2026"');
  });

  it('ignores an install that carries no application name', () => {
    // Windows installs legitimately have none; the runner should stay
    // unconfigured rather than record undefined.
    const runner = new MacOSScriptRunner();
    runner.useInstall({ version: '27.2.0', path: '/Applications/Whatever.app' });
    expect(() => asPrivate(runner).buildAppleScriptWrapper('/tmp/x/s.jsx')).toThrow(/useInstall/);
  });

  it('refuses an application name containing a quote', () => {
    expect(() => new MacOSScriptRunner().useInstall(install('Adobe "Pwn" 2026'))).toThrow(
      /cannot be composed into AppleScript/
    );
  });

  it('refuses an application name containing a newline', () => {
    expect(() => new MacOSScriptRunner().useInstall(install('Adobe\nPwn 2026'))).toThrow(
      /cannot be composed into AppleScript/
    );
  });
});

describe('MacOSScriptRunner — AppleScript wrapper', () => {
  it('wires a do-javascript call against the script path', () => {
    const wrapper = asPrivate(readyRunner()).buildAppleScriptWrapper('/tmp/abc/script.jsx');
    expect(wrapper).toContain('tell application');
    expect(wrapper).toContain('do javascript');
    expect(wrapper).toContain('/tmp/abc/script.jsx');
  });

  it('never activates the application', () => {
    // Activating before every call pulled Photoshop to the foreground on every
    // single tool call. `do javascript` works against a backgrounded app, so
    // this guards against the line being reintroduced.
    const wrapper = asPrivate(readyRunner()).buildAppleScriptWrapper('/tmp/abc/script.jsx');
    expect(wrapper).not.toContain('activate');
  });

  // ===========================================================================
  // Apple Events carry their own timeout, defaulting to roughly two minutes and
  // independent of the caller's budget. Without an explicit clause, any budget
  // at or above that default is silently ineffective — AppleScript gives up
  // first and reports its own generic timeout instead of ours.
  // ===========================================================================
  it('emits a timeout clause derived from the given budget', () => {
    const wrapper = asPrivate(readyRunner()).buildAppleScriptWrapper('/tmp/abc/script.jsx', 120000);
    expect(wrapper).toContain('with timeout of 120 seconds');
    expect(wrapper).toContain('end timeout');
    expect(wrapper).toMatch(
      /with timeout of 120 seconds[\s\S]*tell application[\s\S]*do javascript[\s\S]*end tell[\s\S]*end timeout/
    );
  });

  it('rounds a fractional second up, never below the caller budget', () => {
    // Rounding down would hand AppleScript a shorter deadline than the caller
    // asked for, reintroducing the very race the clause exists to close.
    const wrapper = asPrivate(readyRunner()).buildAppleScriptWrapper('/tmp/abc/script.jsx', 10500);
    expect(wrapper).toContain('with timeout of 11 seconds');
  });

  it('derives the clause from the value given, not a constant', () => {
    const runner = asPrivate(readyRunner());
    expect(runner.buildAppleScriptWrapper('/tmp/a/s.jsx', 90000)).toContain(
      'with timeout of 90 seconds'
    );
    expect(runner.buildAppleScriptWrapper('/tmp/a/s.jsx', 5000)).toContain(
      'with timeout of 5 seconds'
    );
  });

  it.each([
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -5000],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('floors a %s budget to a compilable clause', (_label, bad) => {
    // `with timeout of NaN seconds` is an AppleScript *compile* error, so a
    // degenerate budget would break every macOS call rather than just its own.
    const wrapper = asPrivate(readyRunner()).buildAppleScriptWrapper(
      '/tmp/abc/script.jsx',
      bad as number
    );
    expect(wrapper).toContain('with timeout of 1 seconds');
    expect(wrapper).not.toContain('NaN');
    expect(wrapper).not.toContain('Infinity');
  });

  // ===========================================================================
  // Path composition. The script path lands inside a single-quoted JavaScript
  // literal nested in a double-quoted AppleScript one, so a quote or newline
  // is refused outright while an apostrophe is percent-encoded — the latter
  // would otherwise close the inner literal early, which is a genuine
  // break-out rather than merely a broken path.
  // ===========================================================================
  it('refuses a script path containing a double quote', () => {
    const runner = asPrivate(readyRunner());
    expect(() => runner.buildAppleScriptWrapper('/tmp/has"quote/script.jsx')).toThrow(/break/);
  });

  it('refuses a script path containing a newline', () => {
    const runner = asPrivate(readyRunner());
    expect(() => runner.buildAppleScriptWrapper('/tmp/has\nnewline/script.jsx')).toThrow(/break/);
  });

  it('percent-encodes an apostrophe rather than refusing it', () => {
    // macOS account names may legally contain an apostrophe, which lands in the
    // fallback temp root. Refusing it made the server unusable for those users.
    const runner = asPrivate(readyRunner());
    const scriptPath = "/Users/O'Brien/Library/Caches/editmamei/tmp/script.jsx";
    let wrapper = '';
    expect(() => {
      wrapper = runner.buildAppleScriptWrapper(scriptPath);
    }).not.toThrow();
    expect(wrapper).toContain('%27');
    expect(wrapper).not.toContain("decodeURI('/Users/O'Brien");
  });

  it('leaves an ordinary path unencoded beyond the usual URI escaping', () => {
    const runner = asPrivate(readyRunner());
    const scriptPath = '/Users/alex/Library/Caches/editmamei/tmp/script.jsx';
    const wrapper = runner.buildAppleScriptWrapper(scriptPath);
    expect(wrapper).toContain(encodeURI(scriptPath));
    expect(wrapper).not.toContain('%27');
  });
});

describe('MacOSScriptRunner — launch', () => {
  it('clears the startup timer when the spawn errors', () => {
    const launchSrc = (
      new MacOSScriptRunner() as unknown as {
        launch: (...args: unknown[]) => unknown;
      }
    ).launch.toString();
    expect(launchSrc).toContain('clearTimeout');
    expect(launchSrc).toMatch(/['"]error['"]/);
  });
});
