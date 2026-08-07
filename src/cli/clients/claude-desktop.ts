/**
 * Claude Desktop MCP adapter. Lives in `~/Library/Application Support/Claude/`
 * on macOS and `%APPDATA%\Claude\` on Windows; same JSON shape as Cursor.
 *
 * Always written, even if Claude Desktop isn't installed yet — the parent
 * dir gets created and Claude Desktop picks up the entry on next launch.
 * This is the canonical client; if a user is following the README, this
 * is almost certainly what they're installing for.
 */

import { Logger } from '../../utils/logger.js';
import { getClaudeDesktopConfigPath } from '../paths.js';
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

export const CLIENT_NAME = 'Claude Desktop';

const logger = new Logger('ClaudeDesktopAdapter');

function resolveConfigPath(opts: InstallClientOptions): string {
  return opts.configPath ?? getClaudeDesktopConfigPath(process.platform);
}

export async function installClaudeDesktop(
  entry: McpServerEntry,
  opts: InstallClientOptions = {}
): Promise<InstallResult> {
  const configPath = resolveConfigPath(opts);

  try {
    await ensureConfigParentDir(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      client: CLIENT_NAME,
      status: 'failed',
      configPath,
      error: msg,
      detail:
        'Could not create the config directory. Common causes: Claude Desktop is not installed ' +
        '(get it at https://claude.ai/download); the directory exists but is locked by a sync ' +
        'client (iCloud / OneDrive / Dropbox); Claude Desktop is still running and has the file open.',
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
        'Existing config file is not valid JSON. Fix the JSON manually (jsonlint.com is fine) or ' +
        'delete the file, then re-run editmamei install. We will not overwrite a file we cannot parse.',
    };
  }

  const { config, hadExisting } = read;
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  // Preserve any env vars the user hand-added (e.g. LOG_LEVEL=0); we only
  // override the keys WE explicitly set in this install pass.
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

  logger.info(`Editmamei registered in Claude Desktop config: ${configPath}`);
  return { client: CLIENT_NAME, status: classification, configPath, ...(backup ? { backup } : {}) };
}

export async function uninstallClaudeDesktop(
  opts: InstallClientOptions = {}
): Promise<UninstallResult> {
  const configPath = resolveConfigPath(opts);

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
        'Existing config file is not valid JSON. Fix the JSON manually or delete the file, then ' +
        're-run editmamei uninstall.',
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

  logger.info(`Editmamei unregistered from Claude Desktop config: ${configPath}`);
  return { client: CLIENT_NAME, status: 'removed', configPath, backup };
}

export async function statusClaudeDesktop(opts: InstallClientOptions = {}): Promise<StatusResult> {
  const configPath = resolveConfigPath(opts);

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
      detail: 'Existing config file is not valid JSON.',
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
