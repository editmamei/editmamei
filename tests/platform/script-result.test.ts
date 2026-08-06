import { describe, it, expect } from 'vitest';
import { decodeScriptResult, PhotoshopScriptError } from '@editmamei/platform/script-result.ts';

/**
 * Both platform runners used to carry their own byte-identical copy of this
 * decoding. These cases were duplicated across the two executor test files to
 * match; they live once now, alongside the single implementation.
 */
describe('decodeScriptResult', () => {
  it('parses a JSON payload', () => {
    expect(decodeScriptResult('{"a":1,"b":"two"}')).toEqual({ a: 1, b: 'two' });
  });

  it('parses a JSON payload with nested structure', () => {
    expect(decodeScriptResult('{"layer":"BG","opacity":50}')).toEqual({
      layer: 'BG',
      opacity: 50,
    });
  });

  it('returns the raw string when the payload is not JSON', () => {
    expect(decodeScriptResult('plain text')).toBe('plain text');
  });

  it('trims surrounding whitespace before classifying', () => {
    expect(decodeScriptResult('   {"ok":true}   ')).toEqual({ ok: true });
    expect(() => decodeScriptResult('\n  ERROR: nope  \n')).toThrow(/nope/);
  });

  it('throws when the payload carries the failure marker', () => {
    expect(() => decodeScriptResult('ERROR: bad thing happened')).toThrow(/bad thing happened/);
    expect(() => decodeScriptResult('ERROR: No active document')).toThrow(/No active document/);
  });

  it('throws PhotoshopScriptError specifically, so callers can tell a script failure from a transport one', () => {
    expect(() => decodeScriptResult('ERROR: boom')).toThrow(PhotoshopScriptError);
  });

  it('strips the marker and surrounding whitespace from the thrown message', () => {
    expect(() => decodeScriptResult('ERROR:    spaced out   ')).toThrow(/^spaced out$/);
  });

  it('unwraps a successful envelope to the value the script returned', () => {
    expect(decodeScriptResult('{"__em":1,"ok":true,"value":{"layer":"BG"}}')).toEqual({
      layer: 'BG',
    });
    expect(decodeScriptResult('{"__em":1,"ok":true,"value":42}')).toBe(42);
    expect(decodeScriptResult('{"__em":1,"ok":true,"value":"plain"}')).toBe('plain');
  });

  it('returns a string that begins with the marker intact instead of throwing', () => {
    // This is the defect the envelope exists to fix. Reachable through the
    // scripting escape hatch, where a caller's own value is whatever they
    // returned — previously indistinguishable from a thrown error, and
    // documented to users as a caveat they had to work around.
    const payload = JSON.stringify({ __em: 1, ok: true, value: 'ERROR: not actually an error' });
    expect(decodeScriptResult(payload)).toBe('ERROR: not actually an error');
  });

  it('throws with Photoshop error number and line from a failure envelope', () => {
    const payload = JSON.stringify({
      __em: 1,
      ok: false,
      error: { message: 'no active document', number: 1302, line: 7 },
    });
    try {
      decodeScriptResult(payload);
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as PhotoshopScriptError;
      expect(e).toBeInstanceOf(PhotoshopScriptError);
      expect(e.message).toBe('no active document');
      expect(e.psErrorNumber).toBe(1302);
      expect(e.psLine).toBe(7);
    }
  });

  it('tolerates a failure envelope missing the optional detail', () => {
    try {
      decodeScriptResult('{"__em":1,"ok":false}');
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as PhotoshopScriptError;
      expect(e).toBeInstanceOf(PhotoshopScriptError);
      expect(e.psErrorNumber).toBeNull();
      expect(e.psLine).toBeNull();
    }
  });

  it('passes an untagged object straight through', () => {
    // Scripts sent without the wrapper — the liveness probe is one — still
    // return bare payloads, and must not be mistaken for envelopes.
    expect(decodeScriptResult('{"ok":true,"value":"not ours"}')).toEqual({
      ok: true,
      value: 'not ours',
    });
  });

  it('carries an empty message through rather than inventing one', () => {
    // Photoshop can fail with no description at all. The substitution of a
    // useful message happens one layer up, where there is enough context to
    // say something actionable; this layer must not guess.
    expect(() => decodeScriptResult('ERROR:')).toThrow(PhotoshopScriptError);
    try {
      decodeScriptResult('ERROR:');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toBe('');
    }
  });
});
