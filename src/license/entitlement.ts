/**
 * License orchestration + entitlement evaluation.
 *
 * `evaluateEntitlement` is the pure core (status + grace + expiry); the
 * `activate` / `refresh` / `deactivate` async ops drive Polar through the
 * tokenless client and persist the cache. `isProEntitled` is what the server
 * boot path calls to gate Pro tools — instant, offline-capable within grace.
 */

import { resolvePolarConfig, type PolarConfig } from './config.js';
import { computeDeviceHash } from './device-hash.js';
import {
  readLicense,
  writeLicense,
  clearLicense,
  nextHighWaterMark,
  type LicenseRecord,
  type LicenseStoreOptions,
} from './store.js';
import { PolarLicenseClient, PolarLicenseError, type FetchLike } from './polar-client.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('License');

/**
 * Uniform grace window for all tiers. 30 days at launch (2026-06-15); shortened
 * to 7 days on 2026-07-22: grace is anchored to `last_validated_at`, not the
 * paid period end (`expires_at` is null under the no-TTL benefit), so a
 * validate-late-then-go-offline cancellation rode Pro for up to a month past
 * the paid period. 7 days keeps a real offline allowance while bounding both
 * that ride and revocation lag.
 */
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cache age below which a boot/ping makes zero license network calls. 7 days
 * at launch; 1 day since 2026-07-22 (same change as GRACE_MS) — an online
 * device now re-validates daily, so a revocation lands within ~a day instead
 * of a week. (Numerically equal to CLOCK_SKEW_TOLERANCE_MS by coincidence —
 * they guard opposite signs of cache age and are independent knobs.)
 */
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap on an awaited recovery refresh past the grace window — one per
 * trigger (each boot; ping-triggered attempts are throttled upstream by
 * PING_REFRESH_MIN_INTERVAL_MS).
 */
export const EXPIRED_REFRESH_TIMEOUT_MS = 5_000;

/**
 * Clock-skew tolerance. A `last_validated_at` more than this far in the
 * FUTURE means the machine clock was wrong when the record was written (set
 * ahead, then corrected) — the resulting negative age would otherwise read as
 * "fresh" indefinitely, so the record would never re-validate and a server-side
 * revocation could go unseen for as long as the bogus future date. Beyond this
 * window we force a refresh; inside it, minor drift is tolerated as fresh.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export type EntitlementReason =
  | 'granted'
  | 'no-license'
  | 'revoked'
  | 'disabled'
  | 'expired'
  | 'grace-expired';

export interface Entitlement {
  entitled: boolean;
  reason: EntitlementReason;
}

/** Pure entitlement decision from a cached record + the current time. */
export function evaluateEntitlement(rec: LicenseRecord | null, now: number): Entitlement {
  if (!rec) return { entitled: false, reason: 'no-license' };
  if (rec.status === 'revoked') return { entitled: false, reason: 'revoked' };
  if (rec.status === 'disabled') return { entitled: false, reason: 'disabled' };
  if (rec.expires_at !== null && Date.parse(rec.expires_at) <= now) {
    return { entitled: false, reason: 'expired' };
  }
  const last = Date.parse(rec.last_validated_at);
  if (!Number.isFinite(last) || now - last > GRACE_MS) {
    return { entitled: false, reason: 'grace-expired' };
  }
  // Backward-clock guard: a persisted monotonic high-water-mark means
  // rolling the clock back can't manufacture a fresh-looking record. Without
  // this, `now - last` above is computed against whatever the (possibly
  // rolled-back) clock now reports, so setting the clock BEFORE
  // `last_validated_at` would read as a negative — and so perpetually
  // "fresh" — age, granting Pro offline forever. Symmetric to the FUTURE-skew
  // tolerance in `refreshIfStale`: same constant, opposite direction.
  // A legacy record with no `high_water_mark` yet (written before this field
  // existed) has no trustworthy floor to compare against — deliberately NOT
  // falling back to `last_validated_at` here (see `nextHighWaterMark`'s
  // comment) — so the guard is inert for it until its next successful
  // activate/refresh seeds one.
  if (rec.high_water_mark !== undefined) {
    const hwm = Date.parse(rec.high_water_mark);
    if (Number.isFinite(hwm) && now < hwm - CLOCK_SKEW_TOLERANCE_MS) {
      return { entitled: false, reason: 'grace-expired' };
    }
  }
  // Known limitation (deferred): a FORWARD clock skew that coincides
  // with a license write bakes a future value into the monotonic high-water-mark
  // (`nextHighWaterMark` never regresses), which then denies a LEGITIMATE user for
  // ~(skew − tolerance) after they correct their clock. This can't be clamped away:
  // without a trusted time source the local clock can't tell a genuine long-offline
  // gap from a forward skew (both look like a jump ahead). Accepted for now —
  // GRACE_MS (7d) remains the primary offline bound, and recovery is
  // deactivate+reactivate or letting the skew age out. A robust fix would key the
  // high-water-mark off Polar's server-provided validation time.
  return { entitled: true, reason: 'granted' };
}

export interface LicenseOps extends LicenseStoreOptions {
  /** Injected fetch (tests). Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injected clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Override the resolved Polar config (tests). */
  config?: PolarConfig;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

function makeClient(ops: LicenseOps): { polar: PolarLicenseClient; cfg: PolarConfig } {
  const cfg = ops.config ?? resolvePolarConfig();
  if (!cfg.organizationId) {
    throw new PolarLicenseError(
      `Licensing is not configured for the '${cfg.env}' environment. ` +
        `Set EDITMAMEI_POLAR_ENV=sandbox to test against the sandbox org.`,
      0,
      'not_configured'
    );
  }
  return { polar: new PolarLicenseClient(cfg, ops.fetchImpl ?? defaultFetch), cfg };
}

/** Boot-path gate: is Pro entitled right now (from the cached verdict)? */
export function isProEntitled(ops: LicenseStoreOptions = {}): boolean {
  return evaluateEntitlement(readLicense(ops), Date.now()).entitled;
}

/** Register this device with Polar, validate, and cache the result. */
export async function activate(key: string, ops: LicenseOps = {}): Promise<LicenseRecord> {
  const trimmed = key.trim();
  if (!trimmed) throw new PolarLicenseError('A license key is required.', 0, 'invalid_license');

  // Idempotent per device. Polar activations stack — they do NOT dedupe by
  // device — so re-running `activate` on a machine already activated with this
  // key would consume the SECOND seat (sandbox-verified footgun). If the cache
  // already holds this key on this device, re-validate instead of activating.
  const existing = readLicense(ops);
  if (existing && existing.key === trimmed && existing.activation_id) {
    const refreshed = await refresh(ops);
    if (refreshed) return refreshed;
  }

  const { polar, cfg } = makeClient(ops);
  const now = ops.now ?? Date.now;
  const deviceHash = computeDeviceHash();
  const activation = await polar.activate(trimmed, deviceHash);
  const v = await polar.validate(trimmed);
  const nowMs = now();
  const rec: LicenseRecord = {
    key: trimmed,
    organization_id: cfg.organizationId,
    status: v.status,
    expires_at: v.expires_at,
    activation_id: activation.id,
    device_hash: deviceHash,
    display_key: v.display_key,
    last_validated_at: new Date(nowMs).toISOString(),
    // Seed the monotonic high-water-mark from whatever this device
    // already recorded (if any) plus now.
    high_water_mark: nextHighWaterMark(existing, nowMs),
  };
  writeLicense(rec, ops);
  return rec;
}

export interface RefreshIfStaleOptions extends LicenseOps {
  /** Injected environment (tests). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injected cap for the awaited grace-expired refresh (tests). */
  expiredRefreshTimeoutMs?: number;
}

/**
 * Boot-path staleness refresh. Before this,
 * `last_validated_at` was written only by `activate()` and the CLI status
 * command — the server boot path never re-validated, so an online Pro
 * customer degraded to CE 30 days after activation and stayed there. The
 * invariant now: *a machine with a cached license and working network never
 * reaches `grace-expired`* — grace is an offline allowance, not a lifespan.
 *
 * Policy, keyed off cache age (REFRESH_AFTER_MS / GRACE_MS):
 *   - **Fresh (≤ 1 day):** nothing. Zero network on steady-state boots.
 *   - **Stale (1–7 days, still entitled):** fire-and-forget `refresh()` —
 *     never delays boot or the MCP handshake; the refreshed timestamp
 *     benefits the NEXT boot. Failures log at WARN and are otherwise
 *     swallowed (offline is normal; grace covers it).
 *   - **Past grace (recoverable):** an awaited attempt (one per trigger —
 *     boot, or a throttled ping) bounded by
 *     `EXPIRED_REFRESH_TIMEOUT_MS`, so a recovering online user gets Pro
 *     back on THIS boot (module resolution reads the cache in the server
 *     constructor, which runs after this). On timeout/failure: proceed as
 *     Community exactly as before, WARN logged.
 *
 * Revoked/disabled records never hit Polar (definitive verdicts don't
 * self-heal by re-validating), and a past `expires_at` needs a purchase,
 * not a validation. A network/HTTP failure never overwrites the cached
 * record (`refresh()` only writes after a successful validate); a
 * definitive Polar verdict DOES update it — that's enforcement, not a
 * regression. Only `validate` is ever called, never `activate` (Polar
 * activations stack — a re-activate here would burn a second seat).
 *
 * No-ops under the test runner (mirrors the telemetry gating pattern) so
 * suite runs can never fire real license traffic; tests inject `env: {}`.
 */
export async function refreshIfStale(ops: RefreshIfStaleOptions = {}): Promise<void> {
  const env = ops.env ?? process.env;
  if (env.VITEST !== undefined || env.NODE_ENV === 'test') return;

  const rec = readLicense(ops);
  if (!rec) return;
  if (rec.status === 'revoked' || rec.status === 'disabled') return;

  const now = (ops.now ?? Date.now)();
  if (rec.expires_at !== null && Date.parse(rec.expires_at) <= now) return;

  const last = Date.parse(rec.last_validated_at);
  const age = Number.isFinite(last) ? now - last : Infinity;
  // Clock-skew guard: a timestamp implausibly far in the FUTURE would
  // read as a negative — and so perpetually "fresh" — age, leaving the record
  // never re-validated behind a wrong clock. Force a refresh instead. The record
  // is still entitled in this case (evaluateEntitlement can't grace-expire a
  // future timestamp), so it takes the background path below, never the awaited
  // recovery path — a mis-clocked user pays no boot latency.
  const clockSkewed = age < -CLOCK_SKEW_TOLERANCE_MS;

  if (!clockSkewed && age <= REFRESH_AFTER_MS) return;

  if (clockSkewed || age <= GRACE_MS) {
    // Still entitled: refresh in the background. Deliberately NOT awaited —
    // this runs ahead of the MCP handshake and must add zero latency to it.
    refresh(ops).catch((err) => {
      logger.warn(
        `Background license refresh failed (grace covers offline use): ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    });
    return;
  }

  // Past grace but recoverable: Pro is already dark, so this boot may pay a
  // bounded wait for the chance to come back online entitled.
  const timeoutMs = ops.expiredRefreshTimeoutMs ?? EXPIRED_REFRESH_TIMEOUT_MS;
  const attempt = refresh(ops);
  // A late settle after the deadline must not become an unhandled rejection.
  attempt.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const winner = await Promise.race([
      attempt,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (winner === 'timeout') {
      logger.warn(
        'License re-validation timed out past the grace window — continuing as Community; the next boot retries.'
      );
    }
  } catch (err) {
    logger.warn(
      `License re-validation failed past the grace window (continuing as Community): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Re-validate the cached key online and refresh the verdict. Returns null if no license. */
export async function refresh(ops: LicenseOps = {}): Promise<LicenseRecord | null> {
  const rec = readLicense(ops);
  if (!rec) return null;
  const { polar } = makeClient(ops);
  const now = ops.now ?? Date.now;
  const v = await polar.validate(rec.key);
  const nowMs = now();
  const updated: LicenseRecord = {
    ...rec,
    status: v.status,
    expires_at: v.expires_at,
    display_key: v.display_key,
    last_validated_at: new Date(nowMs).toISOString(),
    // Never let the high-water-mark move backward, even if this
    // refresh's clock reading is behind what was already recorded.
    high_water_mark: nextHighWaterMark(rec, nowMs),
  };
  writeLicense(updated, ops);
  return updated;
}

/** Free this device's seat with Polar and clear the local cache. */
export async function deactivate(ops: LicenseOps = {}): Promise<boolean> {
  const rec = readLicense(ops);
  if (!rec) return false;
  const { polar } = makeClient(ops);
  try {
    await polar.deactivate(rec.key, rec.activation_id);
  } finally {
    // Always clear locally — even if the network call fails, the user intends
    // to stop using Pro here; the seat reconciles on the next server-side check.
    clearLicense(ops);
  }
  return true;
}
