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
const CHECK_STATE_FILENAME = 'license-check.json';

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

/**
 * Remove the cached license (deactivate / sign-out). No-op when absent. Also drops
 * the check-state sidecar, which is derived scheduling state for THIS record and
 * would otherwise outlive it — a marker left behind could delay the first online
 * check after a re-activation.
 */
export function clearLicense(opts: LicenseStoreOptions = {}): void {
  const path = licensePath(opts);
  if (existsSync(path)) rmSync(path, { force: true });
  clearCheckState(opts);
}

/**
 * Scheduling markers that sit BESIDE the license record, never inside it: when the
 * next online check may be ATTEMPTED, and when the Pro module freshness poll last
 * ran.
 *
 * Deliberately its own file. Nothing here grants, shortens or removes
 * entitlement — `evaluateEntitlement` does not read it and must never learn to —
 * and keeping these frequent, low-value writes out of `license.json` means a
 * failed or half-finished one can never damage the record that DOES decide what
 * the user gets. Every read degrades to "no marker", so the worst outcome of a
 * missing, unreadable or malformed file is the behaviour that existed before this
 * file did: check now.
 */
export interface LicenseCheckState {
  /**
   * Epoch ms before which no online license check should be ATTEMPTED, written
   * after an attempt failed. Suppresses attempts only — never the verdict.
   */
  validate_retry_after?: number;
  /**
   * Epoch ms before which the Pro-module freshness poll should not run again.
   * Written before each poll and extended once one settles cleanly, so a poll
   * that never finished still leaves a bounded wait behind.
   */
  module_retry_after?: number;
}

export function checkStatePath(opts: LicenseStoreOptions = {}): string {
  return join(settingsDir(opts), CHECK_STATE_FILENAME);
}

/**
 * Read the check-state sidecar. Never throws, and drops any field that is not a
 * finite number — a hand-edited or truncated file degrades field by field to "no
 * marker" rather than failing the boot path that reads it.
 */
export function readCheckState(opts: LicenseStoreOptions = {}): LicenseCheckState {
  const path = checkStatePath(opts);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    logger.debug(
      `license-check.json unreadable (ignoring): ${err instanceof Error ? err.message : String(err)}`
    );
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const raw = parsed as Record<string, unknown>;
  const out: LicenseCheckState = {};
  if (typeof raw.validate_retry_after === 'number' && Number.isFinite(raw.validate_retry_after)) {
    out.validate_retry_after = raw.validate_retry_after;
  }
  if (typeof raw.module_retry_after === 'number' && Number.isFinite(raw.module_retry_after)) {
    out.module_retry_after = raw.module_retry_after;
  }
  return out;
}

/**
 * Merge `patch` into the check-state sidecar and write it atomically. A `null`
 * value REMOVES that marker (the "we got through, forget the backoff" case).
 *
 * Never throws: every caller is a fire-and-forget boot-path task where a
 * read-only home or a full disk must degrade to "no marker persisted" — which
 * simply means the next boot checks again — rather than failing a license refresh
 * or a module poll.
 */
export function updateCheckState(
  patch: { [K in keyof LicenseCheckState]?: number | null },
  opts: LicenseStoreOptions = {}
): void {
  const next: LicenseCheckState = { ...readCheckState(opts) };
  for (const [key, value] of Object.entries(patch) as [keyof LicenseCheckState, number | null][]) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const path = checkStatePath(opts);
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.license-check.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    logger.debug(
      `license-check.json not written (ignoring): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Remove the check-state sidecar. No-op when absent; never throws. */
export function clearCheckState(opts: LicenseStoreOptions = {}): void {
  const path = checkStatePath(opts);
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch (err) {
    logger.debug(
      `license-check.json not removed (ignoring): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
