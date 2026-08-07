/**
 * Shared types for the per-client MCP adapters.
 *
 * Each adapter (Claude Desktop, Cursor, Claude Code) implements its own
 * detect / install / uninstall / status — the orchestrator in
 * `src/cli/install.ts` iterates them and aggregates the results.
 */

/** An MCP server entry — same shape used by Claude Desktop, Cursor, and the Claude Code CLI. */
export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Outcome of an install pass on one client. */
export type InstallStatus =
  | 'created' // wrote a brand-new config / registration
  | 'updated' // replaced an existing different entry
  | 'unchanged' // entry already matched what we'd write
  | 'skipped' // client not detected / not installed
  | 'failed'; // attempted but failed (error in result)

export interface BackupInfo {
  /** Path of the .bak file on disk. */
  path: string;
  /** True if we wrote it just now; false if we preserved a prior .bak. */
  preserved: boolean;
}

export interface InstallResult {
  client: string;
  status: InstallStatus;
  detail?: string;
  configPath?: string;
  error?: string;
  /** Present when a write happened against an existing config file. */
  backup?: BackupInfo;
}

/** Outcome of an uninstall pass on one client. */
export type UninstallStatus =
  | 'removed' // entry existed and was deleted
  | 'absent' // no entry to remove
  | 'skipped' // client not detected
  | 'failed';

export interface UninstallResult {
  client: string;
  status: UninstallStatus;
  detail?: string;
  configPath?: string;
  error?: string;
  backup?: BackupInfo;
}

/** Outcome of a status query on one client. */
export type StatusStatus = 'registered' | 'not-registered' | 'not-detected' | 'error';

export interface StatusResult {
  client: string;
  status: StatusStatus;
  command?: string;
  configPath?: string;
  detail?: string;
  error?: string;
}

export interface ClientOptions {
  /** stdout sink. Test hook. */
  out?: (s: string) => void;
}

export interface InstallClientOptions extends ClientOptions {
  /** Override the resolved config path / location. Test-only. */
  configPath?: string;
}
