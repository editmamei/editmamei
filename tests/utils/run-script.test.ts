import { describe, it, expect, vi, afterEach } from 'vitest';
import { runScript } from '@editmamei/utils/run-script.ts';
import { PhotoshopAPIFactory } from '@editmamei/api/photoshop-api.ts';
import { budgetContextFor, runWithToolBudget } from '@editmamei/utils/tool-budget-context.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';

/**
 * Audit finding 16 / perf M8: `runScript` is the single chokepoint every
 * tool handler routes through, so it memoizes the constructed `PhotoshopAPI`
 * per `PhotoshopConnection` instead of rebuilding a fresh
 * `PhotoshopAPIFactory` + `ExtendScriptPhotoshopAPI` + `Logger` on every
 * script. `PhotoshopAPIFactory.prototype.createAPI` is the constructor
 * chokepoint — spying on it counts how many `PhotoshopAPI` instances get
 * built, independent of how many scripts actually execute.
 */
describe('runScript — per-connection API memoization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('two runScript calls on the same connection construct exactly one API', async () => {
    const createSpy = vi.spyOn(PhotoshopAPIFactory.prototype, 'createAPI');
    const conn = makeConnection();

    await runScript(conn.asConnection(), 'return 1;');
    await runScript(conn.asConnection(), 'return 2;');

    expect(createSpy).toHaveBeenCalledTimes(1);
    // Both scripts still executed — memoization reuses the API, it doesn't
    // skip the call.
    expect(conn.executions).toHaveLength(2);
  });

  it('different connections each get their own API', async () => {
    const createSpy = vi.spyOn(PhotoshopAPIFactory.prototype, 'createAPI');
    const connA = makeConnection();
    const connB = makeConnection();

    await runScript(connA.asConnection(), 'return 1;');
    await runScript(connB.asConnection(), 'return 2;');

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(connA.executions).toHaveLength(1);
    expect(connB.executions).toHaveLength(1);
  });

  it('does not cache across a failed construction (info not yet detected)', async () => {
    const createSpy = vi.spyOn(PhotoshopAPIFactory.prototype, 'createAPI');
    const conn = makeConnection({ info: null });

    await expect(runScript(conn.asConnection(), 'return 1;')).rejects.toThrow(
      /Photoshop info not available/
    );

    // Nothing was cached on failure, so a retry attempts construction again
    // rather than being permanently stuck.
    conn.reset();
    await expect(runScript(conn.asConnection(), 'return 1;')).rejects.toThrow(
      /Photoshop info not available/
    );
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});

/**
 * `runScript` reads the enclosing tool call's DEADLINE (set by
 * `ToolRegistry.execute` via `runWithToolBudget`/`budgetContextFor`) and
 * bounds this script at whichever is sooner: its own requested timeout or
 * however much of that deadline is left. A timeout that fires names the
 * tool and the bound that actually fired; a call starting with no time left
 * fails the same way without ever reaching Photoshop.
 */
describe('runScript — deadline fallback and timeout enrichment', () => {
  it('falls back to (approximately) the enclosing tool budget when no timeoutMs is given', async () => {
    const conn = makeConnection();
    await runWithToolBudget(budgetContextFor('ps_fake_tool', 4242), () =>
      runScript(conn.asConnection(), 'return 1;')
    );
    // Never more than the configured budget, and only a few ms less —
    // whatever elapsed between computing the deadline and this script.
    expect(conn.lastTimeout()).toBeLessThanOrEqual(4242);
    expect(conn.lastTimeout()).toBeGreaterThan(4242 - 500);
  });

  it('an explicit timeoutMs smaller than the remaining deadline wins outright', async () => {
    const conn = makeConnection();
    await runWithToolBudget(budgetContextFor('ps_fake_tool', 4242), () =>
      runScript(conn.asConnection(), 'return 1;', 999)
    );
    expect(conn.lastTimeout()).toBe(999);
  });

  it('an explicit timeoutMs ABOVE the tool budget still wins, unclamped — annotated-preview shape', async () => {
    // Mirrors ps_get_preview (17s budget) passing ANNOTATED_PREVIEW_TIMEOUT_MS
    // (90s) for an annotated call: the explicit request is what the caller
    // knows it needs, and it must not be silently cut down to the tool's
    // typical-case budget.
    const conn = makeConnection();
    await runWithToolBudget(budgetContextFor('ps_get_preview', 17_000), () =>
      runScript(conn.asConnection(), 'return 1;', 90_000)
    );
    expect(conn.lastTimeout()).toBe(90_000);
  });

  it('an explicit timeoutMs still wins even when the deadline is much tighter than it', async () => {
    const conn = makeConnection();
    // budgetMs is far smaller than the explicit request; the request must
    // still be honored in full, not clamped down to the ~500ms remaining.
    await runWithToolBudget(budgetContextFor('ps_fake_tool', 500), () =>
      runScript(conn.asConnection(), 'return 1;', 999_000)
    );
    expect(conn.lastTimeout()).toBe(999_000);
  });

  it('an explicit timeoutMs escapes an ALREADY-EXHAUSTED deadline — the post-timeout re-probe shape', async () => {
    // Mirrors document-tools.ts's reprobeOpenDocument: it fires from the
    // CATCH of a runScript call whose deadline (ps_open_document's own 120s
    // budget) has already been fully consumed by the failed attempt, and
    // must still run its own OPEN_DOCUMENT_REPROBE_TIMEOUT_MS — not be
    // refused before it ever reaches Photoshop.
    const conn = makeConnection();
    const exhausted = { toolName: 'ps_open_document', budgetMs: 120_000, deadline: Date.now() - 1 };
    await runWithToolBudget(exhausted, () =>
      runScript(conn.asConnection(), 'probe script', 10_000)
    );
    expect(conn.lastTimeout()).toBe(10_000);
    expect(conn.executions).toHaveLength(1);
  });

  it('passes undefined (the platform default) with no enclosing budget and no override', async () => {
    const conn = makeConnection();
    await runScript(conn.asConnection(), 'return 1;');
    expect(conn.lastTimeout()).toBeUndefined();
  });

  it('fails immediately, without touching the connection, when the deadline has already passed', async () => {
    const conn = makeConnection();
    const pastContext = { toolName: 'ps_fake_tool', budgetMs: 4242, deadline: Date.now() - 1000 };

    await expect(
      runWithToolBudget(pastContext, () => runScript(conn.asConnection(), 'return 1;'))
    ).rejects.toThrow(
      /^Tool 'ps_fake_tool' exceeded its 4242ms budget before this script could run\.$/
    );
    expect(conn.executions).toHaveLength(0);
  });

  it('names the tool and the bound that fired when a timeout fires, keeping the runner warning', async () => {
    const conn = makeConnection({
      throwOnExecute: new Error(
        'Script execution timeout after 4242ms (cscript run.vbs). The child process was killed, ' +
          'but Photoshop runs as a separate process and may have kept executing.'
      ),
    });

    let caught: Error | undefined;
    try {
      await runWithToolBudget(budgetContextFor('ps_fake_tool', 4242), () =>
        runScript(conn.asConnection(), 'return 1;')
      );
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toMatch(/^Tool 'ps_fake_tool' exceeded its \d+ms budget: /);
    // The runner's own warning survives the rewrap.
    expect(caught?.message).toMatch(/may have kept executing/);
  });

  it('recognizes the macOS AppleEvent timeout shape, not just the Windows/queue one', async () => {
    const conn = makeConnection({
      throwOnExecute: new Error(
        'osascript exited with code 1: /tmp/x/run.scpt:1:2: execution error: AppleEvent timed out (-1712)'
      ),
    });

    await expect(
      runWithToolBudget(budgetContextFor('ps_fake_tool', 4242), () =>
        runScript(conn.asConnection(), 'return 1;')
      )
    ).rejects.toThrow(/^Tool 'ps_fake_tool' exceeded its \d+ms budget: .*AppleEvent timed out/);
  });

  it('reports the explicit override that actually fired, when it is smaller than the tool budget', async () => {
    const conn = makeConnection({
      throwOnExecute: new Error('Script execution timeout after 999ms (cscript run.vbs).'),
    });

    await expect(
      runWithToolBudget(budgetContextFor('ps_fake_tool', 4242), () =>
        runScript(conn.asConnection(), 'return 1;', 999)
      )
    ).rejects.toThrow(/^Tool 'ps_fake_tool' exceeded its 999ms budget: /);
  });

  it('does not enrich a timeout error outside any tool dispatch', async () => {
    const conn = makeConnection({
      throwOnExecute: new Error('Script execution timeout after 30000ms (cscript run.vbs).'),
    });

    await expect(runScript(conn.asConnection(), 'return 1;')).rejects.toThrow(
      /^Script execution timeout after 30000ms/
    );
  });

  it('leaves a non-timeout error unchanged even inside a tool budget', async () => {
    const conn = makeConnection({ throwOnExecute: new Error('some other Photoshop failure') });

    await expect(
      runWithToolBudget(budgetContextFor('ps_fake_tool', 4242), () =>
        runScript(conn.asConnection(), 'return 1;')
      )
    ).rejects.toThrow(/^some other Photoshop failure$/);
  });
});

/**
 * `budgetContextFor` is what makes a nested `Kernel.invokeTool` call
 * (which re-enters `ToolRegistry.execute` while still inside the outer
 * handler's async context) inherit a deadline no later than its parent's —
 * see its doc comment in tool-budget-context.ts.
 */
describe('runScript — nested tool budget inherits the tighter deadline', () => {
  it('caps an inner call at the outer deadline when the inner budget is larger', async () => {
    const conn = makeConnection();
    const outer = budgetContextFor('ps_outer', 500); // short-lived parent
    await runWithToolBudget(outer, async () => {
      const inner = budgetContextFor('ps_inner', 60_000); // much larger own budget
      await runWithToolBudget(inner, () => runScript(conn.asConnection(), 'inner script'));
    });

    // The inner script must be bounded by the OUTER's ~500ms remaining, not
    // its own 60s nominal budget.
    expect(conn.lastTimeout()).toBeLessThanOrEqual(500);
    expect(conn.lastTimeout()).toBeGreaterThan(0);
  });

  it('keeps the inner budget when it is the smaller (tighter) of the two', async () => {
    const conn = makeConnection();
    const outer = budgetContextFor('ps_outer', 60_000); // generous parent
    await runWithToolBudget(outer, async () => {
      const inner = budgetContextFor('ps_inner', 500); // tighter own budget
      await runWithToolBudget(inner, () => runScript(conn.asConnection(), 'inner script'));
    });

    expect(conn.lastTimeout()).toBeLessThanOrEqual(500);
    expect(conn.lastTimeout()).toBeGreaterThan(0);
  });

  it('a nested call started after the outer deadline already passed fails without running', async () => {
    const conn = makeConnection();
    const outer = { toolName: 'ps_outer', budgetMs: 500, deadline: Date.now() - 1 };
    await runWithToolBudget(outer, async () => {
      const inner = budgetContextFor('ps_inner', 60_000);
      await expect(
        runWithToolBudget(inner, () => runScript(conn.asConnection(), 'inner script'))
      ).rejects.toThrow(
        /^Tool 'ps_inner' exceeded its 60000ms budget before this script could run\.$/
      );
    });
    expect(conn.executions).toHaveLength(0);
  });
});
