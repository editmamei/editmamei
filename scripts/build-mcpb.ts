/*
 * Packages the Community Edition into an MCP Bundle (`editmamei-<version>.mcpb`)
 * — Anthropic's one-click install format for Claude Desktop.
 *
 * Why this exists: Claude Desktop does NOT bundle Node, so a non-developer
 * photographer can't run the npm-distributed server (no Node, no npm, no
 * hand-edited claude_desktop_config.json). An `.mcpb` is a zip containing the
 * server + a `manifest.json`; Claude Desktop ships its OWN Node runtime and
 * installs the bundle with one double-click — zero system Node/npm. This is the
 * CE / Claude-Desktop on-ramp (Pro leans on Claude Code, which already has Node).
 *
 * Format: MCP Bundle manifest spec v0.3 (renamed from DXT/.dxt late 2025;
 * https://github.com/anthropics/mcpb). The bundle is a plain zip with
 * manifest.json at the root, the compiled server under dist/, and bundled
 * production node_modules (Claude Desktop does not install dependencies).
 *
 * This is a RELEASE artifact, not part of every `npm run build` — it runs a
 * fresh CE build (incl. the cross-compiled go-core binaries) then packs. Invoke
 * via `npm run build:mcpb`. Output lands in packages/ (gitignored). Optionally
 * validate/sign the result with `npx @anthropic-ai/mcpb validate|sign`.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import { packageDir, REPO_ROOT, runBuild } from './lib/build-common.js';

/** MCP Bundle manifest spec version this generator targets. */
const MANIFEST_VERSION = '0.3';

export interface McpbManifest {
  manifest_version: string;
  name: string;
  display_name: string;
  version: string;
  description: string;
  author: { name: string };
  homepage: string;
  server: {
    type: 'node';
    entry_point: string;
    mcp_config: { command: string; args: string[]; env?: Record<string, string> };
  };
  compatibility: { platforms: string[]; runtimes: { node: string } };
  user_config?: Record<
    string,
    {
      type: string;
      title: string;
      description: string;
      sensitive?: boolean;
      required?: boolean;
      default?: boolean | string;
    }
  >;
}

/**
 * Builds the manifest object. Pure (no I/O) so the version stays in lockstep
 * with package.json and the shape is unit-testable.
 *
 * `user_config` exposes the settings a Claude Desktop user can't reach by terminal
 * (there's no `editmamei config` / `editmamei activate` prompt in Desktop):
 *   - **Pro license key** — pasted into the extension settings, stored by Claude
 *     Desktop (sensitive → OS keychain) and injected as EDITMAMEI_LICENSE_KEY, which
 *     the server reads at boot to activate Pro (src/license/env-activation.ts). Blank
 *     by default → the bundle stays one-click Community.
 *   - **Telemetry toggles** — the same opt-out usage / opt-in diagnostics switches the
 *     CLI exposes, injected as EDITMAMEI_TELEMETRY_USAGE / _DIAGNOSTICS and applied over
 *     settings.json for the session (src/core/settings.ts applyTelemetryEnvOverrides).
 *     Defaults match the privacy posture (usage on, diagnostics off).
 * Photoshop is still auto-detected (no PHOTOSHOP_PATH field); a blank license key is a
 * safe no-op, unlike a blank PHOTOSHOP_PATH which would fight auto-detection.
 */
export function buildMcpbManifest(version: string, polarEnv?: string): McpbManifest {
  // The Claude-Desktop-spawned server's env. EDITMAMEI_LICENSE_KEY is injected
  // from the user_config field. EDITMAMEI_POLAR_ENV is baked ONLY when set at
  // build time (EDITMAMEI_POLAR_ENV=sandbox npm run build:mcpb) so a sandbox
  // .mcpb validates against the sandbox Polar org; the production default ships
  // clean. It's a build-flavor switch, not a user_config field.
  const env: Record<string, string> = {
    EDITMAMEI_LICENSE_KEY: '${user_config.license_key}',
    // Telemetry consent toggles — Claude Desktop has no terminal for `editmamei config`, so
    // these expose the same opt-out/opt-in switches in the extension settings. The server
    // applies them over settings.json for the session (src/core/settings.ts
    // applyTelemetryEnvOverrides).
    EDITMAMEI_TELEMETRY_USAGE: '${user_config.telemetry_usage}',
    EDITMAMEI_TELEMETRY_DIAGNOSTICS: '${user_config.telemetry_diagnostics}',
    // Boot update-check opt-out — Desktop has no terminal for `editmamei config`, so expose
    // the same switch here (applied over settings.json via applyUpdateCheckEnvOverride).
    EDITMAMEI_UPDATE_CHECK: '${user_config.update_check}',
    // Verbose-logging opt-in — Desktop has no terminal to set LOG_LEVEL, so this toggle
    // lowers logging to DEBUG (Logger reads EDITMAMEI_VERBOSE_LOGGING) so a diagnostic
    // bundle captured after a repro carries full detail. Off by default.
    EDITMAMEI_VERBOSE_LOGGING: '${user_config.verbose_logging}',
    // Install-channel marker for the boot update check. The npm/CLI path sets nothing
    // (defaults to 'npm'); only the .mcpb bundle is this channel, so the update remediation
    // says "download + reinstall the extension" instead of "npm install" (src/install-channel.ts).
    EDITMAMEI_INSTALL_CHANNEL: 'mcpb',
  };
  if (polarEnv) env.EDITMAMEI_POLAR_ENV = polarEnv;
  return {
    manifest_version: MANIFEST_VERSION,
    name: 'editmamei',
    display_name: 'Editmamei',
    version,
    description: 'Photoshop MCP server: natural-language AI photo editing with your own Photoshop',
    author: { name: 'Editmamei' },
    homepage: 'https://editmamei.com',
    server: {
      type: 'node',
      entry_point: 'dist/index.js',
      // ${__dirname} is substituted by Claude Desktop with the installed
      // bundle directory at runtime; ${user_config.license_key} with the value
      // the user typed into the extension settings (empty string when blank).
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/dist/index.js'],
        env,
      },
    },
    // Photoshop isn't on Linux, so only the two desktop platforms.
    compatibility: { platforms: ['darwin', 'win32'], runtimes: { node: '>=20.0.0' } },
    user_config: {
      license_key: {
        type: 'string',
        title: 'Pro license key',
        description:
          'Paste the key from your Editmamei Pro purchase email to unlock Pro. Leave blank to use the free Community edition.',
        sensitive: true,
        required: false,
      },
      telemetry_usage: {
        type: 'boolean',
        title: 'Share anonymous usage stats',
        description:
          'Anonymous, content-free counts (which tools run, success/duration) that help improve Editmamei. No images, file paths, or personal data are ever sent. On by default — turn off to opt out.',
        required: false,
        default: true,
      },
      telemetry_diagnostics: {
        type: 'boolean',
        title: 'Share error diagnostics (opt-in)',
        description:
          'When a tool fails, also send a sanitized error detail (basenames only — never images or full paths) to help fix bugs. Off by default.',
        required: false,
        default: false,
      },
      update_check: {
        type: 'boolean',
        title: 'Check for updates',
        description:
          'At startup, check the public npm registry for a newer Editmamei and tell you (via ps_ping) if one exists. Anonymous and content-free — no images, paths, or personal data. On by default — turn off to disable the check.',
        required: false,
        default: true,
      },
      verbose_logging: {
        type: 'boolean',
        title: 'Capture verbose diagnostics',
        description:
          'Log at DEBUG detail so a diagnostic report (ask the assistant to "report a problem") captures more. Logs stay local on your machine — nothing is sent anywhere. Off by default; turn on only while reproducing an issue.',
        required: false,
        default: false,
      },
    },
  };
}

/**
 * Copies the built CE bundle (dist/ incl. dist/bin/ go-core binaries + the
 * CE package.json) into a staging dir and writes the manifest. No npm/zip here
 * so it's testable against a fake source tree. Throws if the CE dist is absent.
 */
export function stageMcpb(
  srcCeDir: string,
  stagingDir: string,
  version: string,
  polarEnv?: string
): void {
  const srcDist = join(srcCeDir, 'dist');
  if (!existsSync(srcDist)) {
    throw new Error(
      `stageMcpb: ${srcDist} not found — build the CE bundle first (npm run build:ce).`
    );
  }
  mkdirSync(stagingDir, { recursive: true });
  cpSync(srcDist, join(stagingDir, 'dist'), { recursive: true });

  // Ship the CE package.json (production deps only — what `npm ci --omit=dev`
  // resolves below). Falls back to the root package.json's deps if the CE flavor
  // isn't present.
  const srcPkg = join(srcCeDir, 'package.json');
  if (existsSync(srcPkg)) {
    cpSync(srcPkg, join(stagingDir, 'package.json'));
  }

  // Stage the committed lockfile alongside package.json so `npm ci --omit=dev`
  // installs the exact tested dependency versions (lockfile-exact) instead of
  // re-resolving and risking drift. `npm ci` requires BOTH package.json and
  // package-lock.json present together. The lockfile lives at the repo root
  // (CE builds don't emit a per-flavor lockfile), so source it from there.
  const srcLock = join(REPO_ROOT, 'package-lock.json');
  if (existsSync(srcLock)) {
    cpSync(srcLock, join(stagingDir, 'package-lock.json'));
  }

  // Ship the legal docs alongside the bundle so the .mcpb carries the same LICENSE.md +
  // third-party attribution as the npm tarball — Claude Desktop installs the zip as-is, with
  // no npm `files` filter applying. copyDistributionFiles (build-common.ts) guarantees these
  // are present in srcCeDir by the time this runs, so a missing doc here fails loudly rather
  // than shipping a bundle silently missing its license.
  for (const doc of ['LICENSE.md', 'NOTICES.md', 'README.md']) {
    const srcDoc = join(srcCeDir, doc);
    if (!existsSync(srcDoc)) {
      throw new Error(`stageMcpb: required legal doc missing from CE build: ${srcDoc}`);
    }
    cpSync(srcDoc, join(stagingDir, doc));
  }

  writeFileSync(
    join(stagingDir, 'manifest.json'),
    JSON.stringify(buildMcpbManifest(version, polarEnv), null, 2) + '\n',
    'utf8'
  );
}

/** Installs production-only node_modules into the staging dir (the bundle is
 * self-contained — Claude Desktop never runs npm install). Uses `npm ci` against
 * the staged lockfile so the bundled node_modules match the tested versions
 * exactly (lockfile-exact) rather than re-resolving and risking drift. */
function installProdDeps(stagingDir: string): void {
  // shell: true so the npm.cmd shim resolves on Windows (mirrors packPackage).
  const res = spawnSync('npm ci --omit=dev --no-audit --no-fund', {
    cwd: stagingDir,
    stdio: 'inherit',
    shell: true,
  });
  if (res.status !== 0) {
    throw new Error(
      `installProdDeps: npm ci failed with exit code ${res.status}` +
        (res.error ? ` (${res.error.message})` : '')
    );
  }
}

/**
 * Prune the unused `onnxruntime-web` WASM/backend variants from the bundled
 * node_modules. The package ships ~10 WASM variants (~133 MB installed) but
 * `ps_detect` is the ONLY consumer, and its runtime
 * (`src/detection/runtime.ts`) forces `numThreads = 1` with the default WASM
 * backend, so it loads exactly one variant: `ort-wasm-simd-threaded.wasm`.
 * Drop the other `*.wasm` files so the one-click `.mcpb` doesn't carry ~120 MB
 * of dead weight. The kept name is the ort-web default simd+threaded artifact —
 * the only one the detection path ever fetches.
 */
export function pruneOnnxWasm(stagingDir: string): void {
  const KEEP = 'ort-wasm-simd-threaded.wasm';
  const ortDist = join(stagingDir, 'node_modules', 'onnxruntime-web', 'dist');
  if (!existsSync(ortDist)) return;
  const pruned: string[] = [];
  for (const name of readdirSync(ortDist)) {
    if (name.endsWith('.wasm') && name !== KEEP) {
      rmSync(join(ortDist, name));
      pruned.push(name);
    }
  }
  if (pruned.length) {
    console.error(
      `[build-mcpb] pruned ${pruned.length} unused onnxruntime-web wasm variant(s) (kept ${KEEP}): ${pruned.join(', ')}`
    );
  }
}

/** Zips the staging dir into the .mcpb (manifest.json at the zip root).
 *
 * NOTE: adm-zip on Windows can't set the unix exec bit on the bundled darwin
 * go-core binaries — that's fine, the runtime's GoSnippetClient.ensureExecutable
 * chmods 0755 before first spawn on non-Windows (same self-heal that covers the
 * npm-pack-strips-+x case). */
function packMcpb(stagingDir: string, destPath: string): void {
  const zip = new AdmZip();
  zip.addLocalFolder(stagingDir); // no prefix → manifest.json/dist/node_modules at root
  zip.writeZip(destPath);
}

export interface BuildMcpbOptions {
  /** Skip the fresh CE build (assumes packages/ce is already built). Tests + CI use this. */
  skipBuild?: boolean;
  /** Override the output path. Defaults to packages/editmamei-<version>.mcpb. */
  destPath?: string;
  /** Suppress the success log line. */
  silent?: boolean;
}

export async function buildMcpb(opts: BuildMcpbOptions = {}): Promise<{ destPath: string }> {
  const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    .version as string;

  if (!opts.skipBuild) {
    // Fresh CE bundle so dist/ + the cross-compiled go-core binaries are current.
    await runBuild('community', 'build-mcpb');
  }

  const ceDir = packageDir('community');
  const stagingDir = join(REPO_ROOT, 'packages', 'ce-mcpb');
  rmSync(stagingDir, { recursive: true, force: true });

  const polarEnv = process.env.EDITMAMEI_POLAR_ENV;
  if (polarEnv) {
    console.error(
      `[build-mcpb] baking EDITMAMEI_POLAR_ENV=${polarEnv} into the manifest (sandbox flavor — NOT for production)`
    );
  }
  stageMcpb(ceDir, stagingDir, version, polarEnv);
  installProdDeps(stagingDir);
  // Trim the unused onnxruntime-web WASM variants before zipping so the bundle
  // doesn't balloon (ps_detect uses exactly one).
  pruneOnnxWasm(stagingDir);

  const destPath = opts.destPath ?? join(REPO_ROOT, 'packages', `editmamei-${version}.mcpb`);
  if (existsSync(destPath)) rmSync(destPath);
  packMcpb(stagingDir, destPath);

  if (!opts.silent) {
    console.error(`[build-mcpb] wrote ${destPath}`);
  }
  return { destPath };
}

// Run when invoked directly (npm run build:mcpb), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildMcpb().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
