/**
 * Tokenless client for Polar's customer-portal license-key endpoints.
 *
 * These three endpoints take only `{key, organization_id}` (+ a label /
 * activation_id) and need NO auth token — verified against the sandbox
 * 2026-06-15. So the shipped client
 * carries no Polar secret.
 *
 * The `fetch` implementation is injected so tests run without network.
 */

import type { PolarConfig } from './config.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  /** Response headers — the real fetch Response satisfies this; test doubles may omit. */
  headers?: { get: (name: string) => string | null };
}>;

/** Subset of Polar's `ValidatedLicenseKey` the client depends on. */
export interface ValidatedLicenseKey {
  id: string;
  status: 'granted' | 'revoked' | 'disabled';
  limit_activations: number | null;
  usage: number;
  validations: number;
  expires_at: string | null;
  last_validated_at: string | null;
  display_key: string;
}

/** Polar's `LicenseKeyActivationRead` (subset). */
export interface ActivationResult {
  id: string;
  license_key: { id: string; display_key: string; status: string; expires_at: string | null };
}

export class PolarLicenseError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    /**
     * Stable, machine-readable code for callers; messages are not API.
     *
     * `transient` is the honest code for "the request did not get through" — a
     * throttle (429) or a server-side fault (5xx). Before it existed EVERY non-ok
     * status was coded `invalid_license`, so a caller could not tell a busy
     * endpoint from a bad key, and `withRetry` below would have had nothing to
     * branch on. Definitive refusals keep their existing codes unchanged.
     */
    readonly code:
      'invalid_license' | 'seat_limit_reached' | 'transient' | 'network' | 'not_configured',
    /** From a 429/503 Retry-After header when the server supplied one (ms). */
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'PolarLicenseError';
  }
}

// A descriptive product UA. Polar's CF firewall 403s the bare python-urllib UA
// (error 1010) but accepts named clients; mirror that lesson by always sending one.
const USER_AGENT = 'editmamei-license-client/1';

/**
 * Bounded retry policy for TRANSIENT license failures (a thrown network error or a
 * `transient` 429/5xx). Mirrors the RETRY half of delivery/client.ts's policy, for the
 * same reason: the endpoint throttles per caller, so one refused request is not a
 * verdict on the key — without a retry a single busy moment leaves the cached record
 * unrefreshed, and the next attempt starts from the same place. A server-supplied
 * Retry-After is honored over the exponential schedule; every wait is clamped into
 * [baseDelayMs, maxDelayMs], so neither an absurd nor a zero value from the server
 * can turn the backoff into a hot loop.
 *
 * It does NOT mirror that client's other half, its inter-request pacing — the delivery
 * client fires several requests per operation and has to space them; this one makes a
 * single request per call. Don't read "mirrors delivery" as "both halves are here".
 *
 * Three attempts rather than delivery's four: the endpoint's window is measured in
 * tens of seconds and an honored Retry-After clears it outright, so a second retry
 * adds waiting, not odds.
 */
export interface PolarRetryConfig {
  /** Total attempts including the first (default 3 → up to 2 retries). */
  attempts: number;
  /** Base backoff in ms; doubles each retry (default 1000 → ~1s, 2s). */
  baseDelayMs: number;
  /** Cap on any single backoff wait (ms) — bounds an honored Retry-After. */
  maxDelayMs: number;
}
const DEFAULT_RETRY: PolarRetryConfig = { attempts: 3, baseDelayMs: 1000, maxDelayMs: 65_000 };

export type Sleep = (ms: number) => Promise<void>;
/**
 * An ordinary timer, which holds the process up for the length of the wait.
 *
 * That is what the CLI needs and why this is the default. `withRetry` serves
 * `validate`, and `validate` is what `editmamei activate`, `editmamei license`
 * and `refresh` all run. Those are one-shot commands with nothing else pending:
 * if the backoff timer did not hold the loop open, a transient failure would end
 * the command silently — no output, no retry — instead of succeeding a second
 * later. A long-lived host wants the opposite and opts into `unrefSleep`.
 */
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The same wait on an unref'd timer, for a caller that is checking in behind a
 * long-lived process: a backoff can be a minute long when the server names its
 * own interval, and a host that has already lost its client should not sit out
 * the whole of it before exiting. Opt-in through `PolarClientOptions.sleep`,
 * because nothing else about a background check differs from a foreground one.
 * Same treatment as the race timer in `entitlement.ts`, and the optional call
 * keeps it harmless where `unref` is not a method on the handle.
 */
export const unrefSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export interface PolarClientOptions {
  /** Override the retry policy (tests). Defaults to 3 attempts, 1s exponential backoff. */
  retry?: Partial<PolarRetryConfig>;
  /**
   * Override the backoff wait: `unrefSleep` on a background path, a no-op in
   * tests that should not actually wait. Defaults to a plain timer.
   */
  sleep?: Sleep;
}

export class PolarLicenseClient {
  private readonly retry: PolarRetryConfig;
  private readonly sleep: Sleep;

  constructor(
    private readonly cfg: PolarConfig,
    private readonly fetchImpl: FetchLike,
    opts: PolarClientOptions = {}
  ) {
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /**
   * The ONLY retried endpoint, because it is the only idempotent one: validating
   * twice reads the same verdict twice and costs nothing else. See `post`.
   */
  async validate(key: string): Promise<ValidatedLicenseKey> {
    return this.post<ValidatedLicenseKey>(
      '/customer-portal/license-keys/validate',
      { key, organization_id: this.cfg.organizationId },
      { retry: true }
    );
  }

  async activate(key: string, label: string): Promise<ActivationResult> {
    return this.post<ActivationResult>('/customer-portal/license-keys/activate', {
      key,
      organization_id: this.cfg.organizationId,
      label,
    });
  }

  async deactivate(key: string, activationId: string): Promise<void> {
    await this.post('/customer-portal/license-keys/deactivate', {
      key,
      organization_id: this.cfg.organizationId,
      activation_id: activationId,
    });
  }

  /**
   * Retries are OPT-IN per endpoint, and only `validate` opts in.
   *
   * Activations stack rather than dedupe by device (see `activate` in
   * entitlement.ts), so they are not idempotent: a request that reaches the
   * server and then fails on the way back — a reset connection, a 5xx from a
   * proxy — has already consumed a seat. Retrying it would quietly consume the
   * user's second one and leave their other machine refused at the seat cap with
   * no visible cause. Deactivate is the same shape in reverse. A retry there
   * would buy a rare recovery at the cost of a silent, hard-to-diagnose failure,
   * which is a bad trade; the endpoint pressure this policy exists to relieve is
   * on `validate`, which every boot calls and neither of the others does.
   */
  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    opts: { retry?: boolean } = {}
  ): Promise<T> {
    const once = () => this.postOnce<T>(path, body);
    return opts.retry === true ? this.withRetry(once) : once();
  }

  /**
   * Run `fn`, retrying ONLY on transient failures: a thrown network error or a
   * `transient` 429/5xx. A definitive refusal — a bad key, a revoked key, a seat
   * cap — is NEVER retried: the answer will not change, and repeating it only
   * spends the caller's request budget. Honors a server-supplied Retry-After when
   * present, else exponential backoff — both capped by maxDelayMs. The sleep is
   * injectable so tests don't actually wait.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    // At least one attempt, whatever an injected config says — a zero here would
    // skip the loop entirely and throw an undefined `lastErr`.
    const attempts = Math.max(1, this.retry.attempts);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const transient =
          err instanceof PolarLicenseError && (err.code === 'network' || err.code === 'transient');
        if (!transient || attempt === attempts) throw err;
        const retryAfter = err instanceof PolarLicenseError ? err.retryAfterMs : undefined;
        const delay = retryAfter ?? this.retry.baseDelayMs * 2 ** (attempt - 1);
        // Clamped at BOTH ends. The upper bound stops an absurd Retry-After from
        // parking the caller; the lower one matters just as much, because the
        // server's value is attacker-influenced input and a `Retry-After: 0`
        // would otherwise mean three back-to-back requests at the one endpoint
        // this policy exists to stop hammering.
        const wait = Math.min(Math.max(delay, this.retry.baseDelayMs), this.retry.maxDelayMs);
        await this.sleep(wait);
      }
    }
    throw lastErr;
  }

  /** Parse a Retry-After header (delta-seconds form) into ms, if present and valid. */
  private retryAfterMsOf(res: {
    headers?: { get: (name: string) => string | null };
  }): number | undefined {
    const raw = res.headers?.get('retry-after');
    if (!raw) return undefined;
    const secs = Number(raw);
    return Number.isFinite(secs) && secs >= 0 ? Math.round(secs * 1000) : undefined;
  }

  private async postOnce<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: {
      ok: boolean;
      status: number;
      text: () => Promise<string>;
      headers?: { get: (name: string) => string | null };
    };
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new PolarLicenseError(
        `Could not reach the license server: ${err instanceof Error ? err.message : String(err)}`,
        0,
        'network'
      );
    }

    const text = await res.text();
    if (res.ok) {
      return (text ? JSON.parse(text) : {}) as T;
    }

    // 403 on activate = seat cap reached (hard, server-enforced).
    if (res.status === 403 && /activation limit/i.test(text)) {
      throw new PolarLicenseError(
        'This license is already on its maximum of 2 devices. Free a seat by running ' +
          '`editmamei deactivate` on one of them, or remove a device in your account portal ' +
          "(the 'Manage' link in your purchase email).",
        403,
        'seat_limit_reached'
      );
    }
    // A throttle (429) or a server-side fault (5xx) says nothing about the key —
    // the request simply did not get through. Coded `transient` so `withRetry`
    // above waits and tries again instead of surfacing it as a refusal, and so a
    // caller that persists it can honor the server's own Retry-After.
    if (res.status === 429 || res.status >= 500) {
      throw new PolarLicenseError(
        `License check could not complete (HTTP ${res.status}).`,
        res.status,
        'transient',
        this.retryAfterMsOf(res)
      );
    }
    throw new PolarLicenseError(
      `License check failed (HTTP ${res.status}).`,
      res.status,
      'invalid_license'
    );
  }
}
