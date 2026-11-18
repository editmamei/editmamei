/**
 * ChatGPT and Codex MCP adapter.
 *
 * The ChatGPT desktop app, the Codex CLI and the Codex IDE extension read
 * their MCP servers from one file: `config.toml` in the Codex home folder
 * (`$CODEX_HOME`, else `~/.codex`). One entry there reaches all three.
 *
 * Detection: write if the Codex home folder exists or a `codex` binary is on
 * PATH. The desktop app creates the folder the first time it runs.
 *
 * The edit is line-level (`toml-config.ts`): only Editmamei's own table
 * changes, and the rest of the file is written back as it was.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Logger } from '../../utils/logger.js';
import { getCodexConfigPath } from '../paths.js';
import { isOnPath } from './shell.js';
import { backupConfigIfFirstRun } from './json-config.js';
import {
  describeEntry,
  hasUnsupportedForm,
  UNSUPPORTED_DETAIL,
  readTomlDoc,
  removeEntry,
  renderDoc,
  upsertEntry,
  writeTomlDoc,
  type TomlDoc,
} from './toml-config.js';
import type {
  InstallClientOptions,
  InstallResult,
  McpServerEntry,
  StatusResult,
  UninstallResult,
} from './types.js';

export const CLIENT_NAME = 'ChatGPT and Codex';

const logger = new Logger('CodexAdapter');

function resolveConfigPath(opts: InstallClientOptions): string {
  return opts.configPath ?? getCodexConfigPath();
}

async function detect(configPath: string): Promise<boolean> {
  if (existsSync(dirname(configPath))) return true;
  return isOnPath('codex');
}

const NOT_DETECTED =
  'ChatGPT desktop app and Codex not detected. Open the ChatGPT desktop app once, then run editmamei install again.';

async function read(
  configPath: string
): Promise<{ ok: true; doc: TomlDoc } | { ok: false; error: string }> {
  try {
    return { ok: true, doc: await readTomlDoc(configPath) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function installCodex(
  entry: McpServerEntry,
  opts: InstallClientOptions = {}
): Promise<InstallResult> {
  const configPath = resolveConfigPath(opts);
  if (!(await detect(configPath))) {
    return { client: CLIENT_NAME, status: 'skipped', configPath, detail: NOT_DETECTED };
  }

  const r = await read(configPath);
  if (!r.ok) {
    return {
      client: CLIENT_NAME,
      status: 'failed',
      configPath,
      error: r.error,
      detail: 'Could not read config.toml.',
    };
  }

  const edit = upsertEntry(r.doc, entry);
  if (edit.kind === 'unsupported') {
    return { client: CLIENT_NAME, status: 'failed', configPath, detail: edit.detail };
  }

  const before = renderDoc(r.doc);
  const after = renderDoc(edit.doc);
  if (r.doc.hadExisting && before === after) {
    return { client: CLIENT_NAME, status: 'unchanged', configPath };
  }

  try {
    await mkdir(dirname(configPath), { recursive: true });
    let backup: { path: string; preserved: boolean } | undefined;
    if (r.doc.hadExisting) {
      const wroteFresh = await backupConfigIfFirstRun(configPath);
      backup = { path: `${configPath}.bak`, preserved: !wroteFresh };
    }
    await writeTomlDoc(configPath, after);
    const registeredBefore = describeEntry(r.doc) !== null;
    logger.info(`Editmamei registered in Codex config: ${configPath}`);
    return {
      client: CLIENT_NAME,
      status: registeredBefore ? 'updated' : 'created',
      configPath,
      ...(backup ? { backup } : {}),
    };
  } catch (err) {
    return {
      client: CLIENT_NAME,
      status: 'failed',
      configPath,
      error: err instanceof Error ? err.message : String(err),
      detail: 'Could not write config.toml.',
    };
  }
}

export async function uninstallCodex(opts: InstallClientOptions = {}): Promise<UninstallResult> {
  const configPath = resolveConfigPath(opts);
  if (!(await detect(configPath))) {
    return { client: CLIENT_NAME, status: 'skipped', configPath };
  }

  const r = await read(configPath);
  if (!r.ok) {
    return {
      client: CLIENT_NAME,
      status: 'failed',
      configPath,
      error: r.error,
      detail: 'Could not read config.toml.',
    };
  }
  if (!r.doc.hadExisting) return { client: CLIENT_NAME, status: 'absent', configPath };
  if (hasUnsupportedForm(r.doc.lines)) {
    return { client: CLIENT_NAME, status: 'failed', configPath, detail: UNSUPPORTED_DETAIL };
  }

  const { doc, removed } = removeEntry(r.doc);
  if (!removed) return { client: CLIENT_NAME, status: 'absent', configPath };

  try {
    const wroteFresh = await backupConfigIfFirstRun(configPath);
    await writeTomlDoc(configPath, renderDoc(doc));
    logger.info(`Editmamei unregistered from Codex config: ${configPath}`);
    return {
      client: CLIENT_NAME,
      status: 'removed',
      configPath,
      backup: { path: `${configPath}.bak`, preserved: !wroteFresh },
    };
  } catch (err) {
    return {
      client: CLIENT_NAME,
      status: 'failed',
      configPath,
      error: err instanceof Error ? err.message : String(err),
      detail: 'Could not write config.toml.',
    };
  }
}

export async function statusCodex(opts: InstallClientOptions = {}): Promise<StatusResult> {
  const configPath = resolveConfigPath(opts);
  if (!(await detect(configPath))) {
    return { client: CLIENT_NAME, status: 'not-detected', configPath };
  }
  const r = await read(configPath);
  if (!r.ok) {
    return {
      client: CLIENT_NAME,
      status: 'error',
      configPath,
      error: r.error,
      detail: 'Could not read config.toml.',
    };
  }
  if (hasUnsupportedForm(r.doc.lines)) {
    return { client: CLIENT_NAME, status: 'error', configPath, detail: UNSUPPORTED_DETAIL };
  }
  const command = describeEntry(r.doc);
  if (command === null) return { client: CLIENT_NAME, status: 'not-registered', configPath };
  return { client: CLIENT_NAME, status: 'registered', configPath, command };
}
