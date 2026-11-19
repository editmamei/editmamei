import { describe, it, expect } from 'vitest';
import { isSecureEndpoint, isLoopbackHost } from '@editmamei/utils/secure-endpoint.ts';

describe('isSecureEndpoint', () => {
  it.each([
    'https://example.com/v1/telemetry',
    'https://example.com:8443',
    'http://localhost:8787',
    'http://127.0.0.1:8787/x',
    'http://127.5.6.7',
    'http://[::1]:8787',
  ])('accepts %s', (url) => {
    expect(isSecureEndpoint(url)).toBe(true);
  });

  it.each([
    'http://example.com',
    'http://192.168.1.10:8787',
    'http://localhost.example.com',
    'http://127.0.0.1.example.com',
    'ftp://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'example.com',
    '',
    'not a url',
    '${user_config.telemetry_url}',
  ])('refuses %s', (url) => {
    expect(isSecureEndpoint(url)).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it('matches only loopback names', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
    expect(isLoopbackHost('localhost.example.com')).toBe(false);
  });
});
