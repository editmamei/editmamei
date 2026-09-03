import { PhotoshopAPI, PhotoshopAPIFactory } from '../api/photoshop-api.js';
import type { PhotoshopConnection } from '../platform/connection.js';
import { currentToolBudget } from './tool-budget-context.js';

/**
 * Per-connection memo of the constructed `PhotoshopAPI`.
 * Before this, every one of the ~185 `runScript` call sites built
 * a fresh `PhotoshopAPIFactory` + `ExtendScriptPhotoshopAPI` + `Logger` on
 * every single script — pure waste, since `ExtendScriptPhotoshopAPI` holds
 * only the `connection` reference and has no other mutable per-call state
 * (see `src/api/photoshop-api.ts`). Keyed by `PhotoshopConnection` with a
 * `WeakMap` so the entry is GC'd along with the connection.
 *
 * (C4, 2026-07-30) A prior version of this comment justified freshness by
 * claiming "a reconnect creates a new PhotoshopConnection instance, which
 * is a new map key" — that's not true today: `Session.disconnect()` is a
 * no-op and the `PhotoshopConnection` instance is never replaced for the
 * life of the process, so there is no "new key on reconnect" to lean on.
 * The real reason a memoized API can't go stale is structural, not
 * object-identity-based: the API holds only the `connection` reference and
 * delegates every call straight through to `connection.executeScript`,
 * which reads (and, via `getVersion`/`executeScript`, lazily re-caches)
 * the connection's own `photoshopInfo` live on each call. A memoized API
 * is therefore exactly as fresh as constructing a new one per call would
 * be — the memo caches the wrapper, never anything inside it.
 */
const apiCache = new WeakMap<PhotoshopConnection, PhotoshopAPI>();

/**
 * One-shot helper that collapses the per-handler boilerplate
 *
 *     const apiFactory = new PhotoshopAPIFactory(connection);
 *     const api = await apiFactory.createAPI();
 *     const result = await api.executeScript(script);
 *
 * into a single call. The factory was originally a seam for a UXP backend
 * that never materialised — `createAPI` returns the only viable implementation
 * (ExtendScript) unconditionally — so every handler in the codebase walked
 * the same three lines. This helper preserves the seam (so a future API-type
 * dispatch still has a single chokepoint) while removing the repetition.
 * The constructed API is memoized per connection — see `apiCache` above.
 *
 * Returns whatever the underlying ExtendScript snippet returned; callers
 * typically cast to `Record<string, unknown>` for `structuredContent`.
 *
 * Inside a tool dispatch (`tool-budget-context.ts`, set once per call by
 * `ToolRegistry.execute`), this script's own timeout is capped at however
 * much of the call's DEADLINE remains, so a handler that runs several
 * scripts spends its budget once across all of them rather than getting it
 * fresh per script. With no explicit `timeoutMs`, a script gets the FULL
 * remaining deadline (not the platform's flat default) — a tool whose whole
 * budget is one big script must get that whole budget for it, not an extra
 * 30s ceiling layered on top that would silently undercut a much larger
 * configured budget. An explicit `timeoutMs` is still honored in full
 * whenever the deadline has room for it; it only gets shortened when the
 * deadline is closer than the request. A timeout that fires is rethrown
 * naming the tool and the budget it exceeded, on top of the runner's own
 * message; a call that starts with no time left fails the same way without
 * ever reaching Photoshop.
 */
export async function runScript(
  connection: PhotoshopConnection,
  script: string,
  timeoutMs?: number
): Promise<unknown> {
  let api = apiCache.get(connection);
  if (!api) {
    const apiFactory = new PhotoshopAPIFactory(connection);
    api = await apiFactory.createAPI();
    apiCache.set(connection, api);
  }

  const budget = currentToolBudget();
  let effectiveTimeoutMs = timeoutMs;
  if (budget) {
    const remaining = budget.deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Tool '${budget.toolName}' exceeded its ${budget.budgetMs}ms budget before this script could run.`
      );
    }
    effectiveTimeoutMs = timeoutMs === undefined ? remaining : Math.min(timeoutMs, remaining);
  }

  try {
    return await api.executeScript(script, effectiveTimeoutMs);
  } catch (error) {
    if (budget && isScriptTimeoutError(error)) {
      // effectiveTimeoutMs, not budget.budgetMs: a later script in a
      // multi-script call can fail on a small REMAINING slice of a large
      // tool budget, and naming the tool's full nominal budget there would
      // read as "it had 164s and still failed" when it may have had only a
      // few seconds left. What actually fired is the more honest number.
      throw new Error(
        `Tool '${budget.toolName}' exceeded its ${effectiveTimeoutMs}ms budget: ${error.message}`,
        { cause: error }
      );
    }
    throw error;
  }
}

/**
 * Recognizes both platforms' timeout-shaped failures. Windows and the
 * shared script queue reject with a message starting "Script execution
 * timeout" (run-child.ts / script-queue.ts). macOS never reaches that
 * marker on a timeout — the Apple Event manager gives up on its own and
 * `osascript` reports it on stderr as a non-zero exit whose text contains
 * "AppleEvent timed out" and error -1712 (see macos-runner.ts's runOnce).
 */
function isScriptTimeoutError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith('Script execution timeout') ||
    /AppleEvent timed out|-1712\b/.test(error.message)
  );
}
