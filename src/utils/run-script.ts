import { PhotoshopAPI, PhotoshopAPIFactory } from '../api/photoshop-api.js';
import type { PhotoshopConnection } from '../platform/connection.js';

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
  return api.executeScript(script, timeoutMs);
}
