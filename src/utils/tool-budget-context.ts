import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Threads one MCP tool call's ABSOLUTE deadline to every script that call's
 * handler runs, however many, without changing a single handler's signature.
 *
 * The deadline — not a per-script timeout — is what bounds a script that
 * doesn't specify its own: a tool that runs several such scripts must
 * finish all of them within its own budget, not get that budget fresh for
 * each one. An explicit `timeoutMs` a caller passes to `runScript()` always
 * wins over this deadline instead, in both directions — see its doc comment
 * for why.
 *
 * The deadline counts ALL elapsed wall-clock time from dispatch, including
 * time a script spends queued behind an earlier one on the shared
 * `ScriptQueue` — there is no separate carve-out for queue wait. (The
 * per-task WATCHDOG inside `ScriptQueue` is different: it is armed only at
 * exec start, specifically so queue wait doesn't trip THAT timer early. The
 * deadline here is the caller-facing total-time contract; the watchdog is
 * an internal backstop against a single script hanging once it starts.)
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
  /** This tool's own configured budget, ms — carried for error messages. */
  budgetMs: number;
  /** Absolute epoch-ms instant every script started under this call must finish by. */
  deadline: number;
}

const storage = new AsyncLocalStorage<ToolBudgetContext>();

/**
 * Build the budget context for a dispatch, honoring any OUTER tool call
 * already in scope. `Kernel.invokeTool` re-enters `ToolRegistry.execute`
 * while still inside the outer handler's async chain, so this sees the
 * outer context via `storage.getStore()` with no separate nesting mechanism
 * needed. A nested call's deadline is whichever is SOONER: its own budget
 * counted from now, or the outer call's remaining deadline — an inner tool
 * can never run longer than its parent has left, even when its own budget
 * is the larger of the two.
 */
export function budgetContextFor(
  toolName: string,
  budgetMs: number,
  now: number = Date.now()
): ToolBudgetContext {
  const ownDeadline = now + budgetMs;
  const outer = storage.getStore();
  const deadline = outer ? Math.min(ownDeadline, outer.deadline) : ownDeadline;
  return { toolName, budgetMs, deadline };
}

/** Run `fn` with `context` visible to every `runScript()` call inside it. */
export function runWithToolBudget<T>(context: ToolBudgetContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

/** The enclosing tool dispatch's budget, if `fn` is currently running inside one. */
export function currentToolBudget(): ToolBudgetContext | undefined {
  return storage.getStore();
}
