import { describe, it, expect } from 'vitest';
import { GimpError } from '@editmamei/backends/gimp/errors.ts';

describe('GimpError', () => {
  it('prefixes the message with the code, per the client-side classifier contract', () => {
    const err = new GimpError('gimp_timeout', 'curves did not respond within 30000ms');
    expect(err.message).toBe('gimp_timeout: curves did not respond within 30000ms');
    expect(err.code).toBe('gimp_timeout');
    expect(err.name).toBe('GimpError');
    expect(err).toBeInstanceOf(Error);
  });
});
