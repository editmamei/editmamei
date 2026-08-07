#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EditmameiServer } from './core/server.js';
import { routeCli } from './cli/router.js';
import { maybeActivateFromEnv } from './license/env-activation.js';
import { refreshIfStale } from './license/entitlement.js';
import { Logger } from './utils/logger.js';

const logger = new Logger('Main');

/**
 * Install process-level safety nets BEFORE we boot anything else.
 *
 * BLOCK-4 in the launch-readiness review: the MCP server runs as a
 * long-lived stdio subprocess of the client (Claude Desktop, Cursor,
 * etc.). Any stray unhandled rejection or uncaught exception kills
 * the process abruptly; the client sees EOF on stdin with no error.
 * Before this hook, debugging that class of failure required asking
 * the user to run with `LOG_LEVEL=0` and reproduce, hoping the
 * crash got logged.
 *
 * Policy:
 *   - `unhandledRejection`: log diagnostic, KEEP ALIVE. Best-effort
 *     so the user can interrupt with their own input rather than
 *     getting silently disconnected. Most production rejections are
 *     from a single tool-call path that's already error-handled at
 *     the registry layer; the rejection escaping to here usually
 *     means a fire-and-forget side-effect failed (telemetry write,
 *     log line). Surviving is the user-friendlier default.
 *   - `uncaughtException`: log diagnostic, EXIT 1. Process state is
 *     undefined after one of these (could be a half-written file
 *     descriptor, a torn JSON-RPC frame, a corrupted in-memory
 *     queue). Fail fast and let the MCP client respawn.
 *
 * Exported via the test seam (`__installProcessHandlersForTests`) so
 * tests can verify the policy without forking a real Node process.
 */
function installProcessHandlers(): void {
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection (kept alive):', reason, promise);
  });

  process.on('uncaughtException', (error, origin) => {
    logger.error(`Uncaught exception (origin=${origin}) — exiting with code 1:`, error);
    // Use process.exitCode then a microtask exit so the logger has a chance
    // to flush to stderr before we die. setImmediate guarantees we drain
    // any queued I/O microtasks first.
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  });
}

/**
 * Release Node's global fetch (undici) connection pool before a CLI exit.
 *
 * The license subcommands (`activate` / `deactivate` / `license`) use `fetch`,
 * which keeps sockets alive in a pool. Calling `process.exit()` while those
 * sockets are mid-teardown trips a libuv `UV_HANDLE_CLOSING` assertion on
 * Windows (the command's output is correct, but the process aborts on exit).
 * Closing the global dispatcher first releases the sockets so the subsequent
 * exit is clean. Best-effort: a no-op when there's no dispatcher (no fetch ran)
 * or the internal key ever changes — never worse than the un-closed exit.
 */
async function closeHttpConnections(): Promise<void> {
  const dispatcher = (globalThis as Record<symbol, unknown>)[
    Symbol.for('undici.globalDispatcher.1')
  ] as { close?: () => Promise<void> } | undefined;
  if (dispatcher && typeof dispatcher.close === 'function') {
    try {
      await dispatcher.close();
    } catch {
      /* ignore — we're exiting anyway */
    }
  }
}

async function main() {
  installProcessHandlers();

  // CLI subcommands (install, uninstall, status, help, activate, ...) short-circuit
  // before the server boots. No args → Claude Desktop spawned us as the MCP server.
  // `routeCli` returns the exit code rather than calling `process.exit`
  // itself; that's what keeps it testable. The single exit lives here.
  const { handled, exitCode } = await routeCli(process.argv.slice(2));
  if (handled) {
    // Exit the CLI path WITHOUT process.exit(): set the code and let the event
    // loop drain naturally. The license commands use fetch (undici), whose
    // socket/async handles trip a libuv UV_HANDLE_CLOSING assertion on Windows
    // when process.exit() forces teardown mid-close. Closing the global
    // dispatcher first releases those sockets so the loop empties and the
    // process exits cleanly + promptly on its own.
    await closeHttpConnections();
    process.exitCode = exitCode;
    return;
  }

  try {
    logger.info('Starting Editmamei...');

    // .mcpb / Claude Desktop activation: if the user pasted a license key into
    // the extension settings, Claude Desktop passes it as EDITMAMEI_LICENSE_KEY.
    // Activate from it AND provision the entitled Pro module (once, best-effort)
    // BEFORE constructing the server, so both the Pro-tool gate and
    // resolveProModule in the constructor see a fresh license + installed module.
    // No-op for npm/CLI users (who use `editmamei activate`) and when unset.
    await maybeActivateFromEnv();

    // Staleness-driven license re-validation (WO-1: boot never
    // refreshed `last_validated_at`, so online Pro users degraded to CE 30
    // days after activation and stayed there). Fresh cache: no network.
    // Stale (> 7 d): fire-and-forget, adds zero handshake latency. Past
    // grace: one ≤5 s awaited attempt so a recovering online user gets Pro
    // back on THIS boot — must run BEFORE the constructor below, which
    // resolves the Pro module from the cached verdict. Single chokepoint
    // for every install channel (npm/CLI and .mcpb both pass through here).
    await refreshIfStale();

    const server = new EditmameiServer();
    await server.start();

    // Graceful shutdown: flush telemetry (final batch + session summary) before exit.
    // Transport close already triggers the same flush via Server.onclose; these signal
    // handlers cover the kill/Ctrl-C paths. once() so a second signal can still hard-kill.
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`Received ${signal} — shutting down`);
      try {
        await server.stop();
      } catch (err) {
        logger.warn(`shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(0);
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));

    logger.info('Editmamei is running');
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Test seam — production never imports this. Test code installs handlers
// against a custom logger / process mock without forking a real node.
/** @internal */
export const __installProcessHandlersForTests = installProcessHandlers;

// Only run main() when this file is the entry point. Without this guard,
// every test that imports the module (process-handlers.test.ts pulls the
// test seam) would boot the MCP server as a side effect.
//
// Implementation notes:
//   - `pathToFileURL(realpathSync(process.argv[1])).href` is the standard
//     ESM idiom for "what URL did Node load this entry as?" — it handles
//     drive letters on Windows (forward-slashed file URL), spaces in
//     paths (URL-encoded), and resolves symlinks via realpathSync. The
//     latter is critical for the `editmamei` bin shim: invoking via the
//     PATH symlink puts the symlink path in argv[1], while import.meta.url
//     is always the realpath. Without realpathSync, the check would
//     never match under the global-install flow.
//   - The naive `new URL('file://' + path)` we previously used parsed
//     `C:` as a hostname on Windows and made the comparison fail every
//     time — `main()` simply never ran when launched as `node dist/index.js`.
const isMainEntry = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false;
  try {
    const argvUrl = pathToFileURL(realpathSync(process.argv[1])).href;
    return argvUrl === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMainEntry) {
  main();
}
