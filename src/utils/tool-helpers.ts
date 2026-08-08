/**
 * Shared tool-handler helpers.
 *
 * Before this module, three contracts were hand-copied across `src/tools/`:
 *
 * - The catch-tail `error instanceof Error ? error.message : String(error)`
 *   existed in 148 copies across 42 files. Exactly one copy (preview-tools)
 *   had grown a pending/modal-state hint the other 147 lacked — drift, not
 *   just verbosity. `toolErrorResult` is now the single catch-tail and the
 *   hint applies to every tool.
 * - The `validate → build → runScript → return` handler stereotype existed
 *   in ~119 near-identical bodies. `runSnippetTool` collapses the plain
 *   cases; handlers with extra logic (multi-script, post-processing beyond
 *   text formatting, args-dependent timeouts) keep their bodies and use
 *   `toolErrorResult` alone.
 * - The auto-duplicate-first `apply_to_active_layer` schema prop was
 *   re-declared 8 ways with divergent wording. `applyToActiveLayerProp` is
 *   the one contract text.
 */

import type { ToolResult } from '../core/tool-registry.js';
import type { PhotoshopConnection } from '../platform/connection.js';
import type { SnippetClient } from '../api/snippet-client.js';
import { runScript } from './run-script.js';
import { validateArgs, type JsonSchemaObject, type JsonSchemaProperty } from './validate.js';

/**
 * Appended to the error text when the message looks like Photoshop is stuck
 * in a pending/modal state. Originated as a preview-tools-only improvement
 * (2026-06-13 session fix); the audit flagged the other 147 catch tails
 * lacking it as drift, so it now rides on every tool error. Empty PS-error
 * envelopes are substituted with a synthetic message upstream at the
 * photoshop-api.ts chokepoint, so `msg` always arrives non-empty here.
 */
const PENDING_STATE_HINT =
  ' This usually means an operation is pending in Photoshop (active transform, open dialog, uncommitted text edit). Commit or cancel it in Photoshop and retry.';

/**
 * Signatures that suggest Photoshop is mid-operation rather than simply unable
 * to do what was asked.
 *
 * Every alternative here must name the *thing* that is stuck. Bare words match
 * ordinary messages and staple confidently wrong advice onto them, and this has
 * now happened twice: `commit` was removed for it, and `is open` — added to
 * catch "a dialog is open" — went on to match "no document is open in
 * Photoshop", telling a user to cancel a pending operation when what they
 * actually needed was to open a document.
 *
 * Prefer a narrower alternative over a broader one. A missed hint costs a
 * sentence of help; a wrong hint sends someone looking for a modal that was
 * never there.
 */
const PENDING_STATE_RE = /pending|in progress|modal|currently in|(?:dialog|window|panel) is open/i;

/**
 * The photoshop-api.ts empty-envelope synthetic message carries its own
 * (fuller) recovery advice and matches the pending-state signature —
 * appending the hint on top would stack two partly-contradictory
 * instructions. Detected by its distinctive closing phrase.
 */
const HAS_OWN_ADVICE_RE = /dismiss any open Photoshop dialog/i;

/**
 * The single catch-tail for tool handlers.
 *
 * `prefix` is everything before the ": <message>" separator and is preserved
 * exactly from each call site (usually "Error <gerund phrase>", occasionally
 * "Failed to <verb>") so error text stays byte-stable across the
 * consolidation apart from the added pending-state hint.
 */
export function toolErrorResult(prefix: string, error: unknown): ToolResult {
  const msg = error instanceof Error ? error.message : String(error);
  const wantsHint = PENDING_STATE_RE.test(msg) && !HAS_OWN_ADVICE_RE.test(msg);
  // Photoshop's messages mostly arrive without terminal punctuation, and the
  // hint is a sentence. Without this the two run together into one ungrammatical
  // line.
  const separator = wantsHint && !/[.!?]$/.test(msg.trimEnd()) ? '.' : '';
  return {
    content: [
      {
        type: 'text' as const,
        text: `${prefix}: ${msg}${separator}${wantsHint ? PENDING_STATE_HINT : ''}`,
      },
    ],
    isError: true,
  };
}

/**
 * Uniform rejection for an op-discriminated tool's unknown discriminator.
 * Every consolidated dispatcher (`ps_select`, `ps_modify_selection`,
 * `ps_selection_channel`, `ps_layer_mask`, `ps_clipping_mask`) returns this
 * same shape so an LLM recovering from the error sees one consistent
 * phrasing across the whole surface.
 */
export function unknownDiscriminator(
  kind: string,
  value: unknown,
  allowed: readonly string[]
): ToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: unknown ${kind} "${String(value)}". Allowed: ${allowed.join(', ')}.`,
      },
    ],
    isError: true,
  };
}

/**
 * Spec for a plain snippet-backed tool handler. Only handlers that match the
 * stereotype exactly should collapse onto this: one text content block, and
 * `structuredContent` = the snippet result cast to a record. Anything else
 * (extra content blocks, transformed structured output, multiple scripts,
 * args-dependent timeouts) keeps its hand-written body.
 */
export interface SnippetToolSpec {
  connection: PhotoshopConnection;
  snippetClient: SnippetClient;
  rawArgs: Record<string, unknown>;
  schema: JsonSchemaObject;
  /** go-core snippet name passed to `snippetClient.build`. */
  snippet: string;
  /** Error-text prefix, e.g. `"Error applying equalize"`. */
  errorPrefix: string;
  /** Map validated args to snippet params. Omit for parameterless snippets. */
  params?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Human-readable text block for the success result. */
  successText: (result: unknown, args: Record<string, unknown>) => string;
  timeoutMs?: number;
}

/**
 * The `validate → build → runScript → return` handler stereotype, once.
 * Validation errors, build failures, and script errors all funnel through
 * `toolErrorResult` exactly as the hand-written bodies did.
 */
export async function runSnippetTool(spec: SnippetToolSpec): Promise<ToolResult> {
  try {
    const args = validateArgs(spec.schema, spec.rawArgs);
    const script = await spec.snippetClient.build(
      spec.snippet,
      spec.params ? spec.params(args) : {}
    );
    const result = await runScript(spec.connection, script, spec.timeoutMs);
    return {
      content: [{ type: 'text' as const, text: spec.successText(result, args) }],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult(spec.errorPrefix, error);
  }
}

/**
 * The auto-duplicate-first contract prop, declared
 * once. `op` is the site's noun phrase — "the filter", "the retouch op",
 * "the adjustment" — so each schema reads naturally while the contract
 * wording stays uniform.
 */
export function applyToActiveLayerProp(op: string): JsonSchemaProperty {
  return {
    type: 'boolean',
    description:
      `If false (default), ${op} is applied to a duplicate of the active layer named ` +
      `"<OpName> (<Original Name>)" — the original is preserved and the LLM can undo simply ` +
      `by deleting the copy. If true, ${op} bakes directly into the active layer ` +
      `(the historical destructive behavior).`,
    default: false,
  };
}

/**
 * The Smart-Filter opt-in, declared once for every filter type.
 *
 * Photoshop needs no special descriptor to make a Smart Filter — applying an
 * ordinary filter to a Smart Object simply produces one. The default stays false
 * because flipping it would change what a shipped tool does to existing callers;
 * the destructive path is a legitimate choice, not a bug, and it remains the
 * default until that is deliberately revisited.
 */
export function asSmartFilterProp(): JsonSchemaProperty {
  return {
    type: 'boolean',
    description:
      'If true, apply the filter as a re-editable SMART FILTER riding the Smart Object ' +
      'instead of baking it into pixels — nothing is rasterized, and the filter can later be ' +
      'toggled, re-blended or removed instead of being permanent. Requires the target to be a ' +
      'Smart Object (convert first with ps_convert_to_smart_object); errors rather than ' +
      'converting silently. If false (default), the filter is baked and a smart-object layer ' +
      'is rasterized first.',
    default: false,
  };
}
