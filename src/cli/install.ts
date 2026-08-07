/**
 * `editmamei install` — register Editmamei as an MCP server with every
 * detected MCP client.
 *
 * Today that's three clients:
 *
 *   - Claude Desktop  (`~/Library/Application Support/Claude/...` or
 *                      `%APPDATA%\Claude\...`) — always written.
 *   - Cursor          (`~/.cursor/mcp.json`) — written iff Cursor is
 *                     detected.
 *   - Claude Code     (via `claude mcp add --scope user`) — written iff
 *                     the `claude` binary is on PATH.
 *
 * Each per-client adapter knows how to detect itself, write its own
 * config shape, back up the prior state, and report success/skip/failure.
 * The orchestrator here just runs them and renders a per-client result
 * line. One client's failure does not abort the others.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '../utils/logger.js';
import { installClaudeDesktop } from './clients/claude-desktop.js';
import { installCursor } from './clients/cursor.js';
import { installClaudeCode } from './clients/claude-code.js';
import { detectDownloadsDir } from './downloads-dir.js';
import type {
  ClientOptions,
  InstallClientOptions,
  InstallResult,
  McpServerEntry,
} from './clients/types.js';

const logger = new Logger('Install');

export interface InstallOptions {
  /** Use the absolute path to the current binary instead of `npx -y editmamei`. */
  dev?: boolean;
  /** Override the dev binary path. Test-only; defaults to `process.argv[1]`. */
  devBinaryPath?: string;
  /**
   * Optional absolute path to the Photoshop binary. Baked into the
   * `env: { PHOTOSHOP_PATH }` of the MCP server entry across all three
   * clients. Use when Photoshop is installed somewhere the auto-detector
   * can't find (custom drive letter, side-by-side installs, etc.).
   */
  photoshopPath?: string;
  /** stdout sink. Test-only; defaults to `process.stdout.write`. */
  stdout?: (s: string) => void;
  /** Per-client config-path overrides. Test-only. */
  claudeDesktopConfigPath?: string;
  cursorConfigPath?: string;
  /** Skip a specific client (test seam — never set by the CLI). */
  skipClaudeDesktop?: boolean;
  skipCursor?: boolean;
  skipClaudeCode?: boolean;
  /**
   * Skip the editmamei skill bundle copy. Headless / CI installs that
   * don't need the claude.ai-side skill should pass `--skip-skill`.
   */
  skipSkill?: boolean;
  /**
   * Override the location of the bundled skill zip. Test seam.
   * Defaults to `<dist>/skills/editmamei-skill.zip` resolved from the
   * compiled location of this module.
   */
  skillBundleSourcePath?: string;
  /**
   * Override the Downloads-directory destination. Test seam.
   */
  skillBundleDestDir?: string;
}

// Re-export so existing callers / tests of these types keep working.
export type { McpServerEntry } from './clients/types.js';

/** Throws on hard failure; the router translates throws into exit 1. */
export async function runInstall(opts: InstallOptions = {}): Promise<void> {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const entry = buildEntry(opts);

  out(`Installing Editmamei MCP server\n`);
  out(`  Command form: ${entry.command} ${(entry.args ?? []).join(' ')}\n`);
  if (entry.env && Object.keys(entry.env).length > 0) {
    for (const [k, v] of Object.entries(entry.env)) {
      out(`  env: ${k}=${v}\n`);
    }
  }
  out(`\n`);

  const results: InstallResult[] = [];

  const cdOpts: InstallClientOptions = { out };
  if (opts.claudeDesktopConfigPath !== undefined) cdOpts.configPath = opts.claudeDesktopConfigPath;
  if (!opts.skipClaudeDesktop) results.push(await installClaudeDesktop(entry, cdOpts));

  const cursorOpts: InstallClientOptions = { out };
  if (opts.cursorConfigPath !== undefined) cursorOpts.configPath = opts.cursorConfigPath;
  if (!opts.skipCursor) results.push(await installCursor(entry, cursorOpts));

  const ccOpts: ClientOptions = { out };
  if (!opts.skipClaudeCode) results.push(await installClaudeCode(entry, ccOpts));

  let touched = 0;
  let failed = 0;
  for (const r of results) {
    out(renderInstallLine(r));
    if (r.status === 'created' || r.status === 'updated') touched++;
    if (r.status === 'failed') failed++;
  }

  if (failed === results.length) {
    // Everything failed — surface as a hard error so the shell pipeline sees it.
    throw new Error('all MCP clients failed to register');
  }

  let skillResult: SkillCopyResult | null = null;
  if (!opts.skipSkill) {
    skillResult = copySkillBundle({
      out,
      sourcePathOverride: opts.skillBundleSourcePath,
      destDirOverride: opts.skillBundleDestDir,
    });
  }

  out(`\nNext steps:\n`);
  if (touched === 0) {
    out(`  1. No MCP client changes were needed; existing registrations already match.\n`);
  } else {
    out(`  1. Restart your AI client(s) so they pick up the new MCP server entry.\n`);
  }
  if (skillResult?.status === 'copied') {
    out(`  2. Upload the editmamei skill to your Claude account:\n`);
    out(`       - Open https://claude.ai/settings (Customize > Skills)\n`);
    out(`       - Click "Upload skill"\n`);
    out(`       - Choose the file at ${skillResult.destPath}\n`);
    out(`     The skill auto-loads in any photo-editing conversation. It's a one-time upload.\n`);
    out(
      `  3. Then ask the AI: "Is Photoshop connected?" — it will call ps_ping and return your Photoshop version.\n`
    );
  } else {
    out(
      `  2. Then ask the AI: "Is Photoshop connected?" — it will call ps_ping and return your Photoshop version.\n`
    );
  }

  if (failed > 0) {
    out(`\n  ${failed} client(s) failed — see lines above. Other clients were registered.\n`);
  }

  logger.info(
    `Install pass complete: ${touched} touched, ${failed} failed, skill=${skillResult?.status ?? 'skipped'}`
  );
}

interface SkillCopyResult {
  status: 'copied' | 'missing-source' | 'failed' | 'skipped';
  destPath?: string;
  reason?: string;
}

interface SkillCopyOptions {
  out: (s: string) => void;
  sourcePathOverride?: string;
  destDirOverride?: string;
}

/**
 * Copies the bundled editmamei-skill.zip from <package>/dist/skills/
 * into the user's Downloads folder so they can hand-upload it to
 * claude.ai > Settings > Customize > Skills.
 *
 * Soft-fails by design — a missing zip or unwritable Downloads folder
 * should NOT block MCP server registration (which succeeded by the
 * time we get here). The status is printed inline and reflected in
 * the Next steps block; the install as a whole still completes.
 */
function copySkillBundle(opts: SkillCopyOptions): SkillCopyResult {
  // Resolve the bundled zip path. In a production install via npm, this
  // module compiles to <pkg>/dist/cli/install.js and the zip ships at
  // <pkg>/dist/skills/editmamei-skill.zip — i.e. one level up from
  // __dirname.
  const sourcePath =
    opts.sourcePathOverride ??
    join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'editmamei-skill.zip');

  if (!existsSync(sourcePath)) {
    opts.out(`\nSetting up Claude skill\n`);
    opts.out(`  - skill bundle missing at ${sourcePath}; skipping upload step\n`);
    opts.out(`    (Rebuild with \`npm run build\` to regenerate it.)\n`);
    return { status: 'missing-source', reason: 'bundle not found at expected path' };
  }

  const destDir = opts.destDirOverride ?? detectDownloadsDir().path;
  const destPath = join(destDir, 'editmamei-skill.zip');

  try {
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    copyFileSync(sourcePath, destPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.out(`\nSetting up Claude skill\n`);
    opts.out(`  - failed to copy skill bundle to ${destPath}: ${msg}\n`);
    opts.out(
      `    (The MCP server install succeeded; you can copy the bundle manually from ${sourcePath}.)\n`
    );
    return { status: 'failed', reason: msg };
  }

  opts.out(`\nSetting up Claude skill\n`);
  opts.out(`  ✓ editmamei skill bundle copied to: ${destPath}\n`);
  return { status: 'copied', destPath };
}

function renderInstallLine(r: InstallResult): string {
  const head = (mark: string, body: string) => `  ${mark} ${r.client}: ${body}\n`;
  let line = '';
  switch (r.status) {
    case 'created':
      line = head('✓', `registered  (${r.configPath ?? 'via CLI'})`);
      break;
    case 'updated':
      line = head('✓', `updated     (${r.configPath ?? 'via CLI'})`);
      break;
    case 'unchanged':
      line = head('=', `already registered with the same configuration`);
      break;
    case 'skipped':
      line = head('-', `skipped — ${r.detail ?? 'client not detected'}`);
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

export function buildEntry(opts: {
  dev?: boolean;
  devBinaryPath?: string;
  photoshopPath?: string;
}): McpServerEntry {
  let entry: McpServerEntry;
  if (opts.dev) {
    const raw = opts.devBinaryPath ?? process.argv[1];
    if (!raw) {
      throw new Error('--dev requires a binary path. Could not derive one from process.argv[1].');
    }
    entry = { command: 'node', args: [pathResolve(raw)] };
  } else {
    entry = { command: 'npx', args: ['-y', 'editmamei'] };
  }

  if (opts.photoshopPath) {
    // Resolve any relative segments so the env var is a stable absolute
    // path. The MCP client reads this at server-spawn time; it should not
    // depend on the cwd the user happened to be in when running install.
    entry.env = { PHOTOSHOP_PATH: pathResolve(opts.photoshopPath) };
  }

  return entry;
}
