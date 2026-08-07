/**
 * Tests for the JSX-interpolation escape helpers.
 *
 * Every ExtendScript snippet built by Editmamei depends on `jsLit` /
 * `jsNum` / `jsBool` to safely interpolate values from tool args. These
 * helpers are the injection-prevention boundary — adversarial inputs
 * (embedded quotes, line/paragraph separators, NaN coercion, BigInt,
 * Symbol, etc.) MUST land as valid ExtendScript literals or fail
 * deterministically. The indirect coverage via tests/unit/extendscript
 * doesn't enumerate these cases.
 */
import { describe, it, expect } from 'vitest';
import { jsLit, jsNum, jsBool } from '@editmamei/utils/jsx.js';

describe('jsLit', () => {
  it('wraps a plain string in quotes', () => {
    expect(jsLit('hello')).toBe('"hello"');
  });

  it('escapes embedded double quotes', () => {
    expect(jsLit('foo"bar')).toBe('"foo\\"bar"');
  });

  it('escapes backslashes', () => {
    expect(jsLit('C:\\path')).toBe('"C:\\\\path"');
  });

  it('escapes newlines and tabs', () => {
    expect(jsLit('a\nb\tc')).toBe('"a\\nb\\tc"');
  });

  it('escapes carriage returns', () => {
    expect(jsLit('a\rb')).toBe('"a\\rb"');
  });

  it('preserves the empty string as ""', () => {
    expect(jsLit('')).toBe('""');
  });

  it('coerces non-strings via String()', () => {
    expect(jsLit(42)).toBe('"42"');
    expect(jsLit(null)).toBe('"null"');
    expect(jsLit(undefined)).toBe('"undefined"');
    expect(jsLit(true)).toBe('"true"');
  });

  it('round-trips line/paragraph separators through JSON.parse', () => {
    // U+2028 / U+2029 are valid string-literal characters in ECMAScript
    // 2019+ \u2014 both Node JS and ExtendScript accept them inside string
    // literals. JSON.stringify is allowed to emit them either as raw
    // chars or as \\u escapes; the contract we care about is that the
    // literal round-trips and that interpolation can't break out of the
    // string.
    const LS = '\u2028';
    const PS = '\u2029';
    const input = `a${LS}b${PS}c`;
    const out = jsLit(input);
    expect(JSON.parse(out)).toBe(input);
  });

  it('handles NUL bytes via the standard JSON escape', () => {
    const out = jsLit('a\x00b');
    expect(JSON.parse(out)).toBe('a\x00b');
  });

  it('handles long strings without truncation', () => {
    const longStr = 'x'.repeat(10_000);
    const out = jsLit(longStr);
    expect(JSON.parse(out)).toBe(longStr);
  });
});

describe('jsNum', () => {
  it('passes finite numbers through', () => {
    expect(jsNum(3.14, 0)).toBe('3.14');
    expect(jsNum(-7, 0)).toBe('-7');
    expect(jsNum(0, 99)).toBe('0');
  });

  it('coerces numeric strings', () => {
    expect(jsNum('42', 0)).toBe('42');
  });

  it('falls back on NaN', () => {
    expect(jsNum(NaN, 99)).toBe('99');
    expect(jsNum('not a number', 12)).toBe('12');
  });

  it('falls back on Infinity / -Infinity', () => {
    expect(jsNum(Infinity, 5)).toBe('5');
    expect(jsNum(-Infinity, 5)).toBe('5');
  });

  it('coerces / falls back per Number()-cast semantics', () => {
    // jsNum's contract is "finite number passes through, else fallback."
    // The cast-to-number step lands per JS Number() semantics: Number(null)
    // is 0 and Number([]) is 0 — both finite, both pass through as '0'.
    // Number(undefined) and Number({}) are NaN — both hit the fallback.
    expect(jsNum(null, 1)).toBe('0');
    expect(jsNum([], 1)).toBe('0');
    expect(jsNum(undefined, 1)).toBe('1');
    expect(jsNum({}, 1)).toBe('1');
  });

  it('never returns a value with embedded characters that would break JSX', () => {
    // Synthesize a few adversarial inputs and verify the output is
    // a plain numeric literal.
    const bad = ['1; alert(1)', '1)//hack', '"; x = 1; "'];
    for (const input of bad) {
      const out = jsNum(input, 0);
      expect(out).toMatch(/^-?\d+(\.\d+)?$/);
    }
  });
});

describe('jsBool', () => {
  it('emits the canonical boolean literal', () => {
    expect(jsBool(true, false)).toBe('true');
    expect(jsBool(false, true)).toBe('false');
  });

  it('coerces "true" / "false" strings', () => {
    expect(jsBool('true', false)).toBe('true');
    expect(jsBool('false', true)).toBe('false');
  });

  it('falls back for any other value', () => {
    expect(jsBool(undefined, true)).toBe('true');
    expect(jsBool(null, false)).toBe('false');
    expect(jsBool(0, false)).toBe('false');
    expect(jsBool(1, false)).toBe('false');
    expect(jsBool('yes', false)).toBe('false');
    expect(jsBool({}, true)).toBe('true');
  });
});
