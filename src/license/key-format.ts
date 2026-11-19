/**
 * The shape a license key must have before it is sent anywhere.
 *
 * Polar issues keys as `<PREFIX>-<UUID>`, upper case. Production keys carry the
 * `EDIT` prefix. The sandbox org is a test fixture whose prefix isn't pinned, so
 * it only requires the UUID. Matching is case-insensitive and the value is never
 * rewritten: a key that passes is sent exactly as the user entered it.
 */

import type { PolarEnv } from './config.js';

const UUID = '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}';

const KEY_FORMAT: Record<PolarEnv, RegExp> = {
  production: new RegExp(`^EDIT-${UUID}$`, 'i'),
  sandbox: new RegExp(`^(?:[A-Z0-9]+-)?${UUID}$`, 'i'),
};

/** What a production key looks like, for error messages. */
export const LICENSE_KEY_EXAMPLE = 'EDIT-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX';

export function isLicenseKeyFormat(key: string, env: PolarEnv = 'production'): boolean {
  return KEY_FORMAT[env].test(key);
}

/**
 * True for a host config variable that was never substituted, such as
 * `${user_config.license_key}`. An MCPB host leaves that literal in place when
 * an optional field without a default was never filled in, so it means "no key".
 */
export function isUnfilledPlaceholder(value: string): boolean {
  return /^\$\{[^}]*\}$/.test(value);
}
