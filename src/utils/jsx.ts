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
 * Render a value as a JSX-safe string literal.
 *
 *   const layerName = 'foo"bar';
 *   const jsx = `layer.name = ${jsLit(layerName)};`;
 *   // → layer.name = "foo\"bar";
 */
export function jsLit(value: unknown): string {
  return JSON.stringify(String(value));
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
