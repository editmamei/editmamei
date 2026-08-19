/**
 * Safe interpolation helpers for ExtendScript template literals.
 *
 * ExtendScript snippets are built by interpolating values from tool args into
 * template strings. Without escaping, a layer name containing a single quote
 * or backslash breaks the script (or worse, lets a malicious value inject
 * arbitrary JSX into the running Photoshop). These helpers route every value
 * through `JSON.stringify`, which produces an ExtendScript-parseable string
 * literal with all special characters escaped.
 *
 * Use `jsLit` for any string position and `jsNum` for any numeric position.
 * Never interpolate raw user input into JSX with `${x}` again.
 */

/**
 * Matches any character outside printable ASCII (space through tilde).
 *
 * Module-scoped and /g, so it carries `lastIndex` state. Only ever passed to
 * `String.prototype.replace`, which resets that state; do NOT call `.test()`
 * on it — that would alternate true/false across calls.
 */
const NON_ASCII = /[^ -~]/g;

/**
 * Render a value as a JSX-safe string literal.
 *
 *   const layerName = 'foo"bar';
 *   const jsx = `layer.name = ${jsLit(layerName)};`;
 *   // → layer.name = "foo\"bar";
 */
export function jsLit(value: unknown): string {
  // Every character outside printable ASCII is re-escaped as \uXXXX. The
  // emitted .jsx is written UTF-8 with no BOM and carries no `#encoding`
  // directive, so ExtendScript decodes it by the platform codepage: a raw 'ü'
  // arrives mojibake and every comparison against it misses. The escape is
  // pure ASCII, survives any codepage, and the JS parser turns it back into
  // the exact character. Astral characters need no special case here — JS
  // strings are UTF-16, so each surrogate half escapes separately and the
  // parser rejoins them; the Go twin, which iterates runes, does need one.
  // JSON.stringify has already escaped the control range, so this only ever
  // rewrites characters it left raw — it cannot double-process an escape.
  //
  // Scope: this covers INTERPOLATED VALUES. A snippet's own source text can
  // still carry raw non-ASCII, which this does not touch.
  //
  // Keep in lockstep with jsLit in go-core/jsx.go — the Go core emits the same
  // literals on its own path and a divergence is invisible until a non-ASCII
  // name reaches one emitter but not the other. The two agree on all valid
  // input; they differ only on malformed UTF-8 / lone surrogates, where Go's
  // encoder substitutes U+FFFD and this one preserves the surrogate.
  // tests/unit/jsx.test.ts and go-core/jsx_test.go carry the same case table.
  return JSON.stringify(String(value)).replace(
    NON_ASCII,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/**
 * Render a value as a JSX-safe number literal.
 *
 * If the value isn't a finite number, the fallback is used. This protects
 * against `args.x as number` returning `NaN` and corrupting downstream JSX.
 *
 *   `layer.opacity = ${jsNum(args.opacity, 100)};`
 */
export function jsNum(value: unknown, fallback: number): string {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? String(n) : String(fallback);
}

/**
 * Render a value as a JSX-safe boolean literal (`true` or `false`).
 * Coerces the string forms `'true'` / `'false'` to match how `jsNum`
 * coerces numeric strings — this keeps the helpers symmetric so a value
 * that survived `validateArgs` (which itself accepts both forms) lands
 * here as a real boolean.
 *
 *   `var locked = ${jsBool(args.locked, false)};`
 */
export function jsBool(value: unknown, fallback: boolean): string {
  if (typeof value === 'boolean') return String(value);
  if (value === 'true') return 'true';
  if (value === 'false') return 'false';
  return String(fallback);
}
