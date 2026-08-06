/**
 * Subcommand router. Called from `src/index.ts` with `process.argv.slice(2)`.
 *
 * Returns:
 *   - `{ handled: true,  exitCode: 0 }` — a CLI subcommand ran cleanly;
 *     caller should exit 0 without starting the MCP server.
 *   - `{ handled: true,  exitCode: 1 }` — a subcommand was matched but
 *     failed (or an unknown subcommand / option was supplied); caller
 *     should exit non-zero.
 *   - `{ handled: false, exitCode: 0 }` — no subcommand was supplied;
 *     caller should fall through and start the MCP server (this is the
 *     case when Claude Desktop spawns us).
 *
 * Returning rather than calling `process.exit` directly is what makes
 * the router testable — `process.exit` inside a switch case will kill
 * the vitest worker. The single `process.exit` call lives in `index.ts`
 * outside the test surface.
 */

import { runInstall, type InstallOptions } from './install.js';
import { runUninstall } from './uninstall.js';
import { runStatus } from './status.js';
import { runConfig } from './config.js';
import { runActivate } from './activate.js';
import { runDeactivate } from './deactivate.js';
import { runRepair } from './repair.js';
import { runLicenseStatus } from './license.js';
import { runReport } from './report.js';
import { printHelp } from './help.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger('CLI');

export interface RouteResult {
  handled: boolean;
  exitCode: number;
}

export interface RouteOptions {
  /** stderr sink. Test hook; defaults to `process.stderr.write`. */
  stderr?: (s: string) => void;
}

export async function routeCli(argv: string[], opts: RouteOptions = {}): Promise<RouteResult> {
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  const subcommand = argv[0];

  // No args (or explicit "serve") → start the MCP server.
  if (subcommand === undefined || subcommand === '' || subcommand === 'serve') {
    return { handled: false, exitCode: 0 };
  }

  try {
    switch (subcommand) {
      case 'install': {
        const installOpts = parseInstallOpts(argv.slice(1), err);
        if (installOpts === null) return { handled: true, exitCode: 1 };
        await runInstall(installOpts);
        return { handled: true, exitCode: 0 };
      }
      case 'uninstall':
        await runUninstall();
        return { handled: true, exitCode: 0 };
      case 'status':
        await runStatus();
        return { handled: true, exitCode: 0 };
      case 'config':
        // Prints results to stdout, errors to stderr; throws on bad usage → exit 1.
        runConfig(argv.slice(1));
        return { handled: true, exitCode: 0 };
      case 'activate':
        // `activate <license-key>` — throws on missing key → exit 1.
        await runActivate({ key: argv[1], stderr: err });
        return { handled: true, exitCode: 0 };
      case 'deactivate':
        await runDeactivate({ stderr: err });
        return { handled: true, exitCode: 0 };
      case 'repair':
        // Re-provision a wedged/outdated Pro module without deleting ~/.editmamei
        // — throws on no cached license → exit 1.
        await runRepair({ stderr: err });
        return { handled: true, exitCode: 0 };
      case 'license':
        await runLicenseStatus();
        return { handled: true, exitCode: 0 };
      case 'report':
        // `report [--note "<text>"]` — write an anonymized diagnostic bundle to Downloads.
        await runReport({ note: parseNoteOpt(argv.slice(1)) });
        return { handled: true, exitCode: 0 };
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        return { handled: true, exitCode: 0 };
      default:
        err(`Unknown command: ${subcommand}\n\n`);
        printHelp(err);
        return { handled: true, exitCode: 1 };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Subcommand failures already printed user-facing detail before throwing;
    // log the wrap to stderr so shell pipelines have a diagnostic too.
    logger.error(`${subcommand} failed: ${msg}`);
    return { handled: true, exitCode: 1 };
  }
}

/**
 * Parse the optional `--note <text>` / `--note=<text>` flag for `report`.
 * Returns undefined when absent. Unknown extra args are ignored (the bundle is
 * best-effort — a typo'd flag shouldn't fail a problem report).
 */
function parseNoteOpt(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--note') {
      const value = args[i + 1];
      if (value && !value.startsWith('--')) return value;
      return undefined;
    }
    if (a.startsWith('--note=')) {
      const value = a.slice('--note='.length);
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/**
 * Parse `install` options. Returns `null` on a bad option (caller maps to
 * exit 1). Returns a populated `InstallOptions` on success — `{}` is fine
 * for the no-flag case.
 */
function parseInstallOpts(args: string[], err: (s: string) => void): InstallOptions | null {
  const opts: InstallOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dev') {
      opts.dev = true;
    } else if (a === '--photoshop-path') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        err(`--photoshop-path requires a path argument.\n\n`);
        printHelp(err);
        return null;
      }
      opts.photoshopPath = value;
      i++; // consume the value
    } else if (a.startsWith('--photoshop-path=')) {
      const value = a.slice('--photoshop-path='.length);
      if (!value) {
        err(`--photoshop-path requires a non-empty path argument.\n\n`);
        printHelp(err);
        return null;
      }
      opts.photoshopPath = value;
    } else if (a === '--skip-skill') {
      // Headless / CI installs that don't need the claude.ai-side skill
      // upload bundled into ~/Downloads.
      opts.skipSkill = true;
    } else {
      err(`Unknown option for install: ${a}\n\n`);
      printHelp(err);
      return null;
    }
  }
  return opts;
}
