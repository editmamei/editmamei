/**
 * `editmamei config` — get / set / list the settings at `~/.editmamei/settings.json`.
 * One of the Phase-1 control surfaces over the single settings source of truth
 * (telemetry-and-settings.md §7). Scriptable counterpart to hand-editing the file.
 *
 *   editmamei config list
 *   editmamei config get telemetry.usage
 *   editmamei config set telemetry.usage false
 */

import {
  loadSettings,
  saveSettings,
  type Settings,
  type LoadSettingsOptions,
} from '../core/settings.js';

export interface ConfigIo {
  out?: (s: string) => void;
  err?: (s: string) => void;
}

type Coerce = (raw: string) => boolean | string | null;

interface KeySpec {
  get: (s: Settings) => unknown;
  /** Absent = read-only (e.g. the anonymous install id). */
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
    // Read-only: the anonymous id is minted once and must stay stable.
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
      throw new Error('config set: bad value');
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
