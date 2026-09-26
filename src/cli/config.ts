/**
 * `editmamei config` — get / set / list the settings at `~/.editmamei/settings.json`.
 * One of the Phase-1 control surfaces over the single settings source of truth
 * (see docs/privacy.md, "How to control it"). Scriptable counterpart to hand-editing the file.
 *
 *   editmamei config list
 *   editmamei config get telemetry.usage
 *   editmamei config set telemetry.usage false
 *   editmamei config set editor gimp
 *   editmamei config set gimp_path "C:/Program Files/GIMP 3/bin/gimp-console-3.2.exe"
 */

import {
  loadSettings,
  saveSettings,
  type Settings,
  type LoadSettingsOptions,
} from '../core/settings.js';
import { requireAbsoluteGimpPath } from '../utils/tool-helpers.js';

export interface ConfigIo {
  out?: (s: string) => void;
  err?: (s: string) => void;
}

type Coerce = (raw: string) => boolean | string | null;

interface KeySpec {
  get: (s: Settings) => unknown;
  /** Absent = read-only (e.g. the install id: salted and random, never derived from PII, but stable — pseudonymous, not anonymous). */
  set?: (s: Settings, value: boolean | string | null) => void;
  coerce?: Coerce;
}

function coerceBool(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(v)) return true;
  if (['false', '0', 'off', 'no'].includes(v)) return false;
  throw new Error(`expected a boolean (true/false), got "${raw}"`);
}

function coercePath(raw: string): string | null {
  const v = raw.trim();
  return v === '' || v.toLowerCase() === 'null' ? null : v;
}

/**
 * Same shape as `coercePath` (empty / "null" unsets), but a non-empty value
 * must actually be usable by `GimpBackend` — the same absolute-local-path
 * rules `requireAbsoluteGimpPath` enforces on every gimp_* tool's file
 * arguments (no UNC/device paths, a drive letter on Windows, a stable
 * resolved root). Rejecting a bad value HERE, at `config set` time, is a
 * much better failure than discovering it later as every gimp_* call's
 * `gimp_not_installed`/`gimp_start_failed` error.
 */
function coerceGimpPath(raw: string): string | null {
  const v = raw.trim();
  if (v === '' || v.toLowerCase() === 'null') return null;
  requireAbsoluteGimpPath('gimp_path', v);
  return v;
}

function coerceEditorPin(raw: string): 'auto' | 'photoshop' | 'gimp' {
  const v = raw.trim().toLowerCase();
  if (v === 'auto' || v === 'photoshop' || v === 'gimp') return v;
  throw new Error(`expected one of auto|photoshop|gimp, got "${raw}"`);
}

/** The settable / readable surface. Dotted keys map to the nested settings shape. */
const KEYS: Record<string, KeySpec> = {
  'telemetry.usage': {
    get: (s) => s.telemetry.usage,
    set: (s, v) => {
      s.telemetry.usage = v as boolean;
    },
    coerce: coerceBool,
  },
  'telemetry.diagnostics': {
    get: (s) => s.telemetry.diagnostics,
    set: (s, v) => {
      s.telemetry.diagnostics = v as boolean;
    },
    coerce: coerceBool,
  },
  'telemetry.install_id': {
    // Read-only: the id is minted once and must stay stable — pseudonymous, not anonymous.
    get: (s) => s.telemetry.install_id,
  },
  'privacy.send_previews_to_llm': {
    get: (s) => s.privacy.send_previews_to_llm,
    set: (s, v) => {
      s.privacy.send_previews_to_llm = v as boolean;
    },
    coerce: coerceBool,
  },
  ps_path: {
    get: (s) => s.ps_path,
    set: (s, v) => {
      s.ps_path = v as string | null;
    },
    coerce: coercePath,
  },
  update_check: {
    get: (s) => s.update_check,
    set: (s, v) => {
      s.update_check = v as boolean;
    },
    coerce: coerceBool,
  },
  editor: {
    get: (s) => s.editor,
    set: (s, v) => {
      s.editor = v as Settings['editor'];
    },
    coerce: coerceEditorPin,
  },
  gimp_path: {
    get: (s) => s.gimp_path,
    set: (s, v) => {
      s.gimp_path = v as string | null;
    },
    coerce: coerceGimpPath,
  },
};

function knownKeysHint(): string {
  return `Known keys:\n${Object.keys(KEYS)
    .map((k) => `  ${k}${KEYS[k].set ? '' : '  (read-only)'}`)
    .join('\n')}\n`;
}

/**
 * Run the `config` subcommand. Prints results to stdout and errors to stderr, and throws
 * on bad usage so the router maps it to exit 1 (matching the other subcommands).
 */
export function runConfig(args: string[], io: ConfigIo & LoadSettingsOptions = {}): void {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  const action = args[0];

  if (action === 'list' || action === undefined) {
    const { settings } = loadSettings(io);
    out(JSON.stringify(settings, null, 2) + '\n');
    return;
  }

  if (action === 'get') {
    const key = args[1];
    const spec = key ? KEYS[key] : undefined;
    if (!spec) {
      err(`Unknown or missing config key: ${key ?? '(none)'}\n\n${knownKeysHint()}`);
      throw new Error('config get: bad key');
    }
    const { settings } = loadSettings(io);
    out(`${String(spec.get(settings) ?? 'null')}\n`);
    return;
  }

  if (action === 'set') {
    const key = args[1];
    const value = args[2];
    const spec = key ? KEYS[key] : undefined;
    if (!spec) {
      err(`Unknown or missing config key: ${key ?? '(none)'}\n\n${knownKeysHint()}`);
      throw new Error('config set: bad key');
    }
    if (!spec.set || !spec.coerce) {
      err(`Config key is read-only: ${key}\n`);
      throw new Error('config set: read-only key');
    }
    if (value === undefined) {
      err(`config set ${key} requires a value.\n`);
      throw new Error('config set: missing value');
    }
    let coerced: boolean | string | null;
    try {
      coerced = spec.coerce(value);
    } catch (e) {
      err(`Invalid value for ${key}: ${e instanceof Error ? e.message : String(e)}\n`);
      throw new Error('config set: bad value', { cause: e });
    }
    const { settings } = loadSettings(io);
    spec.set(settings, coerced);
    saveSettings(settings, io);
    out(`${key} = ${String(coerced ?? 'null')}\n`);
    return;
  }

  err(`Unknown config action: ${action}\n\nUsage: editmamei config <list|get|set> [key] [value]\n`);
  throw new Error('config: unknown action');
}
