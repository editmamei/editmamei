/**
 * Feature details: the names of the options a tool call used, read from values its own schema
 * declares. A value is recorded only when it exactly matches the schema's `enum`, so nothing a
 * user or assistant typed can get through, however the argument is spelled.
 */

import type { FeatureKind } from './events.js';

export interface FeatureName {
  kind: FeatureKind;
  tool: string;
  name: string;
  value?: string;
}

const MAX_TOKEN_LENGTH = 64;

/** The telemetry server's shape for `name` and `value`. Keep the two identical. */
export const FEATURE_TOKEN_PATTERN =
  /^(?!.*\.(?:psd|psb|jpe?g|png|tiff?|gif|webp|heic|bmp|pdf|svg|raw|dng|arw|cr2|cr3|nef|orf|raf)$)[A-Za-z0-9_$.#-]{1,64}$/i;

/**
 * Fit a name to the server's token shape: `soft light` becomes `soft_light`. One bad token
 * rejects a whole batch, so this runs on every name, listed or not. Null when it can't fit.
 */
export function toFeatureToken(raw: string): string | null {
  const token = raw.replace(/[^A-Za-z0-9_$.#-]+/g, '_').slice(0, MAX_TOKEN_LENGTH);
  return FEATURE_TOKEN_PATTERN.test(token) ? token : null;
}

/** The top-level string arguments whose value the tool's schema lists in an `enum`. */
export function optionValues(
  tool: string,
  inputSchema: unknown,
  args: Record<string, unknown>
): FeatureName[] {
  const properties = (inputSchema as { properties?: unknown } | null | undefined)?.properties;
  if (typeof properties !== 'object' || properties === null) return [];
  const found: FeatureName[] = [];
  for (const [name, spec] of Object.entries(properties as Record<string, unknown>)) {
    const value = args[name];
    if (typeof value !== 'string') continue;
    const allowed = (spec as { enum?: unknown } | null | undefined)?.enum;
    if (!Array.isArray(allowed) || !allowed.includes(value)) continue;
    const nameToken = toFeatureToken(name);
    const valueToken = toFeatureToken(value);
    if (nameToken && valueToken) {
      found.push({ kind: 'option', tool, name: nameToken, value: valueToken });
    }
  }
  return found;
}
