/**
 * Editmamei settings — the single hand-editable source of truth at
 * `~/.editmamei/settings.json` (LOCKED 2026-06-14).
 * Every control surface (direct edit, the `editmamei config` CLI, the Claude Desktop
 * extension config) reads and writes this one file.
 *
 * Sync API on purpose: the file is tiny and is read once at server boot (a sync
 * constructor path) and by short-lived CLI subcommands. Atomic write via tmp+rename
 * mirrors the pattern in `src/cli/clients/json-config.ts`.
 *
 * Privacy note: `install_id` is an ANONYMOUS salted random id minted on first run — it
 * is NOT derived from any machine or user identifier (telemetry-and-settings.md §4.3/§5).
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Logger } from '../utils/logger.js';

const logger = new Logger('Settings');

export interface TelemetrySettings {
  /** Category A (usage + reliability) — opt-out: defaults true, content-free. */
  usage: boolean;
  /** Category B (diagnostic detail) — opt-in: defaults false. */
  diagnostics: boolean;
  /** Anonymous salted random id, minted once on first run. Never derived from PII. */
  install_id: string;
}

export interface PrivacySettings {
  /** Phase 2+ per-feature preview toggle (Local Vision roadmap). Defaults true. */
  send_previews_to_llm: boolean;
}

export interface Settings {
  telemetry: TelemetrySettings;
  privacy: PrivacySettings;
  /** Absolute path to the Photoshop binary; null = auto-detect (PHOTOSHOP_PATH still wins). */
  ps_path: string | null;
  /**
   * Boot-time "is a newer Editmamei published?" check (opt-out: defaults true). When on, the
   * server makes one anonymous, content-free GET to the public npm registry at startup and
   * surfaces any newer version on `ps_ping`. No usage data or PII is sent. See
   * `src/update/check.ts`.
   */
  update_check: boolean;
}

export interface LoadSettingsOptions {
  /** Override the default `~/.editmamei` directory (used in tests). */
  dir?: string;
}

export interface LoadSettingsResult {
  settings: Settings;
  /** True when the file did not exist and was just created (drives first-run disclosure). */
  created: boolean;
}

const SETTINGS_DIRNAME = '.editmamei';
const SETTINGS_FILENAME = 'settings.json';

export function settingsDir(opts: LoadSettingsOptions = {}): string {
  return opts.dir ?? join(homedir(), SETTINGS_DIRNAME);
}

export function settingsPath(opts: LoadSettingsOptions = {}): string {
  return join(settingsDir(opts), SETTINGS_FILENAME);
}

/** Mint an anonymous install id: 32 hex chars. Matches the server's id pattern. */
export function mintInstallId(): string {
  return randomBytes(16).toString('hex');
}

function defaults(installId: string): Settings {
  return {
    telemetry: { usage: true, diagnostics: false, install_id: installId },
    privacy: { send_previews_to_llm: true },
    ps_path: null,
    update_check: true,
  };
}

/**
 * Merge a parsed-from-disk object onto the defaults so a settings file written by an
 * older version (missing newer keys) still loads with sane values, while user-set values
 * and the persisted install_id survive. Unknown top-level keys are dropped on the next
 * save (we own this schema).
 */
function coerce(raw: unknown, installId: string): Settings {
  const base = defaults(installId);
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const t = (r.telemetry ?? {}) as Record<string, unknown>;
  const p = (r.privacy ?? {}) as Record<string, unknown>;
  return {
    telemetry: {
      usage: typeof t.usage === 'boolean' ? t.usage : base.telemetry.usage,
      diagnostics: typeof t.diagnostics === 'boolean' ? t.diagnostics : base.telemetry.diagnostics,
      // Preserve an existing id; mint only when absent/blank.
      install_id:
        typeof t.install_id === 'string' && t.install_id.length > 0
          ? t.install_id
          : base.telemetry.install_id,
    },
    privacy: {
      send_previews_to_llm:
        typeof p.send_previews_to_llm === 'boolean'
          ? p.send_previews_to_llm
          : base.privacy.send_previews_to_llm,
    },
    ps_path: typeof r.ps_path === 'string' ? r.ps_path : null,
    update_check: typeof r.update_check === 'boolean' ? r.update_check : base.update_check,
  };
}

/**
 * Load settings, creating the file with defaults (and a freshly-minted install_id) on
 * first run. Never throws into the caller: a malformed or unreadable file degrades to
 * in-memory defaults (logged) rather than blocking server boot — telemetry/settings must
 * never break a tool call.
 */
export function loadSettings(opts: LoadSettingsOptions = {}): LoadSettingsResult {
  const path = settingsPath(opts);
  if (!existsSync(path)) {
    const settings = defaults(mintInstallId());
    try {
      saveSettings(settings, opts);
      return { settings, created: true };
    } catch (err) {
      logger.warn(`could not write initial settings.json: ${errMsg(err)}`);
      return { settings, created: false };
    }
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = raw.trim().length === 0 ? {} : (JSON.parse(raw) as unknown);
    // If a file exists but has no id (hand-created / older), mint one and persist it so
    // the id stays stable across boots.
    const existingId = (parsed as { telemetry?: { install_id?: unknown } })?.telemetry?.install_id;
    const id =
      typeof existingId === 'string' && existingId.length > 0 ? existingId : mintInstallId();
    const settings = coerce(parsed, id);
    if (id !== existingId) {
      try {
        saveSettings(settings, opts);
      } catch {
        /* best-effort persist of the minted id; in-memory value is still usable */
      }
    }
    return { settings, created: false };
  } catch (err) {
    logger.warn(`settings.json unreadable, using defaults: ${errMsg(err)}`);
    return { settings: defaults(mintInstallId()), created: false };
  }
}

/** Parse a boolean-ish env string. Returns undefined for absent / blank / unrecognized
 * (including an unsubstituted `${...}` token), so a weird value safely means "no override"
 * and the settings-file value stands rather than silently flipping telemetry. */
function parseBoolEnv(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return undefined;
}

/**
 * Apply Claude-Desktop-injected telemetry overrides at boot. Claude Desktop has no terminal,
 * so the `.mcpb` manifest exposes the consent toggles as `user_config` booleans and passes
 * them as `EDITMAMEI_TELEMETRY_USAGE` / `EDITMAMEI_TELEMETRY_DIAGNOSTICS`. When a recognized
 * value is present it wins for THIS process (the extension settings are the Desktop control
 * surface); absent — the npm / CLI path — the settings.json value stands. **Non-mutating and
 * in-memory only**: never written back to disk, so the file remains the source of truth the
 * `editmamei config` CLI reads, and no manifest↔file feedback loop can form.
 */
export function applyTelemetryEnvOverrides(
  settings: Settings,
  env: Record<string, string | undefined> = process.env
): Settings {
  const usage = parseBoolEnv(env.EDITMAMEI_TELEMETRY_USAGE);
  const diagnostics = parseBoolEnv(env.EDITMAMEI_TELEMETRY_DIAGNOSTICS);
  if (usage === undefined && diagnostics === undefined) return settings;
  return {
    ...settings,
    telemetry: {
      ...settings.telemetry,
      usage: usage ?? settings.telemetry.usage,
      diagnostics: diagnostics ?? settings.telemetry.diagnostics,
    },
  };
}

/**
 * Apply a Claude-Desktop-injected `update_check` override at boot. Same rationale as
 * `applyTelemetryEnvOverrides`: Desktop has no terminal for `editmamei config`, so the
 * `.mcpb` manifest exposes the boot-update-check toggle as a `user_config` boolean passed
 * as `EDITMAMEI_UPDATE_CHECK`. In-memory only — never written back, so settings.json stays
 * the source of truth on the npm/CLI path and no manifest↔file feedback loop can form.
 */
export function applyUpdateCheckEnvOverride(
  settings: Settings,
  env: Record<string, string | undefined> = process.env
): Settings {
  const v = parseBoolEnv(env.EDITMAMEI_UPDATE_CHECK);
  if (v === undefined) return settings;
  return { ...settings, update_check: v };
}

/** Atomic write (tmp + rename). Throws on failure — callers decide whether to swallow. */
export function saveSettings(settings: Settings, opts: LoadSettingsOptions = {}): void {
  const path = settingsPath(opts);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.settings.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
