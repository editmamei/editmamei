/**
 * `editmamei uninstall` — remove the editmamei entry from every detected
 * MCP client. Mirrors the install orchestrator; one client's failure
 * does not abort the others.
 *
 * Preserves per-user data at ~/.editmamei/ in every case (templates,
 * session logs). Per-client `.bak` snapshots are also preserved by the
 * adapters' first-run-only backup rule.
 */

import { Logger } from '../utils/logger.js';
import { uninstallClaudeDesktop } from './clients/claude-desktop.js';
import { uninstallCursor } from './clients/cursor.js';
import { uninstallClaudeCode } from './clients/claude-code.js';
import type { ClientOptions, InstallClientOptions, UninstallResult } from './clients/types.js';

const logger = new Logger('Uninstall');

export interface UninstallOptions {
  stdout?: (s: string) => void;
  claudeDesktopConfigPath?: string;
  cursorConfigPath?: string;
  skipClaudeDesktop?: boolean;
  skipCursor?: boolean;
  skipClaudeCode?: boolean;
}

export async function runUninstall(opts: UninstallOptions = {}): Promise<void> {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));

  out(`Removing Editmamei from MCP clients\n\n`);

  const results: UninstallResult[] = [];

  const cdOpts: InstallClientOptions = { out };
  if (opts.claudeDesktopConfigPath !== undefined) cdOpts.configPath = opts.claudeDesktopConfigPath;
  if (!opts.skipClaudeDesktop) results.push(await uninstallClaudeDesktop(cdOpts));

  const cursorOpts: InstallClientOptions = { out };
  if (opts.cursorConfigPath !== undefined) cursorOpts.configPath = opts.cursorConfigPath;
  if (!opts.skipCursor) results.push(await uninstallCursor(cursorOpts));

  const ccOpts: ClientOptions = { out };
  if (!opts.skipClaudeCode) results.push(await uninstallClaudeCode(ccOpts));

  let removed = 0;
  let failed = 0;
  for (const r of results) {
    out(renderUninstallLine(r));
    if (r.status === 'removed') removed++;
    if (r.status === 'failed') failed++;
  }

  if (failed === results.length) {
    throw new Error('all MCP clients failed to remove');
  }

  out(`\n  Per-user data at ~/.editmamei/ is preserved (templates, session logs).\n`);
  if (removed > 0) {
    out(`  Restart any affected MCP clients to drop the running server process.\n`);
  }

  if (failed > 0) {
    out(`\n  ${failed} client(s) failed — see lines above. Other clients were cleaned up.\n`);
  }

  logger.info(`Uninstall pass complete: ${removed} removed, ${failed} failed`);
}

function renderUninstallLine(r: UninstallResult): string {
  const head = (mark: string, body: string) => `  ${mark} ${r.client}: ${body}\n`;
  let line = '';
  switch (r.status) {
    case 'removed':
      line = head('✓', `removed     (${r.configPath ?? 'via CLI'})`);
      break;
    case 'absent':
      line = head('-', `not registered — nothing to do`);
      break;
    case 'skipped':
      line = head('-', `skipped — client not detected`);
      break;
    case 'failed': {
      const err = r.error ? ` (${r.error})` : '';
      line = `  ✗ ${r.client}: ${r.detail ?? 'failed'}${err}\n`;
      break;
    }
  }
  if (r.backup) {
    line += r.backup.preserved
      ? `      Pre-existing backup preserved at ${r.backup.path}\n`
      : `      Backed up prior config → ${r.backup.path}\n`;
  }
  return line;
}
