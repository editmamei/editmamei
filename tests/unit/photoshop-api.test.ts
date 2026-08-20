import { describe, it, expect, vi } from 'vitest';
import { PhotoshopAPIFactory } from '@editmamei/api/photoshop-api.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';

describe('PhotoshopAPIFactory', () => {
  it('builds an API once an install has been detected', async () => {
    const conn = makeConnection();
    const factory = new PhotoshopAPIFactory(conn.asConnection());
    const api = await factory.createAPI();
    expect(typeof api.executeScript).toBe('function');
  });

  it('throws when no Photoshop info has been detected yet', async () => {
    const conn = makeConnection({ info: null });
    const factory = new PhotoshopAPIFactory(conn.asConnection());
    await expect(factory.createAPI()).rejects.toThrow(/Photoshop info not available/);
  });
});

// Audit finding 16 / perf M8: the per-creation "ready for scripting"
// line was INFO — the default log level — so it fired on every one of the
// ~185 runScript call sites and flooded the diagnostic ring buffer with
// zero-value lines. Demoted to debug.
describe('PhotoshopAPIFactory logging level', () => {
  it('does not emit "ready for scripting" at the default (INFO) log level', async () => {
    delete process.env.LOG_LEVEL;
    delete process.env.EDITMAMEI_VERBOSE_LOGGING;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const conn = makeConnection();
      const factory = new PhotoshopAPIFactory(conn.asConnection());
      await factory.createAPI();

      const emitted = stderrSpy.mock.calls.some((call) =>
        String(call[0]).includes('ready for scripting')
      );
      expect(emitted).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('emits "ready for scripting" when DEBUG logging is enabled', async () => {
    process.env.LOG_LEVEL = 'DEBUG';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const conn = makeConnection();
      const factory = new PhotoshopAPIFactory(conn.asConnection());
      await factory.createAPI();

      const emitted = stderrSpy.mock.calls.some((call) =>
        String(call[0]).includes('ready for scripting')
      );
      expect(emitted).toBe(true);
    } finally {
      stderrSpy.mockRestore();
      delete process.env.LOG_LEVEL;
    }
  });
});

describe('ExtendScriptPhotoshopAPI.executeScript wrapping', () => {
  it('forwards a wrapper script to the connection (the body is embedded inside)', async () => {
    const conn = makeConnection();
    const factory = new PhotoshopAPIFactory(conn.asConnection());
    const api = await factory.createAPI();

    await api.executeScript('return 42;');

    expect(conn.executions).toHaveLength(1);
    const sent = conn.lastScript();
    expect(sent).toContain('return 42;');
  });

  it('wraps the body inside an IIFE with try/catch', async () => {
    const conn = makeConnection();
    const factory = new PhotoshopAPIFactory(conn.asConnection());
    const api = await factory.createAPI();
    await api.executeScript('return 1;');
    const wrapped = conn.lastScript();
    expect(wrapped).toMatch(/^\s*\(function\s*\(\)\s*\{/);
    expect(wrapped).toContain('try {');
    expect(wrapped.trim().endsWith('})();')).toBe(true);
  });

  // The outbound half of the non-ASCII round trip. The Windows cscript stdout
  // transport is codepage-bound and flattens raw non-ASCII to '?', so a layer
  // Photoshop named itself in a non-English UI reached the caller with the
  // wrong name and could not be addressed by it. __mcpJsonEncode escapes every
  // character outside printable ASCII, which is valid JSON and survives the
  // transport intact.
  //
  // Evaluated in Node rather than asserted as source text: the encoder is
  // ExtendScript embedded in a template literal, so a string assertion would
  // pass against an encoder that no longer runs. Extracting and calling it is
  // what proves the behaviour. Same approach as runNotFound in
  // tests/unit/extendscript-helpers.test.ts.
  describe('__mcpJsonEncode non-ASCII escaping', () => {
    async function loadEncoder(): Promise<(v: unknown) => string> {
      const conn = makeConnection();
      const factory = new PhotoshopAPIFactory(conn.asConnection());
      const api = await factory.createAPI();
      await api.executeScript('return 1;');
      const wrapper = conn.lastScript();

      const start = wrapper.indexOf('function __mcpJsonEncode');
      expect(start).toBeGreaterThan(-1);
      // Walk braces to the matching close so the extraction survives edits to
      // the function body.
      let depth = 0;
      let end = -1;
      for (let i = wrapper.indexOf('{', start); i < wrapper.length; i++) {
        if (wrapper[i] === '{') depth++;
        else if (wrapper[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      expect(end).toBeGreaterThan(start);
      const source = wrapper.slice(start, end);
      return new Function(`${source}\nreturn __mcpJsonEncode;`)() as (v: unknown) => string;
    }

    it('escapes non-ASCII and round-trips losslessly through JSON.parse', async () => {
      const encode = await loadEncoder();
      for (const value of ['Farbfüllung 1', 'Kopie', '背景テスト', 'naïve', '🎨']) {
        const encoded = encode(value);
        expect(encoded).toMatch(/^[ -~]*$/);
        expect(JSON.parse(encoded)).toBe(value);
      }
    });

    it('escapes non-ASCII nested inside a result object, not just bare strings', async () => {
      const encode = await loadEncoder();
      const encoded = encode({ layerName: 'Farbfüllung 1', nested: ['Kopie'] });
      expect(encoded).toMatch(/^[ -~]*$/);
      expect(JSON.parse(encoded)).toEqual({ layerName: 'Farbfüllung 1', nested: ['Kopie'] });
    });

    it('leaves printable ASCII and the standard escapes alone', async () => {
      const encode = await loadEncoder();
      expect(encode('Layer 1')).toBe('"Layer 1"');
      expect(JSON.parse(encode('a"b\\c'))).toBe('a"b\\c');
      expect(JSON.parse(encode('tab\there'))).toBe('tab\there');
    });

    it('escapes the line/paragraph separators that break a JS eval', async () => {
      const encode = await loadEncoder();
      for (const value of ['a\u2028b', 'a\u2029b', 'del\u007fhere']) {
        expect(encode(value)).toMatch(/^[ -~]*$/);
        expect(JSON.parse(encode(value))).toBe(value);
      }
    });
  });

  it('reports both outcomes through a tagged envelope, not an in-band prefix', async () => {
    // The wrapper and decodeScriptResult are two halves of one contract. If the
    // wrapper stops tagging its output, the decoder hands the raw envelope back
    // to handlers as though it were the value, and thrown scripts stop throwing.
    const conn = makeConnection();
    const factory = new PhotoshopAPIFactory(conn.asConnection());
    const api = await factory.createAPI();
    await api.executeScript('return 1;');
    const wrapped = conn.lastScript();

    expect(wrapped).toContain('__em');
    expect(wrapped).toContain('ok: true');
    expect(wrapped).toContain('ok: false');
    // Photoshop's own error number and line ride along, so a failure can be
    // identified without string-matching prose that varies by release.
    expect(wrapped).toContain('error.number');
    expect(wrapped).toContain('error.line');
  });

  it('forces pixels/points units around the user script', async () => {
    const conn = makeConnection();
    const factory = new PhotoshopAPIFactory(conn.asConnection());
    const api = await factory.createAPI();
    await api.executeScript('return 1;');
    const wrapped = conn.lastScript();
    expect(wrapped).toContain('app.preferences.rulerUnits = Units.PIXELS');
    expect(wrapped).toContain('app.preferences.typeUnits = TypeUnits.POINTS');
    expect(wrapped).toContain('__originalRulerUnits');
    expect(wrapped).toContain('__originalTypeUnits');
  });

  it('suppresses script-command dialogs (displayDialogs = NO) and restores the original (Layer A)', async () => {
    const conn = makeConnection();
    const factory = new PhotoshopAPIFactory(conn.asConnection());
    const api = await factory.createAPI();
    await api.executeScript('return 1;');
    const wrapped = conn.lastScript();
    // Forced off for the duration so missing-font / ICC-mismatch prompts can't
    // block the synchronous transport.
    expect(wrapped).toContain('app.displayDialogs = DialogModes.NO');
    // Captured before and restored in finally so the user's interactive
    // session is unchanged.
    expect(wrapped).toContain('__originalDisplayDialogs = app.displayDialogs');
    expect(wrapped).toContain('app.displayDialogs = __originalDisplayDialogs');
  });

  it('reads the $.__mcp__ side-channel when the script returns nothing', async () => {
    const conn = makeConnection();
    const factory = new PhotoshopAPIFactory(conn.asConnection());
    const api = await factory.createAPI();
    await api.executeScript('return 1;');
    const wrapped = conn.lastScript();
    expect(wrapped).toContain('$.__mcp__');
  });
});

// Empty-PS-error substitution (2026-06-13 session-review fix). The dominant
// live-smoke failure signature was empty error strings ("Error selecting
// layer: " ×34) — PS threw with no message and every tool prefixed its own
// label onto a blank trailer. The substitution lives at this single
// platform-agnostic chokepoint so every tool inherits it.
describe('ExtendScriptPhotoshopAPI empty-error substitution', () => {
  it('substitutes a synthetic message when the connection rejects with an empty error', async () => {
    const conn = makeConnection({ throwOnExecute: new Error('') });
    const api = await new PhotoshopAPIFactory(conn.asConnection()).createAPI();
    await expect(api.executeScript('return 1;')).rejects.toThrow(/empty error/);
    await expect(api.executeScript('return 1;')).rejects.toThrow(/stuck\/modal/);
  });

  it('treats a whitespace-only error message as empty', async () => {
    const conn = makeConnection({ throwOnExecute: new Error('   ') });
    const api = await new PhotoshopAPIFactory(conn.asConnection()).createAPI();
    await expect(api.executeScript('return 1;')).rejects.toThrow(/empty error/);
  });

  it('passes a non-empty PS error through unchanged (no double-wrapping at this layer)', async () => {
    const conn = makeConnection({ throwOnExecute: new Error('layer not found') });
    const api = await new PhotoshopAPIFactory(conn.asConnection()).createAPI();
    await expect(api.executeScript('return 1;')).rejects.toThrow(/^layer not found$/);
  });
});
