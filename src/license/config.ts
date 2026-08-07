/**
 * Polar environment config for the license client.
 *
 * The customer-portal validate/activate/deactivate endpoints are TOKENLESS
 * (Polar's root security is `none`) — they take only `{key, organization_id}`,
 * so the org id + base URL are NOT secrets and ship as plain constants,
 * selected by `EDITMAMEI_POLAR_ENV` (default `'production'`).
 *
 * Verified live against the Polar sandbox 2026-06-15.
 */

export type PolarEnv = 'sandbox' | 'production';

export interface PolarConfig {
  env: PolarEnv;
  /** Includes the `/v1` suffix; endpoints append `/customer-portal/...`. */
  baseUrl: string;
  organizationId: string;
}

const SANDBOX: PolarConfig = {
  env: 'sandbox',
  baseUrl: 'https://sandbox-api.polar.sh/v1',
  // The `Etta-Test` sandbox org used for the Phase-A end-to-end dry run.
  organizationId: 'f814c9e6-34a6-4c13-aeb6-0d227530a0dd',
};

const PRODUCTION: PolarConfig = {
  env: 'production',
  baseUrl: 'https://api.polar.sh/v1',
  // The production `editmamei` Polar org (set 2026-06-18). NOT a secret — the
  // tokenless customer-portal validate/activate endpoints take
  // `{key, organization_id}` as a plain body, so the org id ships as a constant.
  organizationId: 'efc29ca1-0ee6-4fe8-8668-c3089c552227',
};

/**
 * Resolve the active Polar config. `EDITMAMEI_POLAR_ENV=sandbox` selects the
 * sandbox org; anything else (incl. unset) selects production.
 */
export function resolvePolarConfig(
  env: string | undefined = process.env.EDITMAMEI_POLAR_ENV
): PolarConfig {
  return env === 'sandbox' ? SANDBOX : PRODUCTION;
}
