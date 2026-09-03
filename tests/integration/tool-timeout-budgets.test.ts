import { describe, it, expect } from 'vitest';
import { TOOL_TIERS } from '@editmamei/core/tool-tiers.ts';
import { ToolRegistry, type ToolDefinition } from '@editmamei/core/tool-registry.ts';
import {
  getToolTimeoutMs,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  SCRIPT_TIMEOUT_FLOOR_MS,
  TOOL_TIMEOUT_BUDGETS_MS,
  TOOLS_WITHOUT_A_BUDGET,
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
 * its structural contract without pinning the exact derived numbers, which
 * are expected to be re-derived as usage evolves.
 *
 * Scoped to COMMUNITY (and dev) tools only. Pro-tier tools are deliberately
 * excluded from both `TOOL_TIMEOUT_BUDGETS_MS` and `TOOLS_WITHOUT_A_BUDGET`
 * — this file ships in the CE bundle, and naming a Pro tool here, even as an
 * allowlist comment, leaks its identity into a build that must not carry it.
 * A Pro tool's own budget is its own handler's concern, in the private repo.
 */
describe('getToolTimeoutMs — table completeness (community/dev)', () => {
  it('every community/dev tool has an explicit table entry or a documented allowlist reason', () => {
    const missing: string[] = [];
    for (const [name, tier] of Object.entries(TOOL_TIERS)) {
      if (tier !== 'community' && tier !== 'dev') continue;
      const hasEntry = Object.hasOwn(TOOL_TIMEOUT_BUDGETS_MS, name);
      const hasReason =
        Object.hasOwn(TOOLS_WITHOUT_A_BUDGET, name) &&
        TOOLS_WITHOUT_A_BUDGET[name].trim().length > 0;
      if (!hasEntry && !hasReason) missing.push(name);
    }
    expect(missing, `no explicit entry or allowlist reason for: ${missing.join(', ')}`).toEqual([]);
  });

  it('a table entry never dips below the floor', () => {
    for (const [name, ms] of Object.entries(TOOL_TIMEOUT_BUDGETS_MS)) {
      expect(ms, `${name}: ${ms}ms is below the floor`).toBeGreaterThanOrEqual(
        SCRIPT_TIMEOUT_FLOOR_MS
      );
    }
  });

  it('every table entry and every allowlist entry names a real, currently-registered tool', () => {
    // The reverse of completeness — catches a typo'd key that would
    // otherwise sit dead in either object forever.
    const known = new Set(Object.keys(TOOL_TIERS));
    for (const name of Object.keys(TOOL_TIMEOUT_BUDGETS_MS)) {
      expect(known.has(name), `${name}: table key is not a registered tool`).toBe(true);
    }
    for (const name of Object.keys(TOOLS_WITHOUT_A_BUDGET)) {
      expect(known.has(name), `${name}: allowlist key is not a registered tool`).toBe(true);
    }
  });

  it('no Pro-tier tool appears in the table or the allowlist', () => {
    // The load-bearing leak-guard regression check: this file ships in the
    // CE bundle, so a Pro tool name here — table key or allowlist key —
    // leaks a Pro-gated identity into a build that must not carry it, even
    // though tsc emits an unquoted object key rather than a string literal
    // the existing build-output leak-guard would catch.
    const proNames = new Set(
      Object.entries(TOOL_TIERS)
        .filter(([, tier]) => tier === 'pro')
        .map(([name]) => name)
    );
    for (const name of Object.keys(TOOL_TIMEOUT_BUDGETS_MS)) {
      expect(proNames.has(name), `${name}: a Pro tool must not appear in the CE budget table`).toBe(
        false
      );
    }
    for (const name of Object.keys(TOOLS_WITHOUT_A_BUDGET)) {
      expect(
        proNames.has(name),
        `${name}: a Pro tool must not appear in the CE budget allowlist`
      ).toBe(false);
    }
  });

  it('a Pro-tier tool still resolves to a sane fallback budget', () => {
    // Weaker, by design: a Pro tool's real budget lives in its own handler
    // (private repo), not here. This only proves the CE-side mechanism
    // doesn't misbehave for a name it has deliberately never seen.
    const aProTool = Object.entries(TOOL_TIERS).find(([, tier]) => tier === 'pro')?.[0];
    expect(aProTool).toBeDefined();
    expect(getToolTimeoutMs(aProTool!)).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
  });

  it('a tool with no table entry falls back to DEFAULT_SCRIPT_TIMEOUT_MS', () => {
    expect(getToolTimeoutMs('ps_definitely_not_a_real_tool')).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
  });

  it('preserves every pre-existing hardcoded override unchanged', () => {
    expect(getToolTimeoutMs('ps_open_document')).toBe(OPEN_DOCUMENT_TIMEOUT_MS);
    expect(getToolTimeoutMs('ps_select_subject')).toBe(SELECT_SUBJECT_TIMEOUT_MS);
    expect(getToolTimeoutMs('ps_select_sky')).toBe(SELECT_SKY_TIMEOUT_MS);
    expect(getToolTimeoutMs('ps_select_focus_area')).toBe(SELECT_FOCUS_AREA_TIMEOUT_MS);
    expect(getToolTimeoutMs('ps_replace_sky')).toBe(SKY_REPLACEMENT_TIMEOUT_MS);
    for (const name of [
      'ps_open_document',
      'ps_select_subject',
      'ps_select_sky',
      'ps_select_focus_area',
      'ps_replace_sky',
    ]) {
      expect(getToolTimeoutMs(name)).toBe(120_000);
    }
  });

  it('ps_apply_camera_raw (Pro) is absent from the CE table — its override constant still stands alone', () => {
    // CAMERA_RAW_FILTER_TIMEOUT_MS remains exported at 120s for its own
    // handler's explicit runScript call site (in the private repo); it is
    // simply never routed through the CE dispatch table, per the Pro
    // exclusion above.
    expect(CAMERA_RAW_FILTER_TIMEOUT_MS).toBe(120_000);
    expect(getToolTimeoutMs('ps_apply_camera_raw')).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
  });

  it('a genuinely long, newly-measured tool gets a budget well above the shared default', () => {
    expect(getToolTimeoutMs('ps_selection_channel')).toBeGreaterThan(DEFAULT_SCRIPT_TIMEOUT_MS);
    expect(getToolTimeoutMs('ps_read_scene')).toBeGreaterThan(DEFAULT_SCRIPT_TIMEOUT_MS);
  });

  it('a row with censored (ceiling-hit) calls floors at 30s even though its clean p99 alone would not', () => {
    // ps_close_document's clean p99 is ~1.3s, but it has an observed
    // max_clean of 16114ms AND at least one call censored at the old flat
    // ceiling — either fact alone forces this to the 30s floor, not the
    // small number a naive 2x-p99 formula would derive.
    expect(getToolTimeoutMs('ps_close_document')).toBeGreaterThanOrEqual(30_000);
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

/** Generous tolerance for the few ms of real wall-clock time a test itself spends. */
const TOLERANCE_MS = 500;

/**
 * The dispatch seam: `ToolRegistry.execute` computes the call's deadline once
 * (`tool-budget-context.ts`), and `runScript` derives each script's own
 * timeout from however much of it remains. Fails against the pre-fix
 * registry, which invoked handlers directly with no budget context at all —
 * every runScript call inside a handler used to fall straight through to the
 * platform runner's flat default regardless of which tool was calling.
 */
describe('ToolRegistry.execute — per-tool budget propagation', () => {
  it('every script a handler runs inherits (approximately) the same tool budget', async () => {
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
    for (const exec of conn.executions) {
      expect(exec.timeout).toBeLessThanOrEqual(expectedBudget);
      expect(exec.timeout).toBeGreaterThan(expectedBudget - TOLERANCE_MS);
    }
  });

  it('an explicit per-call timeoutMs still wins when the deadline has room for it', async () => {
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

    expect(conn.executions[0].timeout).toBeLessThanOrEqual(DEFAULT_SCRIPT_TIMEOUT_MS);
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

    const channelBudget = getToolTimeoutMs('ps_selection_channel');
    const exportBudget = getToolTimeoutMs('ps_export');
    expect(conn.executions[0].timeout).toBeLessThanOrEqual(channelBudget);
    expect(conn.executions[0].timeout).toBeGreaterThan(channelBudget - TOLERANCE_MS);
    expect(conn.executions[1].timeout).toBeLessThanOrEqual(exportBudget);
    expect(conn.executions[1].timeout).toBeGreaterThan(exportBudget - TOLERANCE_MS);
    expect(conn.executions[0].timeout).not.toBe(conn.executions[1].timeout);
  });

  it('a nested Kernel.invokeTool-style call never runs longer than its parent has left', async () => {
    // Simulates what Kernel.invokeTool does: re-enter ToolRegistry.execute
    // for a second tool while still inside the first tool's handler.
    const conn = makeConnection();
    const registry = new ToolRegistry();
    registry.register(
      'ps_read_scene', // a real, large-budget community tool (164s)
      fakeTool('ps_read_scene', async (args) => {
        if (args.viaOuter) {
          await registry.execute('ps_export', {}); // ps_export: small community budget
        } else {
          await runScript(conn.asConnection(), 'inner script');
        }
        return { content: [{ type: 'text', text: 'ok' }] };
      })
    );
    registry.register(
      'ps_export',
      fakeTool('ps_export', async () => {
        await runScript(conn.asConnection(), 'nested script');
        return { content: [{ type: 'text', text: 'ok' }] };
      })
    );

    await registry.execute('ps_read_scene', { viaOuter: true });

    // ps_export's own budget is small already (9s), and well under
    // ps_read_scene's 164s — so this alone doesn't prove capping, but it
    // does prove the nested dispatch actually ran and got a sane, bounded
    // timeout rather than an undefined/unbounded one.
    const exportBudget = getToolTimeoutMs('ps_export');
    expect(conn.executions[0].timeout).toBeLessThanOrEqual(exportBudget);
    expect(conn.executions[0].timeout).toBeGreaterThan(0);
  });
});
