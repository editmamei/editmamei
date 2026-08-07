/**
 * `editmamei status` — show what we'd report to a user about their
 * current install state across every detected MCP client. Read-only.
 */

import { statusClaudeDesktop } from './clients/claude-desktop.js';
import { statusCursor } from './clients/cursor.js';
import { statusClaudeCode } from './clients/claude-code.js';
import type { ClientOptions, InstallClientOptions, StatusResult } from './clients/types.js';

export interface StatusOptions {
  stdout?: (s: string) => void;
  claudeDesktopConfigPath?: string;
  cursorConfigPath?: string;
  skipClaudeDesktop?: boolean;
  skipCursor?: boolean;
  skipClaudeCode?: boolean;
}

export async function runStatus(opts: StatusOptions = {}): Promise<void> {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));

  out(`Editmamei installation status\n\n`);

  const results: StatusResult[] = [];

  const cdOpts: InstallClientOptions = {};
  if (opts.claudeDesktopConfigPath !== undefined) cdOpts.configPath = opts.claudeDesktopConfigPath;
  if (!opts.skipClaudeDesktop) results.push(await statusClaudeDesktop(cdOpts));

  const cursorOpts: InstallClientOptions = {};
  if (opts.cursorConfigPath !== undefined) cursorOpts.configPath = opts.cursorConfigPath;
  if (!opts.skipCursor) results.push(await statusCursor(cursorOpts));

  const ccOpts: ClientOptions = {};
  if (!opts.skipClaudeCode) results.push(await statusClaudeCode(ccOpts));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (i > 0) out(`\n`);
    out(`${r.client}\n`);
    if (r.configPath) out(`  Config: ${r.configPath}\n`);
    switch (r.status) {
      case 'registered':
        out(`  Status: registered\n`);
        if (r.command) out(`  Command: ${r.command}\n`);
        break;
      case 'not-registered':
        out(`  Status: not registered\n`);
        break;
      case 'not-detected':
        out(`  Status: not detected${r.detail ? ` — ${r.detail}` : ''}\n`);
        break;
      case 'error':
        out(`  Status: error${r.detail ? ` — ${r.detail}` : ''}\n`);
        if (r.error) out(`  Details: ${r.error}\n`);
        break;
    }
  }

  out(`\n  To install or update across all detected clients: editmamei install\n`);
}
