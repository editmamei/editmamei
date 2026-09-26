import { describe, it, expect } from 'vitest';
import {
  pickSchemaDeclaredKeys,
  runGimpTool,
  GIMP_IMAGE_PROP,
} from '@editmamei/tools/gimp-shared.ts';
import type { JsonSchemaObject } from '@editmamei/utils/validate.ts';
import { makeGimpBackend } from '../fixtures/fake-gimp-session.ts';

const schema: JsonSchemaObject = {
  type: 'object',
  properties: {
    image: GIMP_IMAGE_PROP,
    radius: { type: 'number' },
  },
  required: ['image'],
};

describe('pickSchemaDeclaredKeys', () => {
  it('keeps only keys the schema declares in properties', () => {
    expect(pickSchemaDeclaredKeys(schema, { image: 1, radius: 5, extra: 'nope' })).toEqual({
      image: 1,
      radius: 5,
    });
  });

  it('drops an undeclared key entirely — it never reaches the output object', () => {
    const out = pickSchemaDeclaredKeys(schema, { image: 1, undeclared_key: 'should not survive' });
    expect(Object.hasOwn(out, 'undeclared_key')).toBe(false);
    expect(out).toEqual({ image: 1 });
  });

  it('returns an empty object for a schema with no properties', () => {
    expect(pickSchemaDeclaredKeys({ type: 'object' }, { image: 1 })).toEqual({});
  });

  it('returns an empty object when args has no declared keys at all', () => {
    expect(pickSchemaDeclaredKeys(schema, { foo: 1, bar: 2 })).toEqual({});
  });
});

describe('runGimpTool — default forwarding drops undeclared keys before the bridge sees them', () => {
  it('an undeclared key on the validated args never appears in the args gimp.call receives', async () => {
    const gimp = makeGimpBackend({ result: { ok: true } });
    await runGimpTool({
      gimp: gimp.asBackend(),
      // validateArgs passes through undeclared keys by design (see
      // gimp-shared.ts's own doc comment on pickSchemaDeclaredKeys) — this
      // rawArgs shape simulates a caller/client attaching one.
      rawArgs: { image: 1, radius: 5, undeclared_key: 'smuggled' },
      schema,
      op: 'some_op',
      errorPrefix: 'Error running test op',
      successText: () => 'done',
    });
    expect(gimp.lastCall()).toEqual({ op: 'some_op', args: { image: 1, radius: 5 } });
    expect(gimp.lastCall().args).not.toHaveProperty('undeclared_key');
  });

  it('a `params` mapper, when given, is used instead — the undeclared-key filter is the default only', async () => {
    const gimp = makeGimpBackend({ result: { ok: true } });
    await runGimpTool({
      gimp: gimp.asBackend(),
      rawArgs: { image: 1, radius: 5 },
      schema,
      op: 'some_op',
      errorPrefix: 'Error running test op',
      params: (args) => ({ img: args.image }),
      successText: () => 'done',
    });
    expect(gimp.lastCall()).toEqual({ op: 'some_op', args: { img: 1 } });
  });
});
