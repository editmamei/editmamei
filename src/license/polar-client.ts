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
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

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
    /** Stable, machine-readable code for callers; messages are not API. */
    readonly code: 'invalid_license' | 'seat_limit_reached' | 'network' | 'not_configured'
  ) {
    super(message);
    this.name = 'PolarLicenseError';
  }
}

// A descriptive product UA. Polar's CF firewall 403s the bare python-urllib UA
// (error 1010) but accepts named clients; mirror that lesson by always sending one.
const USER_AGENT = 'editmamei-license-client/1';

export class PolarLicenseClient {
  constructor(
    private readonly cfg: PolarConfig,
    private readonly fetchImpl: FetchLike
  ) {}

  async validate(key: string): Promise<ValidatedLicenseKey> {
    return this.post<ValidatedLicenseKey>('/customer-portal/license-keys/validate', {
      key,
      organization_id: this.cfg.organizationId,
    });
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

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: { ok: boolean; status: number; text: () => Promise<string> };
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
    throw new PolarLicenseError(
      `License check failed (HTTP ${res.status}).`,
      res.status,
      'invalid_license'
    );
  }
}
