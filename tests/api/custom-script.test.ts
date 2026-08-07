import { describe, it, expect } from 'vitest';
import {
  wrapCustomScript,
  findLastTopLevelSeparator,
  stripLeadingCommentsAndWhitespace,
} from '@editmamei/api/custom-script.ts';

// wrapCustomScript is the escape-hatch (ps_execute_script) transform —
// relocated out of ExtendScriptSnippets in Go sidecar Phase 3 because it
// transforms USER code and carries no snippet IP. These cases moved verbatim
// from tests/unit/extendscript.test.ts.
describe('wrapCustomScript', () => {
  it('passes through a script with explicit top-level return unchanged', () => {
    const inner = 'var x = 42; return x;';
    expect(wrapCustomScript(inner)).toBe(inner);
  });

  it('auto-wraps a bare single-statement IIFE expression', () => {
    const inner = '(function(){ return 5; })()';
    expect(wrapCustomScript(inner)).toBe(`return ${inner};`);
  });

  it('auto-wraps a bare trailing expression after multiple statements', () => {
    // The bug observed in real sessions: user wrote `try{...; "OK"} catch{...}`
    // and got `undefined` back because bare strings aren't returned.
    const inner = 'var doc = app.activeDocument;\n"OK: " + doc.name;';
    const out = wrapCustomScript(inner);
    expect(out).toContain('var doc = app.activeDocument;');
    expect(out).toContain('return ("OK: " + doc.name);');
  });

  it('does NOT auto-wrap when the trailing statement starts with a reserved word', () => {
    const inner = 'var x = 1; throw new Error("nope");';
    const out = wrapCustomScript(inner);
    // No `return (...)` wrap added — throw is a statement, not an expression
    expect(out).not.toContain('return (throw');
  });

  it('does NOT auto-wrap a try/catch block (its trailing brace is a statement)', () => {
    const inner = 'try { var x = 1; } catch (e) { var y = 2; }';
    expect(wrapCustomScript(inner)).toBe(inner);
  });

  it('handles trailing expression with semicolons inside strings', () => {
    const inner = 'var doc = app.activeDocument; "name; " + doc.name';
    expect(wrapCustomScript(inner)).toContain('return ("name; " + doc.name);');
  });

  it('skips line comments — a `;` inside `// ...` does not fool the heuristic', () => {
    const inner = 'var x = 1; // note ; here\n"OK"';
    const out = wrapCustomScript(inner);
    // The `;` after `1` is the real separator; the one in the comment is skipped.
    expect(out).toContain('return (');
    expect(out).toContain('"OK"');
  });

  it('skips block comments — a `;` inside `/* ... */` does not fool the heuristic', () => {
    const inner = 'var x = 1; /* contains ; semicolon */ "TAIL"';
    const out = wrapCustomScript(inner);
    expect(out).toContain('return (');
    expect(out).toContain('"TAIL"');
  });

  // ===========================================================================
  // Bug E — tail starting with a comment must not bypass the reserved-word
  // check when the FIRST non-comment token is `return`.
  // ===========================================================================
  it('does NOT wrap when the tail starts with a line comment followed by `return`', () => {
    const inner =
      'var doc = app.activeDocument;\n// explanation\nreturn "placeholder layers removed";';
    const out = wrapCustomScript(inner);
    // Must NOT produce `return (... return ...);`
    expect(out).not.toMatch(/return \([\s\S]*return /);
    // No stray closing paren introduced.
    expect(out).not.toContain('");');
  });

  it('does NOT wrap when the tail starts with a block comment followed by `return`', () => {
    const inner = 'var x = 1;\n/* note */\nreturn x;';
    expect(wrapCustomScript(inner)).not.toMatch(/return \([\s\S]*return /);
  });

  it('does NOT wrap when the tail starts with multiple comments before `return`', () => {
    const inner = 'var x = 1;\n// first\n// second\n/* third */\nreturn x;';
    expect(wrapCustomScript(inner)).not.toMatch(/return \([\s\S]*return /);
  });

  it('still wraps a tail starting with a comment followed by a bare expression', () => {
    // The fix must not over-correct: if the *first non-comment token* is
    // really an expression (not a reserved word), we should still wrap so
    // the bare expression's value is captured.
    const inner = 'var x = 1;\n// docstring\n"OK"';
    const out = wrapCustomScript(inner);
    expect(out).toContain('return (');
    expect(out).toContain('"OK"');
  });

  // ===========================================================================
  // Adversarial cases (audit M5) — pin the heuristic parser on this trust
  // boundary so a future refactor can't silently regress its return semantics.
  // ===========================================================================
  it('wraps a trailing expression that follows a block comment', () => {
    // Tail = `<block comment>\n"DONE"`. The first non-comment token is a
    // string literal (an expression), so it must still be wrapped.
    const inner = 'var doc = app.activeDocument;\n/* compute the label */\n"DONE: " + doc.name';
    const out = wrapCustomScript(inner);
    expect(out).toContain('var doc = app.activeDocument;');
    expect(out).toContain('return (');
    expect(out).toContain('"DONE: " + doc.name');
    // The user's own statements run before the return; no stray inner return.
    expect(out).not.toMatch(/return \([\s\S]*return /);
  });

  it('detects an IIFE with a named function expression', () => {
    const inner = '(function build(){ var x = 1; return x; })()';
    expect(wrapCustomScript(inner)).toBe(`return ${inner};`);
  });

  it('detects an IIFE even with leading whitespace inside the parens', () => {
    const inner = '( function () { return 7; } )()';
    expect(wrapCustomScript(inner)).toBe(`return ${inner};`);
  });

  it('does NOT wrap a script whose tail is an unbalanced/unterminated brace', () => {
    // `var x = { a: 1` never closes its `{`, so there is no top-level
    // separator and the whole script is the tail. It starts with the
    // reserved word `var`, so it is left untouched (no syntactic damage).
    const inner = 'var x = { a: 1';
    expect(wrapCustomScript(inner)).toBe(inner);
  });

  it('wraps ONLY the last of multiple top-level statements', () => {
    const inner = 'var a = 1;\nvar b = 2;\na + b';
    const out = wrapCustomScript(inner);
    // The two declarations run as statements; only the final expression is
    // returned — exactly one `return (` is introduced.
    expect(out).toContain('var a = 1;');
    expect(out).toContain('var b = 2;');
    expect(out).toContain('return (a + b);');
    expect(out.match(/return \(/g)?.length).toBe(1);
  });

  it('strips both leading line and block comments before the reserved-word check', () => {
    // Combined comment kinds ahead of a bare expression — still wrapped.
    const inner = 'var x = 1;\n// line note\n/* block note */\n"TAIL"';
    const out = wrapCustomScript(inner);
    expect(out).toContain('return (');
    expect(out).toContain('"TAIL"');
  });

  it('wraps a bare expression but passes a bare statement through unchanged', () => {
    // A lone bare expression (no preceding statements) is captured — the
    // prefix is empty, so only the `return (...)` line is emitted.
    expect(wrapCustomScript('app.activeDocument.name')).toBe('\nreturn (app.activeDocument.name);');
    // ...but a statement leading with a reserved word is NOT wrapped.
    expect(wrapCustomScript('var only = 1;')).toBe('var only = 1;');
  });
});

// findLastTopLevelSeparator + stripLeadingCommentsAndWhitespace are the two
// lexer helpers wrapCustomScript depends on. Exercising them directly pins the
// scanning contract independently of the wrapper's branching.
describe('findLastTopLevelSeparator', () => {
  it('returns the index of the last top-level semicolon', () => {
    const s = 'var a = 1; var b = 2;';
    expect(findLastTopLevelSeparator(s)).toBe(s.lastIndexOf(';'));
  });

  it('returns the index of a top-level closing brace as a separator', () => {
    const s = 'if (a) { b(); }';
    // The final `}` returns depth to 0 and is treated as a statement end.
    expect(findLastTopLevelSeparator(s)).toBe(s.length - 1);
  });

  it('ignores semicolons nested inside braces', () => {
    const s = 'function f(){ a(); b(); }';
    // The inner `;` are at depth > 0; the trailing `}` is the only top-level
    // separator.
    expect(findLastTopLevelSeparator(s)).toBe(s.length - 1);
  });

  it('ignores a semicolon inside a string literal', () => {
    const s = 'var msg = "a; b; c"';
    expect(findLastTopLevelSeparator(s)).toBe(-1);
  });

  it('ignores a semicolon inside a line comment', () => {
    const s = 'var x = 1 // a ; b\n';
    expect(findLastTopLevelSeparator(s)).toBe(-1);
  });

  it('ignores a semicolon inside a block comment', () => {
    const s = 'var x = 1 /* a ; b */';
    expect(findLastTopLevelSeparator(s)).toBe(-1);
  });

  it('respects an escaped quote inside a string before a real separator', () => {
    // The `\"` does not close the string; the `;` after it is inside the
    // string and ignored, leaving only the trailing top-level `;`.
    const s = 'var q = "she said \\"hi;\\""; ok';
    expect(findLastTopLevelSeparator(s)).toBe(s.indexOf('; ok'));
  });

  it('returns -1 when there is no top-level separator', () => {
    expect(findLastTopLevelSeparator('a + b')).toBe(-1);
  });
});

describe('stripLeadingCommentsAndWhitespace', () => {
  it('strips leading whitespace', () => {
    expect(stripLeadingCommentsAndWhitespace('   \n\t"x"')).toBe('"x"');
  });

  it('strips a leading line comment', () => {
    expect(stripLeadingCommentsAndWhitespace('// note\nreturn x;')).toBe('return x;');
  });

  it('strips a leading block comment', () => {
    expect(stripLeadingCommentsAndWhitespace('/* note */ value')).toBe('value');
  });

  it('strips a run of mixed comments and whitespace', () => {
    expect(stripLeadingCommentsAndWhitespace('\n// a\n /* b */\n// c\n"DONE"')).toBe('"DONE"');
  });

  it('leaves a string that has no leading comment untouched', () => {
    expect(stripLeadingCommentsAndWhitespace('return x;')).toBe('return x;');
  });

  it('handles an unterminated block comment by consuming to end of string', () => {
    expect(stripLeadingCommentsAndWhitespace('/* never closed')).toBe('');
  });
});
