/**
 * License cache at `~/.editmamei/license.json` — the locally-stored result of
 * the last successful Polar activation/validation. Read at server boot to gate
 * Pro tools (instant, offline-capable within the grace window) and by the
 * `activate` / `deactivate` / `license` CLI commands.
 *
 * Reuses `settingsDir()` so the license file sits beside `settings.json` and
 * honours the same test directory override. Atomic tmp+rename write, mirroring
 * src/core/settings.ts.
 */

import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { settingsDir } from '../core/settings.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('License');
const LICENSE_FILENAME = 'license.json';

export type LicenseStatus = 'granted' | 'revoked' | 'disabled';

export interface LicenseRecord {
  key: string;
  organization_id: string;
  status: LicenseStatus;
  /** ISO timestamp; null = perpetual (never expires). */
  expires_at: string | null;
  /** Polar activation id for this device — needed to deactivate (free the seat). */
  activation_id: string;
  /** Opaque salted device hash used as the Polar activation label. */
  device_hash: string;
  /** Masked key for display (e.g. "****-B221A0"), from Polar's `display_key`. */
  display_key: string;
  /** ISO timestamp of the last successful online validate — drives the grace window. */
  last_validated_at: string;
  /**
   * Backward-clock guard: the maximum wall-clock time ever observed
   * while writing this record (ISO timestamp), never allowed to move
   * backward — see `nextHighWaterMark`. Optional so license.json files
   * written before this field existed still parse; `evaluateEntitlement`
   * simply has no rollback floor to check for such a record (the guard is
   * inert) until its next successful activate/refresh seeds one.
   */
  high_water_mark?: string;
}

export interface LicenseStoreOptions {
  /** Override the default `~/.editmamei` directory (tests). */
  dir?: string;
}

export function licensePath(opts: LicenseStoreOptions = {}): string {
  return join(settingsDir(opts), LICENSE_FILENAME);
}

function isLicenseRecord(v: unknown): v is LicenseRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.key === 'string' &&
    typeof r.organization_id === 'string' &&
    (r.status === 'granted' || r.status === 'revoked' || r.status === 'disabled') &&
    (r.expires_at === null || typeof r.expires_at === 'string') &&
    typeof r.activation_id === 'string' &&
    typeof r.device_hash === 'string' &&
    typeof r.display_key === 'string' &&
    typeof r.last_validated_at === 'string' &&
    (r.high_water_mark === undefined || typeof r.high_water_mark === 'string')
  );
}

/** Read the cached license, or null when absent / malformed (never throws). */
export function readLicense(opts: LicenseStoreOptions = {}): LicenseRecord | null {
  const path = licensePath(opts);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isLicenseRecord(parsed)) {
      logger.warn('license.json malformed — ignoring');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn(`license.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Atomic write. Throws on failure — callers decide whether to swallow. */
export function writeLicense(rec: LicenseRecord, opts: LicenseStoreOptions = {}): void {
  const path = licensePath(opts);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.license.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Compute the next `high_water_mark`: the max of the device's prior
 * `high_water_mark` (if any) and every candidate timestamp passed in
 * (callers pass the injected clock's `now`, which is also what the freshly
 * written `last_validated_at` equals at that same write — so passing `now`
 * alone covers the spec's "max(existing, now, last_validated_at)"). Never
 * returns a value earlier than what was already stored, regardless of what
 * the current clock reports — that's the entire point: a rolled-back clock
 * can't erase this record's memory of a later time it already saw.
 *
 * Deliberately does NOT fall back to `existing.last_validated_at` when
 * `high_water_mark` is absent (a legacy record, written before this field
 * existed): `last_validated_at` alone can't be trusted as a floor — it's
 * exactly the value that reads as "future" under accidental forward clock
 * skew, and seeding the new high-water-mark from a stale future
 * value would permanently lock out a legitimately-corrected clock with no
 * way to recover. A legacy record simply starts its high-water-mark fresh
 * at the next successful write, from real observed time only.
 */
export function nextHighWaterMark(
  existing: LicenseRecord | null,
  ...candidatesMs: number[]
): string {
  const priorMs = existing?.high_water_mark ? Date.parse(existing.high_water_mark) : NaN;
  const finite = [priorMs, ...candidatesMs].filter((ms) => Number.isFinite(ms));
  const hwm = finite.length ? Math.max(...finite) : Date.now();
  return new Date(hwm).toISOString();
}

/** Remove the cached license (deactivate / sign-out). No-op when absent. */
export function clearLicense(opts: LicenseStoreOptions = {}): void {
  const path = licensePath(opts);
  if (existsSync(path)) rmSync(path, { force: true });
}
