import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readLicense,
  writeLicense,
  clearLicense,
  licensePath,
  nextHighWaterMark,
  type LicenseRecord,
} from '@editmamei/license/store.ts';

const rec: LicenseRecord = {
  key: 'ETTA-K',
  organization_id: 'org',
  status: 'granted',
  expires_at: null,
  activation_id: 'act_1',
  device_hash: 'dh',
  display_key: '****-Z',
  last_validated_at: '2026-01-01T00:00:00.000Z',
};

describe('license store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a record (null before write)', () => {
    expect(readLicense({ dir })).toBeNull();
    writeLicense(rec, { dir });
    expect(readLicense({ dir })).toEqual(rec);
  });

  it('clearLicense removes the file and is idempotent', () => {
    writeLicense(rec, { dir });
    expect(existsSync(licensePath({ dir }))).toBe(true);
    clearLicense({ dir });
    clearLicense({ dir });
    expect(existsSync(licensePath({ dir }))).toBe(false);
  });

  it('returns null (no throw) on malformed JSON', () => {
    writeFileSync(licensePath({ dir }), '{ not valid json');
    expect(readLicense({ dir })).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    writeFileSync(licensePath({ dir }), JSON.stringify({ key: 'K' }));
    expect(readLicense({ dir })).toBeNull();
  });

  it('round-trips high_water_mark when present', () => {
    const withHwm: LicenseRecord = { ...rec, high_water_mark: '2026-01-02T00:00:00.000Z' };
    writeLicense(withHwm, { dir });
    expect(readLicense({ dir })).toEqual(withHwm);
  });

  it('accepts a legacy record (no high_water_mark key at all) as valid', () => {
    // Simulates a license.json written before this field existed.
    writeFileSync(licensePath({ dir }), JSON.stringify(rec));
    const read = readLicense({ dir });
    expect(read).toEqual(rec);
    expect(read?.high_water_mark).toBeUndefined();
  });
});

describe('nextHighWaterMark (DL-1)', () => {
  const NOW = Date.parse('2026-07-07T00:00:00.000Z');
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('no existing record → the candidate timestamp becomes the high-water-mark', () => {
    expect(nextHighWaterMark(null, NOW)).toBe(new Date(NOW).toISOString());
  });

  it('existing high_water_mark behind the candidate → advances forward', () => {
    const existing: LicenseRecord = {
      ...rec,
      high_water_mark: new Date(NOW - DAY_MS).toISOString(),
    };
    expect(nextHighWaterMark(existing, NOW)).toBe(new Date(NOW).toISOString());
  });

  it('existing high_water_mark AHEAD of the candidate (clock rolled back) → stays pinned, never regresses', () => {
    const existing: LicenseRecord = { ...rec, high_water_mark: new Date(NOW).toISOString() };
    const rolledBack = NOW - 2 * DAY_MS;
    expect(nextHighWaterMark(existing, rolledBack)).toBe(new Date(NOW).toISOString());
  });

  it('legacy existing record (no high_water_mark field) does NOT fall back to its last_validated_at', () => {
    // last_validated_at is far in the FUTURE relative to the candidate — if this
    // were used as a floor, a legitimately-corrected clock would get pinned to a
    // bogus future value forever. It must be ignored; only the candidate counts.
    const legacy: LicenseRecord = {
      ...rec,
      last_validated_at: new Date(NOW + 30 * DAY_MS).toISOString(),
    };
    expect(nextHighWaterMark(legacy, NOW)).toBe(new Date(NOW).toISOString());
  });
});
