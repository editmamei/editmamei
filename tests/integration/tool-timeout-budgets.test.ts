import { describe, it, expect } from 'vitest';
import { TOOL_TIERS } from '@editmamei/core/tool-tiers.ts';
import { ToolRegistry, type ToolDefinition } from '@editmamei/core/tool-registry.ts';
import {
  getToolTimeoutMs,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  SCRIPT_TIMEOUT_FLOOR_MS,
  OPEN_DOCUMENT_TIMEOUT_MS,
  CAMERA_RAW_FILTER_TIMEOUT_MS,
  SELECT_SUBJECT_TIMEOUT_MS,
  SELECT_SKY_TIMEOUT_MS,
  SELECT_FOCUS_AREA_TIMEOUT_MS,
  SKY_REPLACEMENT_TIMEOUT_MS,
} from '@editmamei/utils/operation-timeouts.ts';
import { runScript } from '@editmamei/utils/run-script.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';

/**
 * `getToolTimeoutMs` is the single source of truth every registered tool's
 * per-call dispatch budget flows through (`ToolRegistry.execute`). This pins
 * its structural contract — every shippable tool gets *some* budget, none
 * below the floor, and the handful of pre-existing hardcoded overrides are
 * carried through unchanged — without pinning the exact derived numbers,
 * which are expected to be re-derived as usage evolves.
 */
describe('getToolTimeoutMs — table completeness', () => {
  it('every community/pro tool has a budget at or above the floor', () => {
    for (const [name, tier] of Object.entries(TOOL_TIERS)) {
      if (tier !== 'community' && tier !== 'pro') continue;
      const budget = getToolTimeoutMs(name);
      expect(budget, `${name}: expected a numeric budget`).toEqual(expect.any(Number));
      expect(budget, `${name}: budget ${budget}ms is below the floor`).toBeGreaterThanOrEqual(
        SCRIPT_TIMEOUT_FLOOR_MS
      );
    }
  });

  it('a tool with no table entry falls back to DEFAULT_SCRIPT_TIMEOUT_MS', () => {
    expect(getToolTimeoutMs('ps_definitely_not_a_real_tool')).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
  });

  it('preserves every pre-existing hardcoded override unchanged', () => {
    expect(getToolTimeoutMs('ps_open_document')).toBe(OPEN_DOCUMENT_TIMEOUT_MS);
    expect(getToolTimeoutMs('ps_apply_camera_raw')).toBe(CAMERA_RAW_FILTER_TIMEOUT_MS);
    expect(getToolTimeoutMs('ps_select_subject')).toBe(SELECT_SUBJECT_TIMEOUT_MS);
    expect(getToolTimeoutMs('ps_select_sky')).toBe(SELECT_SKY_TIMEOUT_MS);
    expect(getToolTimeoutMs('ps_select_focus_area')).toBe(SELECT_FOCUS_AREA_TIMEOUT_MS);
    expect(getToolTimeoutMs('ps_replace_sky')).toBe(SKY_REPLACEMENT_TIMEOUT_MS);
    // All six overrides predate this table and are the 120s "known cliff"
    // budget — pinned as a group so a future re-derivation can't quietly
    // shrink one of them back toward its raw (smaller) measured percentile.
    for (const name of [
      'ps_open_document',
      'ps_apply_camera_raw',
      'ps_select_subject',
      'ps_select_sky',
      'ps_select_focus_area',
      'ps_replace_sky',
    ]) {
      expect(getToolTimeoutMs(name)).toBe(120_000);
    }
  });

  it('a genuinely long, newly-measured tool gets a budget well above the shared default', () => {
    // ps_selection_channel and ps_read_scene had no override before this
    // table — pin that they now exceed DEFAULT_SCRIPT_TIMEOUT_MS rather than
    // silently falling back to it.
    expect(getToolTimeoutMs('ps_selection_channel')).toBeGreaterThan(DEFAULT_SCRIPT_TIMEOUT_MS);
    expect(getToolTimeoutMs('ps_read_scene')).toBeGreaterThan(DEFAULT_SCRIPT_TIMEOUT_MS);
  });
});

function fakeTool(name: string, handler: ToolDefinition['handler']): ToolDefinition {
  return {
    tool: {
      name,
      description: `${name} description`,
      inputSchema: { type: 'object', properties: {} },
    },
    handler,
  };
}

/**
 * The dispatch seam: `ToolRegistry.execute` sets the tool's budget once per
 * call (`tool-budget-context.ts`), and `runScript` picks it up for any
 * script the handler runs that doesn't specify its own `timeoutMs`. Fails
 * against the pre-change registry, which invoked handlers directly with no
 * budget context at all — every runScript call inside a handler used to fall
 * straight through to the platform runner's flat default regardless of which
 * tool was calling.
 */
describe('ToolRegistry.execute — per-tool budget propagation', () => {
  it('every script a handler runs inherits the same tool budget', async () => {
    const conn = makeConnection();
    const registry = new ToolRegistry();
    registry.register(
      'ps_not_in_the_table',
      fakeTool('ps_not_in_the_table', async () => {
        await runScript(conn.asConnection(), 'script one');
        await runScript(conn.asConnection(), 'script two');
        return { content: [{ type: 'text', text: 'ok' }] };
      })
    );

    await registry.execute('ps_not_in_the_table', {});

    const expectedBudget = getToolTimeoutMs('ps_not_in_the_table');
    expect(expectedBudget).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
    expect(conn.executions).toHaveLength(2);
    expect(conn.executions[0].timeout).toBe(expectedBudget);
    expect(conn.executions[1].timeout).toBe(expectedBudget);
  });

  it('an explicit per-call timeoutMs still wins over the tool budget', async () => {
    const conn = makeConnection();
    const registry = new ToolRegistry();
    registry.register(
      'ps_not_in_the_table',
      fakeTool('ps_not_in_the_table', async () => {
        await runScript(conn.asConnection(), 'default budget');
        await runScript(conn.asConnection(), 'overridden budget', 777);
        return { content: [{ type: 'text', text: 'ok' }] };
      })
    );

    await registry.execute('ps_not_in_the_table', {});

    expect(conn.executions[0].timeout).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
    expect(conn.executions[1].timeout).toBe(777);
  });

  it('two different tools in the same process get their own independent budgets', async () => {
    const conn = makeConnection();
    const registry = new ToolRegistry();
    registry.register(
      'ps_selection_channel',
      fakeTool('ps_selection_channel', async () => {
        await runScript(conn.asConnection(), 'script');
        return { content: [{ type: 'text', text: 'ok' }] };
      })
    );
    registry.register(
      'ps_export',
      fakeTool('ps_export', async () => {
        await runScript(conn.asConnection(), 'script');
        return { content: [{ type: 'text', text: 'ok' }] };
      })
    );

    await registry.execute('ps_selection_channel', {});
    await registry.execute('ps_export', {});

    expect(conn.executions[0].timeout).toBe(getToolTimeoutMs('ps_selection_channel'));
    expect(conn.executions[1].timeout).toBe(getToolTimeoutMs('ps_export'));
    expect(conn.executions[0].timeout).not.toBe(conn.executions[1].timeout);
  });
});
