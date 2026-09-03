import { describe, it, expect, vi, afterEach } from 'vitest';
import { runScript } from '@editmamei/utils/run-script.ts';
import { PhotoshopAPIFactory } from '@editmamei/api/photoshop-api.ts';
import { runWithToolBudget } from '@editmamei/utils/tool-budget-context.ts';
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
 * `runScript` reads the enclosing tool call's budget (set by
 * `ToolRegistry.execute` via `runWithToolBudget`) as the fallback for a call
 * that didn't pass its own `timeoutMs`, and names the tool + budget when a
 * timeout actually fires.
 */
describe('runScript — tool-budget fallback and timeout enrichment', () => {
  it('falls back to the enclosing tool budget when no timeoutMs is given', async () => {
    const conn = makeConnection();
    await runWithToolBudget({ toolName: 'ps_fake_tool', budgetMs: 4242 }, () =>
      runScript(conn.asConnection(), 'return 1;')
    );
    expect(conn.lastTimeout()).toBe(4242);
  });

  it('an explicit timeoutMs still wins over the enclosing tool budget', async () => {
    const conn = makeConnection();
    await runWithToolBudget({ toolName: 'ps_fake_tool', budgetMs: 4242 }, () =>
      runScript(conn.asConnection(), 'return 1;', 999)
    );
    expect(conn.lastTimeout()).toBe(999);
  });

  it('passes undefined (the platform default) with no enclosing budget and no override', async () => {
    const conn = makeConnection();
    await runScript(conn.asConnection(), 'return 1;');
    expect(conn.lastTimeout()).toBeUndefined();
  });

  it('names the tool and the budget it exceeded when a timeout fires, keeping the runner warning', async () => {
    const conn = makeConnection({
      throwOnExecute: new Error(
        'Script execution timeout after 4242ms (cscript run.vbs). The child process was killed, ' +
          'but Photoshop runs as a separate process and may have kept executing.'
      ),
    });

    let caught: Error | undefined;
    try {
      await runWithToolBudget({ toolName: 'ps_fake_tool', budgetMs: 4242 }, () =>
        runScript(conn.asConnection(), 'return 1;')
      );
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toMatch(/^Tool 'ps_fake_tool' exceeded its 4242ms budget: /);
    // The runner's own warning survives the rewrap.
    expect(caught?.message).toMatch(/may have kept executing/);
  });

  it('reports the explicit override, not the ALS budget, when one was passed', async () => {
    const conn = makeConnection({
      throwOnExecute: new Error('Script execution timeout after 999ms (cscript run.vbs).'),
    });

    await expect(
      runWithToolBudget({ toolName: 'ps_fake_tool', budgetMs: 4242 }, () =>
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
      runWithToolBudget({ toolName: 'ps_fake_tool', budgetMs: 4242 }, () =>
        runScript(conn.asConnection(), 'return 1;')
      )
    ).rejects.toThrow(/^some other Photoshop failure$/);
  });
});
