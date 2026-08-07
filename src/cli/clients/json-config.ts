/**
 * Shared helpers for clients whose MCP config is a JSON file with a
 * top-level `mcpServers` map. Today that's Claude Desktop and Cursor —
 * same shape, different paths. Claude Code uses a CLI invocation instead
 * and does NOT use this helper.
 *
 * The shape:
 * ```json
 * {
 *   "mcpServers": {
 *     "editmamei": { "command": "npx", "args": ["-y", "editmamei"] }
 *   }
 * }
 * ```
 *
 * Both clients accept additional top-level keys; we preserve them on
 * read-merge-write. Both also accept additional sibling `mcpServers`
 * entries; we leave those alone too.
 */

import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InstallStatus, McpServerEntry, UninstallStatus } from './types.js';

export const SERVER_NAME = 'editmamei';

export interface JsonMcpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface ReadJsonResult {
  config: JsonMcpConfig;
  hadExisting: boolean;
}

/**
 * Read an existing JSON MCP config file. Treats an empty file as a fresh
 * config (so newly-created shells don't get a parse error). Throws if the
 * file exists but is malformed JSON — calling code surfaces that to the
 * user; we never silently overwrite a file we can't parse.
 */
export async function readJsonMcpConfig(configPath: string): Promise<ReadJsonResult> {
  if (!existsSync(configPath)) {
    return { config: {}, hadExisting: false };
  }
  const raw = await readFile(configPath, 'utf8');
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { config: {}, hadExisting: true };
  }
  const config = JSON.parse(raw) as JsonMcpConfig;
  return { config, hadExisting: true };
}

/**
 * Backup helper. Copies `configPath` to `configPath.bak` only if no
 * `.bak` already exists — the pre-install state is more valuable than
 * any of our own first-run outputs, so a second install never clobbers
 * the original backup. Returns true if a fresh backup was written.
 */
export async function backupConfigIfFirstRun(configPath: string): Promise<boolean> {
  if (!existsSync(configPath)) return false;
  const backupPath = `${configPath}.bak`;
  if (existsSync(backupPath)) return false;
  await copyFile(configPath, backupPath);
  return true;
}

/**
 * Atomic write via tmpfile + rename. A crash / power-loss between
 * truncate and full write would otherwise leave a zero-byte (or
 * partially-written) `claude_desktop_config.json` / `mcp.json` — and
 * a second `editmamei install` run finds no `.bak` to restore from
 * because `backupConfigIfFirstRun` only fires once. We mirror the
 * tmp+rename pattern that `scripts/lib/build-common.ts` uses for the
 * Pro→CE stub swap. The tmp filename is sibling-scoped so the rename
 * stays on the same volume and is atomic on both POSIX and NTFS.
 *
 * Best-effort cleanup of the tmp file on write failure — leaving a
 * `.editmamei.tmp` next to the real config is preferable to throwing
 * a second error from the catch.
 */
export async function writeJsonMcpConfig(configPath: string, config: JsonMcpConfig): Promise<void> {
  const dir = dirname(configPath);
  // Suffix carries this process's PID so a parallel install pass (rare,
  // but possible from a script that fires both `claude mcp add` and
  // `cursor mcp add`) doesn't clobber the other's tmp.
  const tmpPath = join(dir, `.editmamei.json-config.${process.pid}.tmp`);
  const body = JSON.stringify(config, null, 2) + '\n';
  // mode 0o600 so the MCP-client config (may carry an env-injected license key)
  // isn't created world-readable — without it the file inherits the umask
  // default (often 0644). Mirrors the atomic write in src/core/settings.ts.
  // POSIX-only effect; mode is cosmetic on Windows (NTFS ACLs govern there).
  await writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(tmpPath, configPath);
  } catch (err) {
    // Best-effort cleanup of the orphaned tmp before bubbling up.
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/** Ensure the parent dir of `configPath` exists. Throws if it can't. */
export async function ensureConfigParentDir(configPath: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merge an existing entry's env vars into a fresh entry. If the user
 * hand-edited `env` to add things like LOG_LEVEL=0, those keys survive
 * a re-run of `editmamei install` — only the keys WE explicitly set
 * (PHOTOSHOP_PATH today) get overwritten. Returns a new entry; never
 * mutates inputs.
 *
 * When there's no existing entry, this is a no-op pass-through.
 */
export function mergeEnvFromExisting(
  existing: McpServerEntry | undefined,
  fresh: McpServerEntry
): McpServerEntry {
  const existingEnv = existing?.env;
  if (!existingEnv || Object.keys(existingEnv).length === 0) {
    return fresh;
  }
  return {
    ...fresh,
    env: { ...existingEnv, ...(fresh.env ?? {}) },
  };
}

/**
 * Decide what an install should do given the existing config state. Pure
 * function so adapters can reuse it without re-implementing the
 * idempotency check.
 *
 * Returns `'unchanged'` if `entry` already matches what's in the config,
 * `'updated'` if a different entry was there, `'created'` if the entry
 * was absent.
 */
export function classifyInstall(
  config: JsonMcpConfig,
  entry: McpServerEntry
): Extract<InstallStatus, 'created' | 'updated' | 'unchanged'> {
  const existing = config.mcpServers?.[SERVER_NAME];
  if (!existing) return 'created';
  if (deepEqual(existing, entry)) return 'unchanged';
  return 'updated';
}

/** Decide what uninstall should do given the existing config state. */
export function classifyUninstall(
  config: JsonMcpConfig
): Extract<UninstallStatus, 'removed' | 'absent'> {
  return config.mcpServers?.[SERVER_NAME] ? 'removed' : 'absent';
}
