/**
 * WO-7 (extends WO-1) — the `ps_ping` license-refresh piggyback.
 *
 * WO-1 revalidates a stale cached license on the boot path so an always-online
 * Pro user never falls off the grace cliff. But Claude Desktop keeps an MCP
 * server alive for long stretches — a process can cross the staleness line
 * (and eventually the grace cliff) without ever restarting, so boot-only
 * refresh under-covers exactly the long-lived host. This fires the SAME boot
 * refresh (`refreshIfStale`, which owns all the record-exists / staleness /
 * grace / clock-skew policy) from `ps_ping`.
 *
 * Every ping, not once per process (de-latched 2026-07-22 alongside the
 * 1-day REFRESH_AFTER_MS): with a daily freshness window, a host that stays
 * up for days must get re-checked on later pings, or "re-validate daily" only
 * holds across restarts. Two gates bound the network traffic:
 *   - `refreshIfStale` self-gates on cache age, so once a validate SUCCEEDS
 *     the record is fresh and later fires are cheap local no-ops for the rest
 *     of the window.
 *   - The trigger itself throttles ATTEMPTS to one per
 *     `PING_REFRESH_MIN_INTERVAL_MS` regardless of outcome — without this, a
 *     stale record whose validates persistently FAIL (Polar outage, blocked
 *     network) never rewrites `last_validated_at`, so an MCP client hammering
 *     `ps_ping` would drive 1:1 outbound validate attempts (QA finding,
 *     2026-07-22).
 *
 * Strictly fire-and-forget: `refreshIfStale` is invoked detached so it adds
 * ZERO latency to the ping — the ping result never waits on a network call.
 * `refreshIfStale` is itself a hard no-op under the test runner, so wiring this
 * into the server can't leak real license traffic into the suite.
 */
import { refreshIfStale, type RefreshIfStaleOptions } from './entitlement.js';

export type LicenseRefreshFn = (ops?: RefreshIfStaleOptions) => Promise<void>;

/**
 * Minimum wall-clock between ping-triggered refresh ATTEMPTS (success or
 * failure). Bounds worst-case outbound validate traffic under persistent
 * failure to ~96/day even against a ping-spamming client, while keeping
 * post-outage recovery latency negligible next to the 1-day freshness window.
 */
export const PING_REFRESH_MIN_INTERVAL_MS = 15 * 60_000;

export interface PingRefresherOptions {
  /** Injected clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Injected throttle interval (tests). Defaults to PING_REFRESH_MIN_INTERVAL_MS. */
  minIntervalMs?: number;
}

/**
 * Build a refresh trigger that is safe to call on every ping: each call fires
 * the self-gating refresh, detached, at most once per throttle interval.
 * `refresh` is injectable for tests; production uses the real boot-path
 * `refreshIfStale`.
 */
export function createPingLicenseRefresher(
  refresh: LicenseRefreshFn = refreshIfStale,
  opts: PingRefresherOptions = {}
): () => void {
  const now = opts.now ?? Date.now;
  const minIntervalMs = opts.minIntervalMs ?? PING_REFRESH_MIN_INTERVAL_MS;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  return () => {
    const t = now();
    if (t - lastAttemptAt < minIntervalMs) return;
    // Count the ATTEMPT, not the outcome — a failing validate must not turn
    // the throttle off (that is the whole point of throttling attempts).
    lastAttemptAt = t;
    // Detached on purpose — the ping handler must not await license I/O.
    // refreshIfStale swallows its own failures; the try/catch + .catch cover a
    // synchronous or async throw from an injected fake so a ping can never fail
    // here. The kicked-off work runs, but the trigger returns immediately.
    try {
      void refresh().catch(() => {});
    } catch {
      /* a non-async refresh that throws synchronously must not break the ping */
    }
  };
}
