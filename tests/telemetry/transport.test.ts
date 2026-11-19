import { describe, it, expect } from 'vitest';
import { resolveEndpoint, DEFAULT_TELEMETRY_ENDPOINT } from '@editmamei/telemetry/transport.ts';

describe('resolveEndpoint', () => {
  it('uses the default when no override is set', () => {
    expect(resolveEndpoint({})).toBe(DEFAULT_TELEMETRY_ENDPOINT);
    expect(resolveEndpoint({ EDITMAMEI_TELEMETRY_URL: '' })).toBe(DEFAULT_TELEMETRY_ENDPOINT);
  });

  it('honors an https override and a localhost http one', () => {
    expect(resolveEndpoint({ EDITMAMEI_TELEMETRY_URL: 'https://t.example/v1/telemetry' })).toBe(
      'https://t.example/v1/telemetry'
    );
    expect(resolveEndpoint({ EDITMAMEI_TELEMETRY_URL: 'http://localhost:8787/v1/telemetry' })).toBe(
      'http://localhost:8787/v1/telemetry'
    );
  });

  it.each(['http://t.example/v1/telemetry', 'not a url', 'ftp://t.example'])(
    'refuses %s: null, so nothing is sent (not the default either)',
    (url) => {
      expect(resolveEndpoint({ EDITMAMEI_TELEMETRY_URL: url })).toBeNull();
    }
  );
});
