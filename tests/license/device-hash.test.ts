import { describe, it, expect } from 'vitest';
import {
  hashDeviceInputs,
  computeDeviceHash,
  gatherDeviceInputs,
} from '@editmamei/license/device-hash.ts';

const base = { platform: 'win32', arch: 'x64', hostname: 'PC-A', username: 'alice' };

describe('device hash', () => {
  it('is deterministic for identical inputs', () => {
    expect(hashDeviceInputs(base)).toBe(hashDeviceInputs({ ...base }));
  });

  it('is 32 lowercase hex chars and opaque (does not leak the inputs)', () => {
    const h = hashDeviceInputs(base);
    expect(h).toMatch(/^[a-f0-9]{32}$/);
    expect(h).not.toContain('PC-A');
    expect(h).not.toContain('alice');
  });

  it('differs when any single input differs', () => {
    expect(hashDeviceInputs(base)).not.toBe(hashDeviceInputs({ ...base, hostname: 'PC-B' }));
    expect(hashDeviceInputs(base)).not.toBe(hashDeviceInputs({ ...base, username: 'bob' }));
  });

  it('computeDeviceHash gathers real machine facts and hashes them', () => {
    expect(computeDeviceHash()).toMatch(/^[a-f0-9]{32}$/);
    expect(gatherDeviceInputs().platform).toBe(process.platform);
  });
});
