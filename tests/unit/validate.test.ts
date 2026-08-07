/**
 * Tests for the input-validation seam used by every tool handler.
 *
 * `validateArgs` is the trust boundary between MCP-client-provided
 * arguments and the ExtendScript snippets they parameterize. Edge-case
 * regressions here would let malformed or hostile values reach
 * `jsLit`/`jsNum`/`jsBool` interpolation points, so we pin the contract
 * explicitly rather than relying on the indirect coverage from
 * tests/tools/*.
 */
import { describe, it, expect } from 'vitest';
import { validateArgs, ValidationError, type JsonSchemaObject } from '@editmamei/utils/validate.js';

describe('validateArgs', () => {
  describe('defaults', () => {
    it('applies default when key is missing', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'number', default: 42 } },
      };
      expect(validateArgs(schema, {})).toEqual({ x: 42 });
    });

    it('applies default when key is null', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'number', default: 7 } },
      };
      expect(validateArgs(schema, { x: null })).toEqual({ x: 7 });
    });

    it('does not apply default when explicit value is present', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'number', default: 1 } },
      };
      expect(validateArgs(schema, { x: 5 })).toEqual({ x: 5 });
    });

    it('preserves a default of false (falsy but not nullish)', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { flag: { type: 'boolean', default: false } },
      };
      expect(validateArgs(schema, {})).toEqual({ flag: false });
    });
  });

  describe('required', () => {
    it('throws if a required key is missing', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'string' } },
        required: ['x'],
      };
      expect(() => validateArgs(schema, {})).toThrow(ValidationError);
    });

    it('is satisfied when default supplies the value', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'string', default: 'fallback' } },
        required: ['x'],
      };
      expect(validateArgs(schema, {})).toEqual({ x: 'fallback' });
    });
  });

  describe('string coercion + enum', () => {
    it('passes a plain string through', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'string' } },
      };
      expect(validateArgs(schema, { x: 'hello' })).toEqual({ x: 'hello' });
    });

    it('rejects non-string for type=string', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'string' } },
      };
      expect(() => validateArgs(schema, { x: 42 })).toThrow(/Expected string/);
    });

    it('enforces string enum', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'string', enum: ['a', 'b'] } },
      };
      expect(validateArgs(schema, { x: 'a' })).toEqual({ x: 'a' });
      expect(() => validateArgs(schema, { x: 'c' })).toThrow(/Allowed: a, b/);
    });
  });

  describe('number coercion', () => {
    it('coerces numeric strings', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'number' } },
      };
      expect(validateArgs(schema, { x: '3.14' })).toEqual({ x: 3.14 });
    });

    it('rejects NaN', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'number' } },
      };
      expect(() => validateArgs(schema, { x: 'not-a-number' })).toThrow(/Expected number/);
    });

    it('rejects Infinity', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'number' } },
      };
      expect(() => validateArgs(schema, { x: Infinity })).toThrow(/Expected number/);
    });

    it('rejects non-integer for type=integer', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'integer' } },
      };
      expect(() => validateArgs(schema, { x: 1.5 })).toThrow(/Expected integer/);
    });

    it('enforces minimum / maximum', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'number', minimum: 0, maximum: 10 } },
      };
      expect(() => validateArgs(schema, { x: -1 })).toThrow(/must be ≥ 0/);
      expect(() => validateArgs(schema, { x: 11 })).toThrow(/must be ≤ 10/);
      expect(validateArgs(schema, { x: 5 })).toEqual({ x: 5 });
    });
  });

  describe('boolean coercion', () => {
    it('accepts real booleans', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { f: { type: 'boolean' } },
      };
      expect(validateArgs(schema, { f: true })).toEqual({ f: true });
      expect(validateArgs(schema, { f: false })).toEqual({ f: false });
    });

    it('coerces "true" / "false" strings', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { f: { type: 'boolean' } },
      };
      expect(validateArgs(schema, { f: 'true' })).toEqual({ f: true });
      expect(validateArgs(schema, { f: 'false' })).toEqual({ f: false });
    });

    it('rejects other strings + numbers', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { f: { type: 'boolean' } },
      };
      expect(() => validateArgs(schema, { f: 'yes' })).toThrow(/Expected boolean/);
      expect(() => validateArgs(schema, { f: 1 })).toThrow(/Expected boolean/);
    });
  });

  describe('nested object', () => {
    const schema: JsonSchemaObject = {
      type: 'object',
      properties: {
        color: {
          type: 'object',
          properties: {
            r: { type: 'integer', minimum: 0, maximum: 255 },
            g: { type: 'integer', minimum: 0, maximum: 255, default: 0 },
            b: { type: 'integer', minimum: 0, maximum: 255, default: 0 },
          },
          required: ['r'],
        },
      },
    };

    it('validates inner fields and applies inner defaults', () => {
      expect(validateArgs(schema, { color: { r: 200 } })).toEqual({
        color: { r: 200, g: 0, b: 0 },
      });
    });

    it('enforces inner required keys when the value is absent and no default applies', () => {
      expect(() => validateArgs(schema, { color: { g: 1 } })).toThrow(/color\.r/);
    });

    it('rejects array masquerading as object', () => {
      expect(() => validateArgs(schema, { color: [255, 0, 0] })).toThrow(/Expected object/);
    });
  });

  describe('extra-keys pass-through + prototype-pollution guard', () => {
    it('passes through keys not declared in schema', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'number', default: 1 } },
      };
      const result = validateArgs(schema, { x: 2, _meta: { source: 'tests' } });
      expect(result).toEqual({ x: 2, _meta: { source: 'tests' } });
    });

    it('drops __proto__ from extra-keys pass-through', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'number', default: 1 } },
      };
      const result = validateArgs(schema, {
        x: 2,
        __proto__: { polluted: true },
      } as Record<string, unknown>);
      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
      // The polluted prototype must not leak through as an inherited property.
      expect((result as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('drops constructor + prototype from extra-keys pass-through', () => {
      const schema: JsonSchemaObject = { type: 'object', properties: {} };
      const result = validateArgs(schema, {
        constructor: { evil: true },
        prototype: { evil: true },
      });
      expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
    });

    it('drops pollution keys from nested object validation', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: {
          color: {
            type: 'object',
            properties: {
              r: { type: 'integer', default: 0 },
              __proto__: { type: 'object' },
            },
          },
        },
      };
      const result = validateArgs(schema, {
        color: { r: 10, __proto__: { polluted: true } },
      } as Record<string, unknown>);
      const color = (result.color as Record<string, unknown>) ?? {};
      expect(Object.prototype.hasOwnProperty.call(color, '__proto__')).toBe(false);
      expect((color as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('undefined args input', () => {
    it('treats undefined as an empty bag, applying defaults', () => {
      const schema: JsonSchemaObject = {
        type: 'object',
        properties: { x: { type: 'number', default: 9 } },
      };
      expect(validateArgs(schema, undefined)).toEqual({ x: 9 });
    });
  });
});
