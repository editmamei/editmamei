/**
 * Escape-hatch script wrapping — `wrapCustomScript`.
 *
 * This is the transform behind `ps_execute_script`: it takes the
 * caller's ARBITRARY ExtendScript and normalizes its return value so the
 * `wrapInErrorHandling` wrapper in photoshop-api.ts can capture it.
 *
 * It deliberately lives in the TS layer (NOT the sealed Go snippet core).
 * The Go core owns reproducible snippet IP; this transforms user-provided
 * code and carries no IP to seal — it's generic plumbing, the same class as
 * `wrapInErrorHandling`. Relocated here from `ExtendScriptSnippets` (Go
 * sidecar Phase 3) so it survives the eventual deletion of
 * `src/api/extendscript/*`. The two lexer helpers it depends on came with it.
 *
 * Four return-value patterns are supported (the wrapper handles them all):
 *
 *   1. Top-level return (preferred for multi-statement scripts):
 *        var doc = app.activeDocument;
 *        return { name: doc.name };
 *
 *   2. Bare trailing expression (REPL-style; auto-wrapped here):
 *        var doc = app.activeDocument;
 *        "OK: " + doc.name;
 *        // → 'OK: foo' instead of 'undefined'
 *
 *   3. IIFE expression (auto-wrapped):
 *        (function () { ...; return X; })();
 *
 *   4. Side-channel anywhere, including nested IIFEs:
 *        $.__mcp__ = { name: doc.name };
 */
export function wrapCustomScript(code: string): string {
  const original = code;
  const trimmed = code.trim().replace(/;+\s*$/, '');
  if (trimmed.length === 0) return code;

  // Pattern A: single-statement IIFE — `(function(){...})()` or
  // `(function name(){...})()` — wrap the whole thing in `return ...;`.
  if (/^\(\s*function\b/.test(trimmed) && /\)\s*$/.test(trimmed)) {
    return `return ${trimmed};`;
  }

  // Pattern B: bare trailing expression. Detect by checking the LAST
  // statement of the script — if it looks like an expression that
  // doesn't already start with `return`, wrap it via a closure so the
  // caller can capture its value. We use a closure rather than direct
  // `return` because the trailing expression may follow other statements
  // that wouldn't compile inside a return.
  //
  // Heuristic: take the substring after the last top-level `;` or `}`.
  // If it's non-empty AND doesn't start with a reserved word like
  // return/throw/var/function/if/for/while/try/switch/{/}, treat it as
  // a trailing expression.
  const lastSemi = findLastTopLevelSeparator(trimmed);
  const tail = (lastSemi >= 0 ? trimmed.slice(lastSemi + 1) : trimmed).trim();

  // Strip leading comments and whitespace from the tail before the
  // reserved-word check. A script like
  //   var x = 1;
  //   // explanation
  //   return "ok";
  // has its tail starting with `// explanation\nreturn "ok"`, which the
  // raw regex misses because comments aren't in the reserved-word list.
  // We then wrap as `return (// explanation\nreturn "ok");`, which is
  // both syntactically broken (extra `)`) and semantically wrong (the
  // user's own `return` is what they wanted to use).
  const tailContent = stripLeadingCommentsAndWhitespace(tail);
  const tailStartsWithReserved =
    /^(return|throw|var|let|const|function|if|for|while|do|try|switch|with|else|catch|finally|case|default|break|continue|new|delete|typeof|void|in|of|class)\b/.test(
      tailContent
    ) || /^[{}]/.test(tailContent);
  if (tailContent.length > 0 && !tailStartsWithReserved) {
    const prefix = lastSemi >= 0 ? trimmed.slice(0, lastSemi + 1) : '';
    // Wrap so the trailing expression is returned. The prefix runs as
    // statements; the tail becomes the return value.
    return `${prefix}\nreturn (${tail});`;
  }

  return original;
}

/**
 * Find the last top-level `;` or `}` character in a string, skipping over
 * any inside string literals, line comments, block comments, or braces of
 * inner scopes. Used by wrapCustomScript's auto-wrap heuristic to identify
 * the start of a trailing bare-expression statement.
 *
 * Tracks depth for {} () [] and stays inside ' ' " " string literals.
 * Skips `// ... \n` line comments and slash-star block comments so a
 * stray `;` inside a comment doesn't fool the heuristic.
 *
 * NOT handled (acceptable for this trust model):
 *   - Template literals (backticks): ExtendScript predates ES6, so they
 *     can't appear in valid user scripts.
 *   - Regex literals: same — and disambiguating `/` as division vs regex
 *     start is non-trivial. If a script paste fools the heuristic it
 *     produces a syntax error returned to the same trusted caller, not
 *     a privilege issue.
 */
export function findLastTopLevelSeparator(s: string): number {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;
  let lastSep = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = i + 1 < s.length ? s[i + 1] : '';
    if (escape) {
      escape = false;
      continue;
    }
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++; // consume the '/'
      }
      continue;
    }
    if (inStr) {
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === inStr) {
        inStr = null;
      }
      continue;
    }
    // Comment starts (only outside strings)
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
      // A closing `}` at top level terminates a statement (e.g. `if {} `)
      if (depth === 0 && c === '}') lastSep = i;
      continue;
    }
    if (depth === 0 && c === ';') lastSep = i;
  }
  return lastSep;
}

/**
 * Strip leading whitespace, line comments (// …), and block comments
 * (slash-star) from the head of a string. Used by wrapCustomScript's
 * Pattern B reserved-word check so a tail starting with a comment line
 * doesn't bypass the `return`/`throw`/etc. detection.
 *
 * Bug history: without this, a script ending in:
 *     var x = 1;
 *     // explanation
 *     return "ok";
 * would be detected as having a non-reserved tail and miswrapped as
 * `return (// explanation\nreturn "ok");` — producing an "Illegal use
 * of reserved word 'return'" error. See Bug E in the 2026-05-30 cross-
 * platform analysis doc.
 */
export function stripLeadingCommentsAndWhitespace(s: string): string {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = i + 1 < s.length ? s[i + 1] : '';
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      // Line comment — skip to next newline or end of string.
      i += 2;
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      // Block comment — skip to closing `*/` or end of string.
      i += 2;
      while (i < s.length) {
        if (s[i] === '*' && s[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    break;
  }
  return s.slice(i);
}
