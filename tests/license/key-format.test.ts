import { describe, it, expect } from 'vitest';
import {
  isLicenseKeyFormat,
  isUnfilledPlaceholder,
  LICENSE_KEY_EXAMPLE,
} from '@editmamei/license/key-format.ts';

const GOOD = 'EDIT-0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D';

describe('isLicenseKeyFormat', () => {
  it('accepts the issued production shape, in either case', () => {
    expect(isLicenseKeyFormat(GOOD)).toBe(true);
    expect(isLicenseKeyFormat(GOOD.toLowerCase())).toBe(true);
    expect(GOOD).toHaveLength(LICENSE_KEY_EXAMPLE.length);
  });

  it.each([
    ['empty', ''],
    ['unfilled placeholder', '${user_config.license_key}'],
    ['no prefix', GOOD.slice(5)],
    ['other prefix', `ETTA-${GOOD.slice(5)}`],
    ['prefix without dash', `EDIT${GOOD.slice(5)}`],
    ['truncated', GOOD.slice(0, -1)],
    ['extra character', `${GOOD}0`],
    ['non-hex', GOOD.replace('0A1B', '0G1B')],
    ['surrounding space', ` ${GOOD}`],
    ['trailing newline', `${GOOD}\n`],
    ['example text', LICENSE_KEY_EXAMPLE],
  ])('rejects %s in production', (_label, key) => {
    expect(isLicenseKeyFormat(key)).toBe(false);
  });

  it('sandbox needs only the UUID, with or without a prefix', () => {
    expect(isLicenseKeyFormat(GOOD.slice(5), 'sandbox')).toBe(true);
    expect(isLicenseKeyFormat(`ETTA-${GOOD.slice(5)}`, 'sandbox')).toBe(true);
    expect(isLicenseKeyFormat('ETTA-KEY', 'sandbox')).toBe(false);
    expect(isLicenseKeyFormat('${user_config.license_key}', 'sandbox')).toBe(false);
  });
});

describe('isUnfilledPlaceholder', () => {
  it('matches an unreplaced host variable only', () => {
    expect(isUnfilledPlaceholder('${user_config.license_key}')).toBe(true);
    expect(isUnfilledPlaceholder('${anything}')).toBe(true);
    expect(isUnfilledPlaceholder(GOOD)).toBe(false);
    expect(isUnfilledPlaceholder('x${user_config.license_key}')).toBe(false);
    expect(isUnfilledPlaceholder('')).toBe(false);
  });
});
