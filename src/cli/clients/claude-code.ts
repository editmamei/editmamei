/**
 * Claude Code MCP adapter. Unlike Claude Desktop and Cursor, Claude Code
 * doesn't expose a single user-level JSON file we can edit reliably —
 * the schema for `~/.claude.json` is undocumented and has shifted
 * historically. We use the official `claude mcp` CLI instead.
 *
 *   - install:   `claude mcp add --scope user editmamei -- npx -y editmamei`
 *   - uninstall: `claude mcp remove editmamei --scope user`
 *   - status:    `claude mcp list --scope user` then string-match
 *
 * Detection: a `claude` binary on PATH. If absent, skip with a clear
 * "install Claude Code or use Manual configuration" hint.
 *
 * Idempotency: `claude mcp add` will fail if `editmamei` is already
 * registered at the same scope. We check via `list` first and skip the
 * add when the entry already matches; otherwise we `remove` then `add`
 * so the new shape lands cleanly.
 */

import { Logger } from '../../utils/logger.js';
import { isOnPath, runCapture } from './shell.js';
import type { McpServerEntry } from './types.js';
import type { ClientOptions, InstallResult, StatusResult, UninstallResult } from './types.js';
import { SERVER_NAME } from './json-config.js';

export const CLIENT_NAME = 'Claude Code';
export const SCOPE = 'user';
export const CLAUDE_BIN = 'claude';

const logger = new Logger('ClaudeCodeAdapter');

/** Compose the `claude mcp add` args for a given MCP entry. */
function addArgs(entry: McpServerEntry): string[] {
  // Env vars get one `-e KEY=VALUE` flag per pair, placed before the
  // server name in `claude mcp add`. Values are passed as-is; the CLI
  // does its own escaping.
  const envFlags: string[] = [];
  for (const [k, v] of Object.entries(entry.env ?? {})) {
    envFlags.push('-e', `${k}=${v}`);
  }
  return [
    'mcp',
    'add',
    '--scope',
    SCOPE,
    ...envFlags,
    SERVER_NAME,
    '--',
    entry.command,
    ...(entry.args ?? []),
  ];
}

function removeArgs(): string[] {
  return ['mcp', 'remove', SERVER_NAME, '--scope', SCOPE];
}

function listArgs(): string[] {
  return ['mcp', 'list', '--scope', SCOPE];
}

/**
 * Parse `claude mcp list` output looking for an editmamei row. Format
 * has varied across Claude Code versions; we do a forgiving substring
 * search rather than a column-precise parse. The row, when present,
 * looks something like:
 *
 *   editmamei: npx -y editmamei
 *
 * We return the rest-of-line after the name (if found) as the rendered
 * command. `null` means not registered.
 */
export function parseListForEntry(stdout: string): string | null {
  // Each row starts with the server name followed by ':' on most
  // Claude Code versions. Match conservatively.
  const re = new RegExp(`^\\s*${SERVER_NAME}\\s*:\\s*(.+?)\\s*$`, 'm');
  const m = stdout.match(re);
  return m ? m[1] : null;
}

export async function installClaudeCode(
  entry: McpServerEntry,
  _opts: ClientOptions = {}
): Promise<InstallResult> {
  if (!(await isOnPath(CLAUDE_BIN))) {
    return {
      client: CLIENT_NAME,
      status: 'skipped',
      detail:
        'claude binary not on PATH. Install Claude Code from https://claude.ai/code, or wire ' +
        'Editmamei in by hand — see the Manual configuration section in the install docs.',
    };
  }

  const desired = `${entry.command} ${(entry.args ?? []).join(' ')}`.trim();

  // Check current state. If `list` returns the same command, no-op.
  const listing = await runCapture(CLAUDE_BIN, listArgs());
  if (listing.exitCode === 0) {
    const current = parseListForEntry(listing.stdout);
    if (current === desired) {
      return { client: CLIENT_NAME, status: 'unchanged', detail: `claude mcp list: ${current}` };
    }
    if (current !== null) {
      // Existing entry differs — remove it first so `add` lands cleanly.
      // The remove CLI returns 0 even if absent, so this is safe to run.
      await runCapture(CLAUDE_BIN, removeArgs());
    }
  }

  const add = await runCapture(CLAUDE_BIN, addArgs(entry));
  if (add.exitCode !== 0) {
    return {
      client: CLIENT_NAME,
      status: 'failed',
      error: (add.stderr || add.stdout || `exit code ${add.exitCode}`).trim(),
      detail: 'claude mcp add failed. Run the command manually to see the full diagnostic.',
    };
  }

  logger.info(`Editmamei registered in Claude Code (--scope ${SCOPE})`);
  return {
    client: CLIENT_NAME,
    status:
      listing.exitCode === 0 && parseListForEntry(listing.stdout) !== null ? 'updated' : 'created',
  };
}

export async function uninstallClaudeCode(_opts: ClientOptions = {}): Promise<UninstallResult> {
  if (!(await isOnPath(CLAUDE_BIN))) {
    return { client: CLIENT_NAME, status: 'skipped' };
  }

  // Check first so we can report a meaningful 'absent' rather than a
  // possibly-noisy CLI error.
  const listing = await runCapture(CLAUDE_BIN, listArgs());
  if (listing.exitCode === 0 && parseListForEntry(listing.stdout) === null) {
    return { client: CLIENT_NAME, status: 'absent' };
  }

  const remove = await runCapture(CLAUDE_BIN, removeArgs());
  if (remove.exitCode !== 0) {
    return {
      client: CLIENT_NAME,
      status: 'failed',
      error: (remove.stderr || remove.stdout || `exit code ${remove.exitCode}`).trim(),
      detail: 'claude mcp remove failed.',
    };
  }

  logger.info(`Editmamei unregistered from Claude Code (--scope ${SCOPE})`);
  return { client: CLIENT_NAME, status: 'removed' };
}

export async function statusClaudeCode(_opts: ClientOptions = {}): Promise<StatusResult> {
  if (!(await isOnPath(CLAUDE_BIN))) {
    return { client: CLIENT_NAME, status: 'not-detected' };
  }

  const listing = await runCapture(CLAUDE_BIN, listArgs());
  if (listing.exitCode !== 0) {
    return {
      client: CLIENT_NAME,
      status: 'error',
      error: (listing.stderr || `exit code ${listing.exitCode}`).trim(),
      detail: 'claude mcp list failed.',
    };
  }

  const current = parseListForEntry(listing.stdout);
  if (current === null) {
    return { client: CLIENT_NAME, status: 'not-registered' };
  }
  return { client: CLIENT_NAME, status: 'registered', command: current };
}
