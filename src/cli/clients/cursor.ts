/**
 * Cursor MCP adapter. Lives at `~/.cursor/mcp.json` on all platforms.
 *
 * Detection: write if `~/.cursor/` exists OR if a `cursor` binary is on
 * PATH. Without one of those, the user almost certainly doesn't have
 * Cursor installed; we skip rather than litter their filesystem with a
 * dangling config dir.
 *
 * Same JSON shape as Claude Desktop, so the heavy lifting lives in
 * `json-config.ts`.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../../utils/logger.js';
import { getCursorMcpConfigPath } from '../paths.js';
import { isOnPath } from './shell.js';
import type { McpServerEntry } from './types.js';
import type {
  InstallClientOptions,
  InstallResult,
  StatusResult,
  UninstallResult,
} from './types.js';
import {
  backupConfigIfFirstRun,
  classifyInstall,
  classifyUninstall,
  ensureConfigParentDir,
  mergeEnvFromExisting,
  readJsonMcpConfig,
  SERVER_NAME,
  writeJsonMcpConfig,
} from './json-config.js';

export const CLIENT_NAME = 'Cursor';

const logger = new Logger('CursorAdapter');

function resolveConfigPath(opts: InstallClientOptions): string {
  return opts.configPath ?? getCursorMcpConfigPath();
}

async function detect(configPath: string): Promise<boolean> {
  // ~/.cursor/ existence is the strongest signal — Cursor creates that
  // dir on first launch even before any MCP config gets written.
  if (existsSync(dirname(configPath))) return true;
  // Brand-new Cursor install where the dir doesn't yet exist: fall back
  // to PATH detection. This covers users who just installed Cursor but
  // haven't opened it yet.
  if (await isOnPath('cursor')) return true;
  return false;
}

export async function installCursor(
  entry: McpServerEntry,
  opts: InstallClientOptions = {}
): Promise<InstallResult> {
  const configPath = resolveConfigPath(opts);

  if (!(await detect(configPath))) {
    return {
      client: CLIENT_NAME,
      status: 'skipped',
      configPath,
      detail:
        'Cursor not detected. Install at https://cursor.com/ if you want this client wired up.',
    };
  }

  try {
    await ensureConfigParentDir(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      client: CLIENT_NAME,
      status: 'failed',
      configPath,
      error: msg,
      detail: 'Could not create the ~/.cursor/ directory.',
    };
  }

  let read;
  try {
    read = await readJsonMcpConfig(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      client: CLIENT_NAME,
      status: 'failed',
      configPath,
      error: msg,
      detail:
        'Existing ~/.cursor/mcp.json is not valid JSON. Fix the JSON manually or delete the file, ' +
        'then re-run editmamei install.',
    };
  }

  const { config, hadExisting } = read;
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  // Preserve any env vars the user hand-added; only keys WE explicitly
  // set in this install pass override.
  const finalEntry = mergeEnvFromExisting(config.mcpServers[SERVER_NAME], entry);

  const classification = classifyInstall(config, finalEntry);
  if (classification === 'unchanged') {
    return { client: CLIENT_NAME, status: 'unchanged', configPath };
  }

  let backup: { path: string; preserved: boolean } | undefined;
  if (hadExisting) {
    const wroteFresh = await backupConfigIfFirstRun(configPath);
    backup = { path: `${configPath}.bak`, preserved: !wroteFresh };
  }
  config.mcpServers[SERVER_NAME] = finalEntry;
  await writeJsonMcpConfig(configPath, config);

  logger.info(`Editmamei registered in Cursor config: ${configPath}`);
  return { client: CLIENT_NAME, status: classification, configPath, ...(backup ? { backup } : {}) };
}

export async function uninstallCursor(opts: InstallClientOptions = {}): Promise<UninstallResult> {
  const configPath = resolveConfigPath(opts);

  if (!(await detect(configPath))) {
    return { client: CLIENT_NAME, status: 'skipped', configPath };
  }

  let read;
  try {
    read = await readJsonMcpConfig(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      client: CLIENT_NAME,
      status: 'failed',
      configPath,
      error: msg,
      detail: 'Existing ~/.cursor/mcp.json is not valid JSON.',
    };
  }

  if (!read.hadExisting) {
    return { client: CLIENT_NAME, status: 'absent', configPath };
  }

  const { config } = read;
  const classification = classifyUninstall(config);
  if (classification === 'absent') {
    return { client: CLIENT_NAME, status: 'absent', configPath };
  }

  const wroteFresh = await backupConfigIfFirstRun(configPath);
  const backup = { path: `${configPath}.bak`, preserved: !wroteFresh };
  delete config.mcpServers?.[SERVER_NAME];
  await writeJsonMcpConfig(configPath, config);

  logger.info(`Editmamei unregistered from Cursor config: ${configPath}`);
  return { client: CLIENT_NAME, status: 'removed', configPath, backup };
}

export async function statusCursor(opts: InstallClientOptions = {}): Promise<StatusResult> {
  const configPath = resolveConfigPath(opts);

  if (!(await detect(configPath))) {
    return { client: CLIENT_NAME, status: 'not-detected', configPath };
  }

  let read;
  try {
    read = await readJsonMcpConfig(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      client: CLIENT_NAME,
      status: 'error',
      configPath,
      error: msg,
      detail: 'Existing ~/.cursor/mcp.json is not valid JSON.',
    };
  }

  if (!read.hadExisting) {
    return { client: CLIENT_NAME, status: 'not-registered', configPath };
  }

  const entry = read.config.mcpServers?.[SERVER_NAME];
  if (!entry) {
    return { client: CLIENT_NAME, status: 'not-registered', configPath };
  }
  return {
    client: CLIENT_NAME,
    status: 'registered',
    configPath,
    command: `${entry.command} ${(entry.args ?? []).join(' ')}`.trim(),
  };
}

// Re-export so tests can pin the path without importing paths.ts directly.
export { join, homedir };
