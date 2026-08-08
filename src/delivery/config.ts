/**
 * Delivery-service endpoint config. The `editmamei-delivery` Worker re-validates
 * the presented license key against Polar (tokenless) and serves the entitled
 * encrypted Pro module + content key + manifest. We carry no secret — just the
 * base origin, overridable for local `wrangler dev` and the eventual prod swap.
 *
 * `EDITMAMEI_DELIVERY_URL` overrides the baked default (origin only, no path —
 * the client appends `/v1/modules/...`). Point it at `http://localhost:8787` to
 * exercise the loop against a locally-running Worker.
 */

export interface DeliveryConfig {
  /** Origin with no trailing slash and no `/v1` suffix. */
  baseUrl: string;
}

// The deployed editmamei-delivery Worker (Phase B, live 2026-06-18). Overridable
// via EDITMAMEI_DELIVERY_URL (e.g. http://localhost:8787 for local wrangler dev).
// The cleaner custom domain (delivery.editmamei.com) awaits the registrar→CF zone move.
const DEFAULT_BASE_URL = 'https://editmamei-delivery.editmamei.workers.dev';

export function resolveDeliveryConfig(
  url: string | undefined = process.env.EDITMAMEI_DELIVERY_URL
): DeliveryConfig {
  const baseUrl = (url ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  assertSecureEndpoint(baseUrl);
  return { baseUrl };
}

/**
 * Refuse a plaintext delivery origin. The license key rides in the
 * `x-editmamei-license-key` request header and the content-key endpoint returns
 * the AES module key in the response body — neither may cross an `http://` origin.
 * `https` is required for any non-loopback host; `http://localhost` (and the
 * 127.0.0.0/8 + ::1 loopback forms) stays allowed for local `wrangler dev`. An
 * empty baseUrl (Phase A / unconfigured) is left for the client's
 * `not_configured` handling, not rejected here.
 */
function assertSecureEndpoint(baseUrl: string): void {
  if (!baseUrl) return;
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`EDITMAMEI_DELIVERY_URL is not a valid URL: ${baseUrl}`);
  }
  if (u.protocol === 'https:') return;
  const host = u.hostname;
  const isLoopback =
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  if (u.protocol === 'http:' && isLoopback) return;
  throw new Error(
    `EDITMAMEI_DELIVERY_URL must use https (got ${u.protocol}//${host}); ` +
      'plaintext http is allowed only for localhost during local development.'
  );
}
