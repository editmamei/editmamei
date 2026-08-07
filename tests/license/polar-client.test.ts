import { describe, it, expect } from 'vitest';
import { PolarLicenseClient, type FetchLike } from '@editmamei/license/polar-client.ts';
import type { PolarConfig } from '@editmamei/license/config.ts';

const cfg: PolarConfig = {
  env: 'sandbox',
  baseUrl: 'https://api.test/v1',
  organizationId: 'org_x',
};

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function fake(status: number, body: unknown): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

const VALIDATED = {
  id: 'lk',
  status: 'granted',
  limit_activations: 2,
  usage: 0,
  validations: 1,
  expires_at: null,
  last_validated_at: null,
  display_key: '****-X',
};

describe('PolarLicenseClient', () => {
  it('validate posts {key, organization_id} tokenless to the customer-portal endpoint', async () => {
    const { fetchImpl, calls } = fake(200, VALIDATED);
    const v = await new PolarLicenseClient(cfg, fetchImpl).validate('K');
    expect(v.status).toBe('granted');
    expect(calls[0].url).toBe('https://api.test/v1/customer-portal/license-keys/validate');
    expect(JSON.parse(calls[0].init.body)).toEqual({ key: 'K', organization_id: 'org_x' });
    // tokenless: no Authorization header, but a UA is set (Cloudflare 1010 lesson)
    expect(calls[0].init.headers.authorization).toBeUndefined();
    expect(calls[0].init.headers['user-agent']).toBeTruthy();
  });

  it('activate includes the device label', async () => {
    const { fetchImpl, calls } = fake(200, {
      id: 'act',
      license_key: { id: 'lk', display_key: '****-X', status: 'granted', expires_at: null },
    });
    await new PolarLicenseClient(cfg, fetchImpl).activate('K', 'devhash');
    expect(calls[0].url).toContain('/customer-portal/license-keys/activate');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      key: 'K',
      organization_id: 'org_x',
      label: 'devhash',
    });
  });

  it('deactivate posts the activation id', async () => {
    const { fetchImpl, calls } = fake(200, {});
    await new PolarLicenseClient(cfg, fetchImpl).deactivate('K', 'act_9');
    expect(calls[0].url).toContain('/deactivate');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      key: 'K',
      organization_id: 'org_x',
      activation_id: 'act_9',
    });
  });

  it('maps the 3rd-device 403 to seat_limit_reached', async () => {
    const { fetchImpl } = fake(403, {
      error: 'NotPermitted',
      detail: 'License key activation limit already reached',
    });
    await expect(new PolarLicenseClient(cfg, fetchImpl).activate('K', 'd')).rejects.toMatchObject({
      code: 'seat_limit_reached',
      httpStatus: 403,
    });
  });

  it('maps a generic non-OK to invalid_license', async () => {
    const { fetchImpl } = fake(404, { error: 'NotFound' });
    await expect(new PolarLicenseClient(cfg, fetchImpl).validate('K')).rejects.toMatchObject({
      code: 'invalid_license',
    });
  });

  it('maps a thrown fetch to network', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(new PolarLicenseClient(cfg, fetchImpl).validate('K')).rejects.toMatchObject({
      code: 'network',
    });
  });
});
