/**
 * Runtime argument validation for tool handlers.
 *
 * The raw MCP `Server` class does NOT enforce `inputSchema` at runtime — the
 * declared schema is advisory and only the LLM uses it. Without runtime
 * validation, every `args.x as number` cast is a silent type bug waiting to
 * happen, and a malformed (or malicious) value lands in an ExtendScript
 * template literal and executes as code.
 *
 * This validator reads the same JSON Schema object that's already declared
 * on each tool, validates `args`, coerces obvious mismatches (numeric
 * strings, boolean strings), applies declared `default:` values, and
 * rejects anything outside the schema's `enum` / `minimum` / `maximum`
 * bounds. The output is a fully-typed `Record<string, unknown>` that
 * handlers can safely read without further casts.
 *
 * Design notes:
 * - Hand-rolled, no runtime dep — Editmamei's single runtime dep is the MCP
 *   SDK. Adding Zod just for this is overkill.
 * - Only handles the JSON Schema features actually used in this codebase:
 *   primitive types, enums, minimum/maximum, required, default, and the
 *   nested object case (currently only `add_layer_style.color`).
 * - Errors are thrown — tool handlers catch them via the standard try/catch
 *   pattern and return `isError: true`.
 */

export interface JsonSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: readonly string[] | readonly number[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  // For array types — schema-only, currently advisory. The validator does
  // not recursively check array elements; handlers that care must enforce
  // element shape themselves (e.g. metadata-tools' parseSections).
  items?: JsonSchemaProperty;
  // Array length bounds — schema-only/advisory (documents the constraint for
  // the LLM; the validator does not enforce them, handlers do).
  minItems?: number;
  maxItems?: number;
}

export interface JsonSchemaObject {
  // Index signature so this type is assignable to the MCP SDK's
  // `Tool['inputSchema']`, which declares `[x: string]: unknown`.
  [k: string]: unknown;
  type: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validate and coerce `args` against `schema`. Throws ValidationError on
 * any violation. Returns a new object with defaults applied and string
 * numerics coerced.
 */
export function validateArgs(
  schema: JsonSchemaObject,
  args: Record<string, unknown> | undefined
): Record<string, unknown> {
  const input = args ?? {};
  const out: Record<string, unknown> = {};
  const props = schema.properties ?? {};

  // Apply schema-declared properties (including defaults)
  for (const [key, propSchema] of Object.entries(props)) {
    const raw = input[key];
    if (raw === undefined || raw === null) {
      if (propSchema.default !== undefined) {
        out[key] = propSchema.default;
      }
      continue;
    }
    out[key] = coerceAndCheck(key, raw, propSchema);
  }

  // Required check (after defaults applied)
  for (const requiredKey of schema.required ?? []) {
    if (out[requiredKey] === undefined) {
      throw new ValidationError(`Missing required argument: ${requiredKey}`);
    }
  }

  // Pass through any extra keys not in the schema (don't strictly reject —
  // the MCP client may attach metadata; just don't validate or coerce them).
  //
  // Prototype-pollution guard: `__proto__` / `constructor` / `prototype` as
  // keys would mutate the output object's prototype chain rather than
  // landing as own properties. The MCP client is treated as trusted, but
  // the trust boundary should never be the only thing standing between a
  // polluted args bag and downstream handlers — so we drop these keys
  // unconditionally. The same filter applies inside `coerceAndCheck`'s
  // nested-object branch.
  for (const [key, value] of Object.entries(input)) {
    if (POLLUTION_KEYS.has(key)) continue;
    if (!(key in props) && value !== undefined && value !== null) {
      out[key] = value;
    }
  }

  return out;
}

/**
 * Object keys that JavaScript treats specially when set via bracket
 * assignment (`obj[key] = x`) — they mutate the prototype chain rather
 * than landing as own properties. Filtered at every pass-through point.
 */
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function coerceAndCheck(key: string, value: unknown, schema: JsonSchemaProperty): unknown {
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') {
        throw new ValidationError(`Expected string for "${key}", got ${typeof value}`);
      }
      if (schema.enum && !schema.enum.includes(value as never)) {
        throw new ValidationError(
          `Invalid value for "${key}": ${JSON.stringify(value)}. Allowed: ${schema.enum.join(', ')}`
        );
      }
      return value;
    }

    case 'integer':
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) {
        throw new ValidationError(`Expected number for "${key}", got ${JSON.stringify(value)}`);
      }
      if (schema.type === 'integer' && !Number.isInteger(n)) {
        throw new ValidationError(`Expected integer for "${key}", got ${n}`);
      }
      if (schema.minimum !== undefined && n < schema.minimum) {
        throw new ValidationError(`"${key}" must be ≥ ${schema.minimum}, got ${n}`);
      }
      if (schema.maximum !== undefined && n > schema.maximum) {
        throw new ValidationError(`"${key}" must be ≤ ${schema.maximum}, got ${n}`);
      }
      if (schema.enum && !(schema.enum as readonly number[]).includes(n)) {
        throw new ValidationError(
          `Invalid value for "${key}": ${n}. Allowed: ${schema.enum.join(', ')}`
        );
      }
      return n;
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new ValidationError(`Expected boolean for "${key}", got ${JSON.stringify(value)}`);
    }

    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ValidationError(`Expected object for "${key}", got ${typeof value}`);
      }
      if (schema.properties) {
        const nested = value as Record<string, unknown>;
        // `nestedOut` (renamed from `out` to avoid shadowing the outer
        // `validateArgs` accumulator) collects the validated nested fields.
        const nestedOut: Record<string, unknown> = {};
        for (const [k, ps] of Object.entries(schema.properties)) {
          if (POLLUTION_KEYS.has(k)) continue;
          const raw = nested[k];
          if (raw === undefined || raw === null) {
            if (ps.default !== undefined) nestedOut[k] = ps.default;
            continue;
          }
          nestedOut[k] = coerceAndCheck(`${key}.${k}`, raw, ps);
        }
        for (const reqKey of schema.required ?? []) {
          if (nestedOut[reqKey] === undefined) {
            throw new ValidationError(`Missing required argument: ${key}.${reqKey}`);
          }
        }
        return nestedOut;
      }
      return value;
    }

    case 'array':
      if (!Array.isArray(value)) {
        throw new ValidationError(`Expected array for "${key}", got ${typeof value}`);
      }
      return value;

    default:
      return value;
  }
}
