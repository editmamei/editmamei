import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Threads one MCP tool call's timeout budget to every script that call's
 * handler runs, however many, without changing a single handler's signature.
 *
 * `ToolRegistry.execute()` sets this once per dispatch, wrapping the handler
 * invocation; `runScript()` reads it as the fallback for a call that didn't
 * pass its own explicit `timeoutMs`. `AsyncLocalStorage` is what lets the
 * value reach a `runScript()` call buried behind several `await`s inside the
 * handler — the context follows the async call chain the same dispatch
 * started, not just its immediate caller.
 */
export interface ToolBudgetContext {
  toolName: string;
  budgetMs: number;
}

const storage = new AsyncLocalStorage<ToolBudgetContext>();

/** Run `fn` with `context` visible to every `runScript()` call inside it. */
export function runWithToolBudget<T>(context: ToolBudgetContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

/** The enclosing tool dispatch's budget, if `fn` is currently running inside one. */
export function currentToolBudget(): ToolBudgetContext | undefined {
  return storage.getStore();
}
