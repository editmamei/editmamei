/**
 * Telemetry transport — the actual network egress, isolated behind one injectable
 * function so the client logic is testable without a socket and the single place that
 * touches `fetch` is auditable.
 *
 * Honest framing (see docs/privacy.md, "Where it goes"): the MCP server — the process actually
 * running during use — sends its own telemetry, async and fire-and-forget. There is no
 * separate uploader daemon. The send is best-effort: a timeout or network error is
 * swallowed by the caller; telemetry must never break or block a tool call.
 */

import { isSecureEndpoint } from '../utils/secure-endpoint.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('Telemetry');

/**
 * Resolve the ingest endpoint: env override (EDITMAMEI_TELEMETRY_URL) wins, else the
 * baked production default.
 *
 * The default points at the deployed Worker's `workers.dev` hostname (account subdomain
 * renamed to `editmamei`). editmamei.com's DNS lives at the registrar (the site is on
 * GitHub Pages), so the `telemetry.editmamei.com` custom domain isn't available without
 * moving the whole zone to Cloudflare. The workers.dev URL is invisible backend plumbing.
 * If the zone eventually moves to Cloudflare (Pro-infra roadmap), switch this to
 * `https://telemetry.editmamei.com/v1/telemetry` and add the Worker custom domain.
 */
export const DEFAULT_TELEMETRY_ENDPOINT =
  'https://editmamei-telemetry-server.editmamei.workers.dev/v1/telemetry';

/**
 * An override that isn't https (or http to localhost) gives null: nothing is sent, rather than
 * sending to an unsafe address or quietly to the default the override was set to avoid.
 */
export function resolveEndpoint(
  env: Record<string, string | undefined> = process.env
): string | null {
  const override = env.EDITMAMEI_TELEMETRY_URL;
  if (!override) return DEFAULT_TELEMETRY_ENDPOINT;
  if (isSecureEndpoint(override)) return override;
  logger.warn('EDITMAMEI_TELEMETRY_URL is not an https URL; telemetry is off for this session');
  return null;
}

/** Sends a JSON body to the endpoint. Resolves on a 2xx; throws on anything else. */
export type TelemetryTransport = (url: string, body: string) => Promise<void>;

export function httpTransport(timeoutMs = 4000): TelemetryTransport {
  return async (url, body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`telemetry endpoint returned ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
