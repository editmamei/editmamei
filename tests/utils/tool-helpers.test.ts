import { describe, it, expect } from 'vitest';
import {
  toolErrorResult,
  runSnippetTool,
  applyToActiveLayerProp,
} from '@editmamei/utils/tool-helpers.ts';
import type { JsonSchemaObject } from '@editmamei/utils/validate.ts';
import type { SnippetClient } from '@editmamei/api/snippet-client.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';

/**
 * Audit finding 9: these three helpers replace the 148 hand-copied catch
 * tails, the 119-way validate→build→runScript→return stereotype, and the
 * 8 divergent auto-duplicate contract declarations. The tests pin the
 * contracts the call sites now rely on.
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === 'text');
  return block?.text ?? '';
}

/** Stub snippet client that renders a recognizable body. */
function makeSnippetClient(): SnippetClient & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    async build(name: string, params?: Record<string, unknown>): Promise<string> {
      calls.push([name, params]);
      return `SNIPPET(${name}, ${JSON.stringify(params ?? {})})`;
    },
  };
}

describe('toolErrorResult — the single catch tail', () => {
  it('extracts Error messages and preserves the site prefix exactly', () => {
    const r = toolErrorResult('Error applying equalize', new Error('boom'));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('Error applying equalize: boom');
  });

  it('stringifies non-Error throwables', () => {
    const r = toolErrorResult('Failed to create layer', 'raw string failure');
    expect(textOf(r)).toBe('Failed to create layer: raw string failure');
  });

  it('appends the pending-state hint when the message looks modal/stuck', () => {
    const r = toolErrorResult('Error rendering preview', new Error('A dialog is open in PS'));
    expect(textOf(r)).toContain('Error rendering preview: A dialog is open in PS');
    expect(textOf(r)).toContain('Commit or cancel it in Photoshop and retry.');
  });

  it('adds no hint on ordinary failures', () => {
    const r = toolErrorResult('Error applying blur', new Error('boom'));
    expect(textOf(r)).toBe('Error applying blur: boom');
  });

  it('adds no hint on realistic non-modal messages', () => {
    // These are the everyday failures the pending-state regex must NOT match
    // now that it applies to every tool (QA 2026-07-30 #3).
    const noDoc = toolErrorResult('Error applying blur', new Error('No active document'));
    expect(textOf(noDoc)).toBe('Error applying blur: No active document');
    // The wording the snippet library actually throws today. Its predecessor
    // did not contain "is open", so unifying the guard silently began matching
    // the regex and stapled pending-state advice onto the most common first-run
    // error in the product — telling users to cancel an operation when what
    // they needed was to open a document. Caught live, not by the golden files,
    // because every scenario runs with a document already open.
    const noDocCurrent = toolErrorResult(
      'Error reading histogram',
      new Error('No document is open in Photoshop')
    );
    expect(textOf(noDocCurrent)).toBe('Error reading histogram: No document is open in Photoshop');
    expect(textOf(noDocCurrent)).not.toContain('Commit or cancel it in Photoshop');
    const noLayer = toolErrorResult(
      'Error selecting layer',
      new Error('Layer "Background copy" not found')
    );
    expect(textOf(noLayer)).toBe('Error selecting layer: Layer "Background copy" not found');
    // "commit" alone no longer triggers the hint (dropped from the regex).
    const commitMsg = toolErrorResult(
      'Error saving',
      new Error('Could not commit the transaction')
    );
    expect(textOf(commitMsg)).toBe('Error saving: Could not commit the transaction');
  });

  it('separates the hint from a message that has no terminal punctuation', () => {
    // Photoshop's messages mostly arrive unpunctuated, and the hint is a
    // sentence; without a separator the two ran together into one line.
    const r = toolErrorResult('Error rendering preview', new Error('A dialog is open in PS'));
    expect(textOf(r)).toContain('A dialog is open in PS. This usually means');
  });

  it('does not double the punctuation when the message already ends in some', () => {
    const r = toolErrorResult('Error rendering preview', new Error('A dialog is open in PS.'));
    expect(textOf(r)).toContain('A dialog is open in PS. This usually means');
    expect(textOf(r)).not.toContain('PS.. This usually');
  });

  it('still recognizes a genuinely stuck Photoshop after the narrowing', () => {
    // The narrowing must not cost real matches — these are what the hint is for.
    for (const msg of [
      'A dialog is open in PS',
      'An operation is currently in progress',
      'A modal state is blocking the script',
      'The transform is pending',
    ]) {
      expect(textOf(toolErrorResult('Error applying blur', new Error(msg)))).toContain(
        'Commit or cancel it in Photoshop and retry.'
      );
    }
  });

  it('does not stack the hint onto the synthetic empty-envelope message', () => {
    // photoshop-api.ts substitutes this message for empty PS error envelopes;
    // it matches the pending-state signature but carries its own fuller
    // recovery advice — appending the generic hint would stack two partly
    // contradictory instructions (QA 2026-07-30 #1).
    const synthetic =
      'Photoshop returned an empty error — the script failed with no message. ' +
      'This usually means PS is in a stuck/modal state (a leaked preview duplicate ' +
      'or a pending dialog from a prior timeout), or there is no active document. ' +
      'Check that a document is open and try once more; if it persists, dismiss any ' +
      'open Photoshop dialog.';
    const r = toolErrorResult('Error applying blur', new Error(synthetic));
    expect(textOf(r)).toBe(`Error applying blur: ${synthetic}`);
    expect(textOf(r)).not.toContain('Commit or cancel it in Photoshop and retry.');
  });
});

const demoSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    radius: { type: 'number', minimum: 0.1, maximum: 250 },
    apply_to_active_layer: { type: 'boolean', default: false },
  },
  required: ['radius'],
};

describe('runSnippetTool — the handler stereotype, once', () => {
  it('validates, builds, runs, and returns text + structuredContent', async () => {
    const conn = makeConnection({ result: { ok: true, radius_applied: 5 } });
    const snippets = makeSnippetClient();

    const r = await runSnippetTool({
      connection: conn.asConnection(),
      snippetClient: snippets,
      rawArgs: { radius: 5 },
      schema: demoSchema,
      snippet: 'applyDemoBlur',
      errorPrefix: 'Error applying demo blur',
      params: (args) => ({
        radius: args.radius,
        applyToActiveLayer: args.apply_to_active_layer,
      }),
      successText: (result, args) =>
        `Demo blur applied (in_place=${args.apply_to_active_layer}): ${JSON.stringify(result)}`,
    });

    expect(r.isError).toBeUndefined();
    // BOTH callbacks see VALIDATED args — schema defaults applied. ~30
    // collapsed handlers interpolate defaulted args into their success text
    // (QA 2026-07-30 #2), so successText passing rawArgs must fail here.
    expect(textOf(r)).toContain('Demo blur applied (in_place=false)');
    expect(r.structuredContent).toEqual({ ok: true, radius_applied: 5 });
    expect(snippets.calls).toEqual([['applyDemoBlur', { radius: 5, applyToActiveLayer: false }]]);
    expect(conn.lastScript()).toContain('SNIPPET(applyDemoBlur');
  });

  it('builds with empty params when the spec omits the params mapper', async () => {
    const conn = makeConnection({ result: { ok: true } });
    const snippets = makeSnippetClient();

    await runSnippetTool({
      connection: conn.asConnection(),
      snippetClient: snippets,
      rawArgs: { radius: 1 },
      schema: demoSchema,
      snippet: 'deselect',
      errorPrefix: 'Error deselecting',
      successText: () => 'Deselected.',
    });

    expect(snippets.calls).toEqual([['deselect', {}]]);
  });

  it('forwards timeoutMs to the executor', async () => {
    const conn = makeConnection({ result: { ok: true } });

    await runSnippetTool({
      connection: conn.asConnection(),
      snippetClient: makeSnippetClient(),
      rawArgs: { radius: 1 },
      schema: demoSchema,
      snippet: 'slowOp',
      errorPrefix: 'Error running slow op',
      successText: () => 'Done.',
      timeoutMs: 120_000,
    });

    expect(conn.lastTimeout()).toBe(120_000);
  });

  it('returns the standard error result on validation failure, without executing', async () => {
    const conn = makeConnection();

    const r = await runSnippetTool({
      connection: conn.asConnection(),
      snippetClient: makeSnippetClient(),
      rawArgs: {}, // missing required `radius`
      schema: demoSchema,
      snippet: 'applyDemoBlur',
      errorPrefix: 'Error applying demo blur',
      successText: () => 'unreachable',
    });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Error applying demo blur: /);
    expect(conn.executions).toHaveLength(0);
  });

  it('funnels script failures through toolErrorResult', async () => {
    const conn = makeConnection({ throwOnExecute: new Error('boom') });

    const r = await runSnippetTool({
      connection: conn.asConnection(),
      snippetClient: makeSnippetClient(),
      rawArgs: { radius: 1 },
      schema: demoSchema,
      snippet: 'applyDemoBlur',
      errorPrefix: 'Error applying demo blur',
      successText: () => 'unreachable',
    });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('Error applying demo blur: boom');
  });
});

describe('applyToActiveLayerProp — the auto-duplicate contract, once', () => {
  it('produces the boolean prop with the site noun woven into the one wording', () => {
    const prop = applyToActiveLayerProp('the filter');
    expect(prop.type).toBe('boolean');
    expect(prop.default).toBe(false);
    expect(prop.description).toContain('If false (default), the filter is applied to a duplicate');
    expect(prop.description).toContain('"<OpName> (<Original Name>)"');
    expect(prop.description).toContain('If true, the filter bakes directly into the active layer');
  });
});
