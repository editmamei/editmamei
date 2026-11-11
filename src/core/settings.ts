/**
 * Editmamei settings — the single hand-editable source of truth at
 * `~/.editmamei/settings.json` (LOCKED 2026-06-14).
 * Every control surface (direct edit, the `editmamei config` CLI) reads and writes this one
 * file; a change made in the Claude Desktop extension settings is written to it at the next
 * launch (see `applyDesktopToggles`).
 *
 * Sync API on purpose: the file is tiny and is read once at server boot (a sync
 * constructor path) and by short-lived CLI subcommands. Atomic write via tmp+rename
 * mirrors the pattern in `src/cli/clients/json-config.ts`.
 *
 * Privacy note: `install_id` is a salted random id minted on first run — it is NOT derived
 * from any machine or user identifier, but it is stable, which makes it pseudonymous rather
 * than anonymous (see docs/privacy.md).
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Logger } from '../utils/logger.js';
import { requireAbsoluteGimpPath } from '../utils/gimp-path.js';
import { FEATURES_QUESTION, type ConsentQuestionId } from './consent-questions.js';

const logger = new Logger('Settings');

export interface TelemetrySettings {
  /** Category A (usage + reliability) — opt-out: defaults true, content-free. */
  usage: boolean;
  /** Category B (diagnostic detail) — opt-in: defaults false. */
  diagnostics: boolean;
  /**
   * Feature details — the names of features used, from fixed lists. Absent means not asked yet,
   * and reads as off: only a new install or an answer turns it on, so upgrading never does. Sent
   * only while `usage` is on too. Read it through `featureDetailsEnabled`.
   */
  features?: boolean;
  /** Salted random id, minted once on first run. Never derived from PII, but stable — pseudonymous, not anonymous. */
  install_id: string;
}

export interface PrivacySettings {
  /** Phase 2+ per-feature preview toggle (Local Vision roadmap). Defaults true. */
  send_previews_to_llm: boolean;
}

export interface AutomationSettings {
  /** When false, tools that run arbitrary script code refuse. Only the user can change it (CLI or settings.json), never a tool. Defaults true. */
  allow_execute_script: boolean;
  /**
   * When false, tools that run Photoshop features costing Adobe generative (Firefly) credits
   * aren't offered at all. When true, each use still asks the person first. Only the user can
   * change it (CLI, settings.json or the Claude Desktop extension settings). Defaults true.
   */
  allow_adobe_generative_credits: boolean;
}

/** The Claude Desktop toggle values seen at the last launch, so a moved toggle can be told from an unchanged one. Written only by `applyDesktopToggles`. */
export interface DesktopTogglesSeen {
  usage?: boolean;
  diagnostics?: boolean;
  update_check?: boolean;
  features?: boolean;
  adobe_generative_credits?: boolean;
}

/** How a consent answer was given, and when. Raising a question's version asks again. */
export interface ConsentRecord {
  version: number;
  answer: 'accepted' | 'declined' | 'install_default';
  via: 'elicitation' | 'install' | 'cli' | 'desktop';
  /** `YYYY-MM-DD`. */
  date: string;
  /** The telemetry server has been told about this answer. */
  reported?: boolean;
}

/** Which editor(s) `detectEditors()` + boot registration should honor. `'auto'` (default) is the detection-driven matrix. */
export type EditorPin = 'auto' | 'photoshop' | 'gimp';

export interface Settings {
  telemetry: TelemetrySettings;
  privacy: PrivacySettings;
  automation: AutomationSettings;
  /** Absolute path to the Photoshop binary; null = auto-detect (PHOTOSHOP_PATH still wins). */
  ps_path: string | null;
  /**
   * Boot-time "is a newer Editmamei published?" check (opt-out: defaults true). When on, the
   * server makes one anonymous, content-free GET to the public npm registry at startup and
   * surfaces any newer version on `ps_ping`. No usage data or PII is sent. See
   * `src/update/check.ts`.
   */
  update_check: boolean;
  /**
   * Pin which editor(s) register at boot instead of trusting `detectEditors()`'s matrix.
   * `EDITMAMEI_EDITOR` wins over this for the current process; the file value stands on the
   * npm/CLI path.
   */
  editor: EditorPin;
  /** Absolute path to the `gimp-console` binary; null = auto-detect. `EDITMAMEI_GIMP_PATH` wins over this for the current process — the same override `detectGimp()` reads directly. */
  gimp_path: string | null;
  /** Absent until the first launch from Claude Desktop. */
  desktop_toggles?: DesktopTogglesSeen;
  /** Absent until a question has an answer. */
  consent?: Partial<Record<ConsentQuestionId, ConsentRecord>>;
  /** How many times the current version of a question was closed without an answer. */
  consent_dismissals?: Partial<Record<ConsentQuestionId, { version: number; count: number }>>;
}

export interface LoadSettingsOptions {
  /** Override the default `~/.editmamei` directory (used in tests). */
  dir?: string;
}

export interface LoadSettingsResult {
  settings: Settings;
  /** True when the file did not exist and was just created (drives first-run disclosure). */
  created: boolean;
  /** True when a file exists but couldn't be read, so `settings` is defaults. Never save these over it. */
  degraded?: boolean;
}

const SETTINGS_DIRNAME = '.editmamei';
const SETTINGS_FILENAME = 'settings.json';

export function settingsDir(opts: LoadSettingsOptions = {}): string {
  return opts.dir ?? join(homedir(), SETTINGS_DIRNAME);
}

export function settingsPath(opts: LoadSettingsOptions = {}): string {
  return join(settingsDir(opts), SETTINGS_FILENAME);
}

/** Mint an install id: 32 hex chars, salted and random but stable — pseudonymous, not anonymous. Matches the server's id pattern. */
export function mintInstallId(): string {
  return randomBytes(16).toString('hex');
}

const EDITOR_PINS: readonly EditorPin[] = ['auto', 'photoshop', 'gimp'];
const CONSENT_ANSWERS: readonly string[] = ['accepted', 'declined', 'install_default'];
const CONSENT_VIAS: readonly string[] = ['elicitation', 'install', 'cli', 'desktop'];

function todayBucket(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Whether Feature details may be sent. An answer given to an older version of the question
 * doesn't cover what the setting means now, so it reads as off until it is asked again.
 */
export function featureDetailsEnabled(settings: Settings): boolean {
  if (!settings.telemetry.usage || settings.telemetry.features !== true) return false;
  const record = settings.consent?.features;
  return record === undefined || record.version >= FEATURES_QUESTION.version;
}

/** Record a choice about Feature details. Mutates `settings`; the caller saves. */
export function setFeatureDetails(
  settings: Settings,
  enabled: boolean,
  via: ConsentRecord['via'],
  now: Date = new Date()
): void {
  settings.telemetry.features = enabled;
  settings.consent = {
    ...settings.consent,
    features: {
      version: FEATURES_QUESTION.version,
      answer: enabled ? 'accepted' : 'declined',
      via,
      date: todayBucket(now),
    },
  };
}

/**
 * A brand-new install's settings. The policy is available before installing, so nothing is asked
 * and Feature details starts on. Only this path sets that default: `defaults` also backs existing
 * and unreadable files, where a missing key must stay missing.
 */
function newInstallSettings(installId: string): Settings {
  const settings = defaults(installId);
  settings.telemetry.features = true;
  settings.consent = {
    features: {
      version: FEATURES_QUESTION.version,
      answer: 'install_default',
      via: 'install',
      date: todayBucket(),
    },
  };
  return settings;
}

function defaults(installId: string): Settings {
  return {
    telemetry: { usage: true, diagnostics: false, install_id: installId },
    privacy: { send_previews_to_llm: true },
    automation: { allow_execute_script: true, allow_adobe_generative_credits: true },
    ps_path: null,
    update_check: true,
    editor: 'auto',
    gimp_path: null,
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
  const a = (r.automation ?? {}) as Record<string, unknown>;
  const desktopToggles = coerceDesktopToggles(r.desktop_toggles);
  const consent = coerceConsent(r.consent);
  const dismissals = coerceDismissals(r.consent_dismissals);
  return {
    telemetry: {
      usage: typeof t.usage === 'boolean' ? t.usage : base.telemetry.usage,
      diagnostics: typeof t.diagnostics === 'boolean' ? t.diagnostics : base.telemetry.diagnostics,
      // No fallback on purpose: a file from an older version must not gain this setting.
      ...(typeof t.features === 'boolean' ? { features: t.features } : {}),
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
    automation: {
      allow_execute_script:
        typeof a.allow_execute_script === 'boolean'
          ? a.allow_execute_script
          : base.automation.allow_execute_script,
      allow_adobe_generative_credits:
        typeof a.allow_adobe_generative_credits === 'boolean'
          ? a.allow_adobe_generative_credits
          : base.automation.allow_adobe_generative_credits,
    },
    ps_path: typeof r.ps_path === 'string' ? r.ps_path : null,
    update_check: typeof r.update_check === 'boolean' ? r.update_check : base.update_check,
    editor:
      typeof r.editor === 'string' && (EDITOR_PINS as readonly string[]).includes(r.editor)
        ? (r.editor as EditorPin)
        : base.editor,
    gimp_path: coerceGimpPath(r.gimp_path),
    ...(desktopToggles ? { desktop_toggles: desktopToggles } : {}),
    ...(consent ? { consent } : {}),
    ...(dismissals ? { consent_dismissals: dismissals } : {}),
  };
}

function coerceDismissals(raw: unknown): Settings['consent_dismissals'] {
  const features = (raw as { features?: unknown } | null | undefined)?.features;
  if (typeof features !== 'object' || features === null) return undefined;
  const { version, count } = features as Record<string, unknown>;
  if (!Number.isInteger(version) || !Number.isInteger(count)) return undefined;
  return { features: { version: version as number, count: count as number } };
}

/** Keep only well-formed records. Anything else reads as not answered, so it is asked again. */
function coerceConsent(raw: unknown): Settings['consent'] {
  const features = (raw as { features?: unknown } | null | undefined)?.features;
  if (typeof features !== 'object' || features === null) return undefined;
  const { version, answer, via, date, reported } = features as Record<string, unknown>;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    typeof answer !== 'string' ||
    !CONSENT_ANSWERS.includes(answer) ||
    typeof via !== 'string' ||
    !CONSENT_VIAS.includes(via) ||
    typeof date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    return undefined;
  }
  return {
    features: {
      version,
      answer: answer as ConsentRecord['answer'],
      via: via as ConsentRecord['via'],
      date,
      ...(reported === true ? { reported: true } : {}),
    },
  };
}

/** Keep only well-formed booleans. Anything else reads as "not seen yet". */
function coerceDesktopToggles(raw: unknown): DesktopTogglesSeen | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: DesktopTogglesSeen = {};
  if (typeof r.usage === 'boolean') out.usage = r.usage;
  if (typeof r.diagnostics === 'boolean') out.diagnostics = r.diagnostics;
  if (typeof r.update_check === 'boolean') out.update_check = r.update_check;
  if (typeof r.features === 'boolean') out.features = r.features;
  if (typeof r.adobe_generative_credits === 'boolean')
    out.adobe_generative_credits = r.adobe_generative_credits;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A hand-edited `gimp_path` gets the same rule `editmamei config set gimp_path` enforces: a
 * relative path would resolve against the server's own working directory at spawn, so anything
 * that isn't a plain absolute path falls back to auto-detection (logged) instead.
 */
function coerceGimpPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return requireAbsoluteGimpPath('gimp_path', raw);
  } catch (err) {
    logger.warn(`ignoring settings.json gimp_path (falling back to auto-detect): ${errMsg(err)}`);
    return null;
  }
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
    const settings = newInstallSettings(mintInstallId());
    try {
      saveSettings(settings, opts);
      return { settings, created: true };
    } catch (err) {
      // An unreachable file also reads as missing here, so this may not be a new install at all.
      logger.warn(`could not write initial settings.json: ${errMsg(err)}`);
      return { settings: defaults(settings.telemetry.install_id), created: false, degraded: true };
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
    return { settings: defaults(mintInstallId()), created: false, degraded: true };
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
 * Decide one Claude Desktop toggle against its stored setting. `stored` is what later launches
 * read; `effective` applies to this process, where an off toggle always means off.
 *
 * A toggle's value can't be told apart from its manifest default, so only a CHANGE since the
 * last launch counts as the user moving it. The first launch that sees a toggle has no such
 * history: an on-by-default toggle can only turn the setting off, and an off-by-default one
 * only on, because in each case the other value may just be the default.
 */
function resolveDesktopToggle(
  stored: boolean,
  toggle: boolean | undefined,
  seen: boolean | undefined,
  onByDefault: boolean
): { stored: boolean; effective: boolean } {
  if (toggle === undefined) return { stored, effective: stored };
  let next = stored;
  if (seen === undefined) next = onByDefault ? stored && toggle : stored || toggle;
  else if (toggle !== seen) next = toggle;
  return { stored: next, effective: toggle && next };
}

/**
 * Apply the Claude Desktop extension's toggles at boot. Desktop has no terminal, so the `.mcpb`
 * manifest exposes them as `user_config` booleans passed as `EDITMAMEI_TELEMETRY_USAGE`,
 * `EDITMAMEI_TELEMETRY_DIAGNOSTICS`, `EDITMAMEI_TELEMETRY_FEATURES`, `EDITMAMEI_UPDATE_CHECK` and
 * `EDITMAMEI_ADOBE_GENERATIVE_CREDITS`,
 * a concrete value on every launch. A change made in Desktop is written to settings.json; an unchanged toggle leaves the
 * stored setting alone, so a choice made another way survives. Off still wins for this process.
 * With none of the variables set (the npm / CLI path), returns `settings` untouched. A failed
 * write is logged and this launch still honors the result. Pass `persist: false` when `settings`
 * didn't come from the file (see `LoadSettingsResult.degraded`).
 */
export function applyDesktopToggles(
  settings: Settings,
  env: Record<string, string | undefined> = process.env,
  opts: LoadSettingsOptions & { persist?: boolean } = {}
): Settings {
  const usageToggle = parseBoolEnv(env.EDITMAMEI_TELEMETRY_USAGE);
  const diagnosticsToggle = parseBoolEnv(env.EDITMAMEI_TELEMETRY_DIAGNOSTICS);
  const updateCheckToggle = parseBoolEnv(env.EDITMAMEI_UPDATE_CHECK);
  const featuresToggle = parseBoolEnv(env.EDITMAMEI_TELEMETRY_FEATURES);
  const adobeCreditsToggle = parseBoolEnv(env.EDITMAMEI_ADOBE_GENERATIVE_CREDITS);
  if (
    usageToggle === undefined &&
    diagnosticsToggle === undefined &&
    updateCheckToggle === undefined &&
    featuresToggle === undefined &&
    adobeCreditsToggle === undefined
  ) {
    return settings;
  }

  const seen = settings.desktop_toggles ?? {};
  const usage = resolveDesktopToggle(settings.telemetry.usage, usageToggle, seen.usage, true);
  const diagnostics = resolveDesktopToggle(
    settings.telemetry.diagnostics,
    diagnosticsToggle,
    seen.diagnostics,
    false
  );
  const updateCheck = resolveDesktopToggle(
    settings.update_check,
    updateCheckToggle,
    seen.update_check,
    true
  );
  const adobeCredits = resolveDesktopToggle(
    settings.automation.allow_adobe_generative_credits,
    adobeCreditsToggle,
    seen.adobe_generative_credits,
    true
  );

  const nextSeen: DesktopTogglesSeen = {
    ...seen,
    ...(usageToggle !== undefined ? { usage: usageToggle } : {}),
    ...(diagnosticsToggle !== undefined ? { diagnostics: diagnosticsToggle } : {}),
    ...(updateCheckToggle !== undefined ? { update_check: updateCheckToggle } : {}),
    ...(featuresToggle !== undefined ? { features: featuresToggle } : {}),
    ...(adobeCreditsToggle !== undefined ? { adobe_generative_credits: adobeCreditsToggle } : {}),
  };
  const stored: Settings = {
    ...settings,
    telemetry: { ...settings.telemetry, usage: usage.stored, diagnostics: diagnostics.stored },
    automation: { ...settings.automation, allow_adobe_generative_credits: adobeCredits.stored },
    update_check: updateCheck.stored,
    desktop_toggles: nextSeen,
  };
  // Unlike the others this setting can be unanswered, and a toggle sitting at its on default is
  // not an answer. Only an off at first sight or a move counts, and each is recorded as a choice.
  if (featuresToggle !== undefined) {
    const moved = seen.features !== undefined && featuresToggle !== seen.features;
    const offAtFirstSight =
      seen.features === undefined && !featuresToggle && settings.telemetry.features !== false;
    if (moved || offAtFirstSight) setFeatureDetails(stored, featuresToggle, 'desktop');
  }
  // A stored value only changes when its toggle's seen value does.
  const seenChanged =
    nextSeen.usage !== seen.usage ||
    nextSeen.diagnostics !== seen.diagnostics ||
    nextSeen.update_check !== seen.update_check ||
    nextSeen.features !== seen.features ||
    nextSeen.adobe_generative_credits !== seen.adobe_generative_credits;
  if (seenChanged && opts.persist !== false) {
    try {
      saveSettings(stored, { dir: opts.dir });
    } catch (err) {
      logger.warn(`could not save Claude Desktop toggle state: ${errMsg(err)}`);
    }
  }
  return {
    ...stored,
    telemetry: {
      ...stored.telemetry,
      usage: usage.effective,
      diagnostics: diagnostics.effective,
      // An off toggle wins for this launch, as with the others. Otherwise leave it as stored.
      ...(featuresToggle === false ? { features: false } : {}),
    },
    automation: { ...stored.automation, allow_adobe_generative_credits: adobeCredits.effective },
    update_check: updateCheck.effective,
  };
}

/**
 * Apply an `EDITMAMEI_EDITOR` env override of the `editor` pin at boot.
 * `EDITMAMEI_EDITOR` wins for THIS process when it names a recognized pin; an
 * unrecognized or absent value leaves the settings.json value standing. In-memory only — never written
 * back, so settings.json stays the source of truth on the npm/CLI path.
 */
export function applyEditorEnvOverride(
  settings: Settings,
  env: Record<string, string | undefined> = process.env
): Settings {
  const raw = env.EDITMAMEI_EDITOR?.trim().toLowerCase();
  if (!raw || !(EDITOR_PINS as readonly string[]).includes(raw)) return settings;
  return { ...settings, editor: raw as EditorPin };
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
