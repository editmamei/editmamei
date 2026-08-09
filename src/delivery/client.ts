/**
 * Client for the `editmamei-delivery` Worker. Three GET endpoints, all gated by
 * the license key in the `x-editmamei-license-key` header (out of the URL so it
 * never lands in access logs). The Worker re-validates the key against Polar
 * before serving — we carry no Polar secret here either.
 *
 * Contract mirrors license-server/src/routes/modules.ts + types.ts:
 *   GET /v1/modules/manifest        → entitled catalog (versions, hashes, abi)
 *   GET /v1/modules/:sku/:version   → encrypted artifact bytes (IV||ct||tag)
 *   GET /v1/modules/:sku/key        → { alg, key } content key
 *
 * `fetch` is injected so tests run without network.
 */

import { resolveDeliveryConfig, type DeliveryConfig } from './config.js';
import type { ModuleFileDigest } from './signing.js';

export interface DeliveryResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
  /** Response headers — the real fetch Response satisfies this; test doubles may omit. */
  headers?: { get: (name: string) => string | null };
  /**
   * Streamed body — the real fetch Response satisfies this. `fetchArtifact`
   * reads it chunk-by-chunk to enforce the byte cap DURING the fetch
   * rather than after `arrayBuffer()` has already allocated the
   * whole thing. Test doubles may omit it (falls back to `arrayBuffer()`,
   * still cap-checked, just after allocation).
   */
  body?: ReadableStream<Uint8Array> | null;
}

export type DeliveryFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> }
) => Promise<DeliveryResponse>;

/** One module's manifest entry (subset of the Worker's ModuleManifestEntry). */
export interface ModuleVersionEntry {
  object: string;
  sha256: string;
  size: number;
  /**
   * Detached base64 Ed25519 signature over (sku, version, sha256) from the
   * maintainer's offline key — the host verifies it against a pinned public key
   * before installing (see delivery/signing.ts). Optional on the wire
   * (older manifests omit it); a missing signature fails verification → the
   * module is refused, never silently installed.
   */
  sig?: string;
  /**
   * v2 boot-fast-path fields (both optional; older manifests omit both). `files`
   * is the per-file digest list of the STAGED (unencrypted) module tree; `sig_v2`
   * is a detached Ed25519 signature over (sku, version, sha256, digestsRoot) —
   * see delivery/signing.ts. provision.ts verifies `sig_v2` before persisting
   * either field to installed.json; store.ts's `loadVerifiedModule` uses them,
   * once persisted, to skip the decrypt+regen on a boot where the on-disk tree
   * still matches. Unknown-field-tolerant: a missing/invalid pair never blocks
   * install — it just falls back to the always-required v1 full-regen path.
   */
  files?: ModuleFileDigest[];
  sig_v2?: string;
}
export interface ModuleManifestEntry {
  latest: string;
  abi: number;
  versions: Record<string, ModuleVersionEntry>;
}
export interface DeliveryManifest {
  generated_at: string;
  modules: Record<string, ModuleManifestEntry>;
  license: { status: string; expires_at: string | null };
}

export interface ModuleContentKey {
  alg: string;
  key: string;
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    /**
     * Stable code for callers; messages are not API. `server` keeps the grace
     * cache. `oversize` is a client-side refusal (declared or streamed body
     * exceeds the artifact byte cap) — never retried, same as
     * not_entitled/not_found.
     */
    readonly code:
      'not_entitled' | 'not_found' | 'server' | 'network' | 'not_configured' | 'oversize',
    /** From a 429/503 Retry-After header when the server supplied one (ms). */
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/**
 * Hard cap on a downloaded artifact body, enforced DURING the fetch.
 * `fetchArtifact` used to buffer the whole response with
 * `arrayBuffer()` and only check the size afterward, so a hostile/MITM'd
 * delivery endpoint could stream a multi-GB body and OOM the host before the
 * sha256/signature gates in provision.ts ever ran. Mirrors provision.ts's own
 * `MAX_ARTIFACT_BYTES` (defense-in-depth there, on the already-realized blob);
 * kept as a separate constant here rather than imported, to avoid a circular
 * import — provision.ts already imports DeliveryClient/DeliveryError from
 * this module. Overridable per-client via `maxArtifactBytes` (tests use a
 * small value so fixtures stay tiny).
 */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

// Named UA for parity with the license client (CF 1010-blocks bare urllib UAs).
const USER_AGENT = 'editmamei-delivery-client/1';
const HEADER_KEY = 'x-editmamei-license-key';

const defaultFetch: DeliveryFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<DeliveryResponse>;

/**
 * Bounded retry policy for TRANSIENT delivery failures (a thrown network error or a 5xx
 * 'server' error — which includes a Polar throttle the worker maps 429→503). Provision fires
 * manifest+artifact+key back-to-back and each re-validates against Polar; the backoff lets a
 * throttle window clear (slice-3e e2e, 2026-06-18). A server-supplied Retry-After is honored
 * over the exponential schedule; both are capped by maxDelayMs.
 */
export interface RetryConfig {
  /** Total attempts including the first (default 4 → up to 3 retries). */
  attempts: number;
  /** Base backoff in ms; doubles each retry (default 1000 → ~1s, 2s, 4s). */
  baseDelayMs: number;
  /** Cap on any single backoff wait (ms) — bounds an honored Retry-After. */
  maxDelayMs: number;
}
const DEFAULT_RETRY: RetryConfig = { attempts: 4, baseDelayMs: 1000, maxDelayMs: 65_000 };

/**
 * Minimum gap between delivery requests (client-side pacing). Per the Polar docs the
 * validate/activate/deactivate endpoints are limited to 3 req/sec, and the worker re-validates
 * on EVERY delivery request — so an unpaced provision burst (refresh + manifest + artifact +
 * key = 4 validates in <1s) trips a ~59s throttle. Spacing requests ≥500ms keeps any sliding
 * 1s window at ≤3 validates, so a normal provision never trips it. (slice-3e e2e, 2026-06-18.)
 */
const DEFAULT_MIN_INTERVAL_MS = 500;

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DeliveryClient {
  private readonly cfg: DeliveryConfig;
  private readonly fetchImpl: DeliveryFetch;
  private readonly retry: RetryConfig;
  private readonly sleep: Sleep;
  private readonly minIntervalMs: number;
  private readonly maxArtifactBytes: number;
  private lastRequestAt = 0;

  constructor(
    opts: {
      config?: DeliveryConfig;
      fetchImpl?: DeliveryFetch;
      /** Override the retry policy (tests). Defaults to 4 attempts, 1s exponential backoff. */
      retry?: Partial<RetryConfig>;
      /** Injected backoff/pacing delay (tests pass a no-op so they don't actually wait). */
      sleep?: Sleep;
      /** Min ms between requests (client-side rate pacing). Tests may set 0 to disable. */
      minRequestIntervalMs?: number;
      /** Override the artifact byte cap (tests use a small value so cap-sized fixtures stay tiny). Defaults to MAX_ARTIFACT_BYTES. */
      maxArtifactBytes?: number;
    } = {}
  ) {
    this.cfg = opts.config ?? resolveDeliveryConfig();
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.sleep = opts.sleep ?? defaultSleep;
    this.minIntervalMs = opts.minRequestIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxArtifactBytes = opts.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
    if (!this.cfg.baseUrl) {
      throw new DeliveryError(
        'Delivery endpoint is not configured. Set EDITMAMEI_DELIVERY_URL ' +
          '(e.g. http://localhost:8787 for a local wrangler dev Worker).',
        0,
        'not_configured'
      );
    }
  }

  async fetchManifest(key: string): Promise<DeliveryManifest> {
    return this.withRetry(async () => {
      const res = await this.get('/v1/modules/manifest', key);
      return JSON.parse(await this.bodyOrThrow(res)) as DeliveryManifest;
    });
  }

  async fetchKey(key: string, sku: string): Promise<ModuleContentKey> {
    return this.withRetry(async () => {
      const res = await this.get(`/v1/modules/${sku}/key`, key);
      return JSON.parse(await this.bodyOrThrow(res)) as ModuleContentKey;
    });
  }

  /** The encrypted artifact bytes (IV||ct||tag). */
  async fetchArtifact(key: string, sku: string, version: string): Promise<Uint8Array> {
    return this.withRetry(async () => {
      const res = await this.get(`/v1/modules/${sku}/${version}`, key);
      if (!res.ok) throw this.errorFor(res.status, await safeText(res), this.retryAfterMsOf(res));
      // Reject a DECLARED oversize before reading any body bytes. Content-Length
      // is attacker-influenced (same trust level as the manifest's vEntry.size in
      // provision.ts) so this is a cheap early-out, not the real gate — the streaming
      // counter below is what actually bounds peak memory when it's absent or lies low.
      const declared = Number(res.headers?.get('content-length'));
      if (Number.isFinite(declared) && declared > this.maxArtifactBytes) {
        throw this.oversizeError(res.status, declared);
      }
      const body = res.body;
      if (!body) {
        // Test doubles (and any fetch-like impl without a streamable body) fall back to
        // buffering whole — still cap-checked, just after allocation like the old path.
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > this.maxArtifactBytes) throw this.oversizeError(res.status, buf.length);
        return buf;
      }
      return await this.readCapped(body, res.status);
    });
  }

  /**
   * Read `body` chunk-by-chunk with a running byte counter instead of
   * `arrayBuffer()`'s whole-body allocation — the moment the running total
   * exceeds the cap, cancel the underlying stream and throw, so a hostile/MITM'd
   * endpoint can never get the host to buffer more than `maxArtifactBytes`.
   */
  private async readCapped(body: ReadableStream<Uint8Array>, status: number): Promise<Uint8Array> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxArtifactBytes) {
          try {
            await reader.cancel('artifact exceeds byte cap');
          } catch {
            // best-effort — we're already refusing the artifact
          }
          throw this.oversizeError(status, total);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  private oversizeError(status: number, sizeBytes: number): DeliveryError {
    return new DeliveryError(
      `Artifact exceeds the ${this.maxArtifactBytes}-byte cap (${sizeBytes} bytes) — refusing to buffer further.`,
      status,
      'oversize'
    );
  }

  /**
   * Run `fn`, retrying ONLY on transient delivery failures: a thrown network error or a 5xx
   * 'server' error (which includes a Polar throttle the worker maps 429→503). Terminal refusals
   * (not_entitled / not_found) are never retried. Honors a server-supplied Retry-After when
   * present (Polar's 429 → worker 503 passthrough), else exponential backoff — both capped by
   * maxDelayMs. The sleep is injectable so tests don't actually wait.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const transient =
          err instanceof DeliveryError && (err.code === 'network' || err.code === 'server');
        if (!transient || attempt === this.retry.attempts) throw err;
        const retryAfter = err instanceof DeliveryError ? err.retryAfterMs : undefined;
        const delay = retryAfter ?? this.retry.baseDelayMs * 2 ** (attempt - 1);
        await this.sleep(Math.min(delay, this.retry.maxDelayMs));
      }
    }
    throw lastErr;
  }

  private async get(path: string, key: string): Promise<DeliveryResponse> {
    // Client-side pacing: stay under Polar's documented 3 req/sec on the chain of
    // re-validations the worker performs per delivery request (see DEFAULT_MIN_INTERVAL_MS).
    const sinceLast = Date.now() - this.lastRequestAt;
    if (sinceLast < this.minIntervalMs) await this.sleep(this.minIntervalMs - sinceLast);
    this.lastRequestAt = Date.now();
    try {
      return await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, [HEADER_KEY]: key },
      });
    } catch (err) {
      throw new DeliveryError(
        `Could not reach the delivery server: ${err instanceof Error ? err.message : String(err)}`,
        0,
        'network'
      );
    }
  }

  private async bodyOrThrow(res: DeliveryResponse): Promise<string> {
    const text = await res.text();
    if (res.ok) return text;
    throw this.errorFor(res.status, text, this.retryAfterMsOf(res));
  }

  /** Parse a Retry-After header (delta-seconds form) into ms, if present and valid. */
  private retryAfterMsOf(res: DeliveryResponse): number | undefined {
    const raw = res.headers?.get('retry-after');
    if (!raw) return undefined;
    const secs = Number(raw);
    return Number.isFinite(secs) && secs >= 0 ? Math.round(secs * 1000) : undefined;
  }

  private errorFor(status: number, _text: string, retryAfterMs?: number): DeliveryError {
    if (status === 403) {
      return new DeliveryError(
        'This license is not entitled to the requested module.',
        403,
        'not_entitled'
      );
    }
    if (status === 404) {
      return new DeliveryError('Requested module/version was not found.', 404, 'not_found');
    }
    // 5xx (incl. Polar upstream_unavailable / a throttle the worker mapped 429→503) is transient
    // — callers keep their grace cache rather than treating it as a revocation; the retry honors
    // any Retry-After carried on the response.
    return new DeliveryError(
      `Delivery request failed (HTTP ${status}).`,
      status,
      'server',
      retryAfterMs
    );
  }
}

async function safeText(res: DeliveryResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
