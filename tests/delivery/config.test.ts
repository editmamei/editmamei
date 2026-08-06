import { describe, it, expect } from 'vitest';
import { resolveDeliveryConfig } from '@editmamei/delivery/config.ts';

/**
 * The delivery endpoint carries the license key (request header) and returns the
 * AES content key (response body) — so it must never be a plaintext origin
 * (audit M2). resolveDeliveryConfig enforces https for non-loopback hosts.
 */
describe('resolveDeliveryConfig — transport security (M2)', () => {
  it('accepts the baked https default and strips a trailing slash', () => {
    expect(resolveDeliveryConfig(undefined).baseUrl).toMatch(/^https:\/\//);
    expect(resolveDeliveryConfig('https://example.com/').baseUrl).toBe('https://example.com');
  });

  it('allows http only for loopback (local wrangler dev)', () => {
    expect(resolveDeliveryConfig('http://localhost:8787').baseUrl).toBe('http://localhost:8787');
    expect(resolveDeliveryConfig('http://127.0.0.1:8787').baseUrl).toBe('http://127.0.0.1:8787');
  });

  it('rejects a plaintext http origin for a non-loopback host', () => {
    expect(() => resolveDeliveryConfig('http://evil.example.com')).toThrow(/must use https/);
    expect(() => resolveDeliveryConfig('http://10.0.0.5:8787')).toThrow(/must use https/);
  });

  it('rejects a malformed URL', () => {
    expect(() => resolveDeliveryConfig('not a url')).toThrow(/not a valid URL/);
  });

  it('leaves an empty baseUrl for the client not_configured path', () => {
    expect(resolveDeliveryConfig('').baseUrl).toBe('');
  });
});
