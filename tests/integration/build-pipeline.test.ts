import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  packageDir,
  patchEditionFile,
  goCoreTargets,
  devCoreOutName,
  devCoreBinDir,
  devProBinDir,
  devProCoreOutPath,
  copyModels,
  copyProModels,
} from '../../scripts/lib/build-common.ts';
import {
  coreBinaryName,
  resolveCoreBinaryPath,
  resolveProBinaryPath,
} from '../../src/api/snippet-client.ts';
import { buildMcpbManifest, stageMcpb, pruneOnnxWasm } from '../../scripts/build-mcpb.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Verifies the build-pipeline scaffolding without actually running tsc —
 * the heavy compile is exercised by `npm run build:ce` / `build:pro` in
 * the verification gate, not in the test suite (kept under 5 seconds).
 */
describe('build pipeline scaffolding', () => {
  it('packageDir() returns the canonical paths for each edition', () => {
    expect(packageDir('community')).toBe(join(REPO_ROOT, 'packages', 'ce'));
    expect(packageDir('pro')).toBe(join(REPO_ROOT, 'packages', 'pro'));
  });

  it('patchEditionFile() rewrites EDITION and the restore() callback puts it back', () => {
    const editionPath = join(REPO_ROOT, 'src', 'edition.ts');
    const original = readFileSync(editionPath, 'utf8');
    // Committed default is 'dev' (per src/edition.ts) — local dev runs
    // see the full tool surface including in-progress 'dev'-tier tools.
    expect(original).toMatch(/= 'dev';/);

    const restore = patchEditionFile('pro');
    try {
      const patched = readFileSync(editionPath, 'utf8');
      expect(patched).toMatch(/= 'pro';/);
      expect(patched).not.toMatch(/= 'dev';/);
    } finally {
      restore();
    }

    const restored = readFileSync(editionPath, 'utf8');
    expect(restored).toBe(original);
  });

  it('copyModels never stages the models/pro Pro weights (CE no-leak invariant)', () => {
    const dest = mkdtempSync(join(tmpdir(), 'em-models-ce-'));
    try {
      copyModels(dest);
      // copyModels globs only the TOP level of models/, so the Pro subdir is
      // invisible to it — the CE bundle can never pick up a Pro weight this way.
      expect(existsSync(join(dest, 'models', 'pro'))).toBe(false);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('copyProModels stages models/pro/*.onnx into <dist>/models/pro', () => {
    const dest = mkdtempSync(join(tmpdir(), 'em-models-pro-'));
    try {
      const count = copyProModels(dest);
      if (count > 0) {
        // The vendored MediaPipe face-mesh weight lands under models/pro/.
        expect(existsSync(join(dest, 'models', 'pro', 'face_mesh_468.onnx'))).toBe(true);
      } else {
        // A test-only checkout without the weight stages nothing (no dir).
        expect(existsSync(join(dest, 'models', 'pro'))).toBe(false);
      }
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("patchEditionFile('community') rewrites from the 'dev' default to 'community' + restores", () => {
    // With the dev-default change, patching to 'community' is a real
    // change (not idempotent). The committed src/edition.ts holds 'dev'
    // so dev runs see the full surface; CE builds stamp 'community'.
    const editionPath = join(REPO_ROOT, 'src', 'edition.ts');
    const original = readFileSync(editionPath, 'utf8');
    expect(original).toMatch(/= 'dev';/);

    const restore = patchEditionFile('community');
    try {
      const patched = readFileSync(editionPath, 'utf8');
      expect(patched).toMatch(/= 'community';/);
      expect(patched).not.toMatch(/= 'dev';/);
    } finally {
      restore();
    }

    expect(readFileSync(editionPath, 'utf8')).toBe(original);
  });

  it('goCoreTargets() lists the cross-compile platforms with Node-vocab filenames', () => {
    const targets = goCoreTargets();
    const names = targets.map((t) => t.out);
    // Names must match coreBinaryName() in src/api/snippet-client.ts so the
    // runtime resolver finds the bundled binary.
    expect(names).toContain('editmamei-core-win-x64.exe');
    expect(names).toContain('editmamei-core-darwin-arm64');
    expect(names).toContain('editmamei-core-darwin-x64');
    // Windows binaries carry .exe; darwin binaries do not.
    for (const t of targets) {
      const isWin = t.goos === 'windows';
      expect(t.out.endsWith('.exe')).toBe(isWin);
    }
  });

  it('dev core binary is emitted where the runtime resolves it (build-emit == runtime-lookup)', () => {
    // The Phase-2 regression was a LOCATION mismatch: handlers spawn
    // resolveCoreBinaryPath() but `npm run build` never produced a binary
    // there. Pin the contract so it can't silently break again.

    // 1. The dev build emits the same filename the runtime resolver expects.
    expect(devCoreOutName()).toBe(coreBinaryName());

    // 1b. Cross-platform mapping (the host-only assertion above can't cover
    //     the other branches): win32 renames to 'win' + carries .exe; darwin
    //     keeps its name and has no extension. Must match goCoreTargets()/
    //     coreBinaryName() so a bundle built on any host resolves at runtime.
    expect(devCoreOutName('win32', 'x64')).toBe('editmamei-core-win-x64.exe');
    expect(devCoreOutName('darwin', 'arm64')).toBe('editmamei-core-darwin-arm64');
    expect(devCoreOutName('darwin', 'x64')).toBe('editmamei-core-darwin-x64');

    // 2. The dev build drops it in <repo>/dist/bin/.
    expect(devCoreBinDir()).toBe(join(REPO_ROOT, 'dist', 'bin'));

    // 3. The runtime resolver looks in a sibling `bin/` of the compiled module
    //    (dist/api → dist/bin at runtime) for the same basename. Under the test
    //    alias the prefix is src/, so compare basename + parent-dir name, which
    //    is what actually has to agree. Clear EDITMAMEI_CORE_BIN so we exercise
    //    the default-resolution branch, not a dev override.
    const savedOverride = process.env.EDITMAMEI_CORE_BIN;
    delete process.env.EDITMAMEI_CORE_BIN;
    try {
      const resolved = resolveCoreBinaryPath();
      expect(basename(resolved)).toBe(devCoreOutName());
      expect(basename(dirname(resolved))).toBe('bin');
    } finally {
      if (savedOverride !== undefined) process.env.EDITMAMEI_CORE_BIN = savedOverride;
    }
  });

  it('dev Pro-only binary is emitted where the runtime composite resolves it', () => {
    // Same build-emit == runtime-lookup contract as the host binary, but for the
    // Pro module's own binary: buildGoCoreDev writes devProCoreOutPath() and the
    // kernel's composite client spawns resolveProBinaryPath(). Pin the equality.
    expect(devProBinDir()).toBe(join(REPO_ROOT, 'dist', 'modules', 'pro', 'bin'));
    expect(basename(devProCoreOutPath())).toBe(devCoreOutName());

    const saved = process.env.EDITMAMEI_PRO_CORE_BIN;
    delete process.env.EDITMAMEI_PRO_CORE_BIN;
    try {
      const resolved = resolveProBinaryPath();
      expect(basename(resolved)).toBe(devCoreOutName());
      expect(basename(dirname(resolved))).toBe('bin');
      expect(basename(dirname(dirname(resolved)))).toBe('pro');
    } finally {
      if (saved !== undefined) process.env.EDITMAMEI_PRO_CORE_BIN = saved;
    }
  });

  it('honors the EDITMAMEI_PRO_CORE_BIN override', () => {
    const prev = process.env.EDITMAMEI_PRO_CORE_BIN;
    process.env.EDITMAMEI_PRO_CORE_BIN = '/tmp/custom-pro-core';
    try {
      expect(resolveProBinaryPath()).toBe('/tmp/custom-pro-core');
    } finally {
      if (prev === undefined) delete process.env.EDITMAMEI_PRO_CORE_BIN;
      else process.env.EDITMAMEI_PRO_CORE_BIN = prev;
    }
  });

  it('patchEditionFile() restore writes back the original bytes even after manual mutation', () => {
    const editionPath = join(REPO_ROOT, 'src', 'edition.ts');
    const original = readFileSync(editionPath, 'utf8');

    const restore = patchEditionFile('pro');
    // Simulate something else stomping on the file mid-build.
    writeFileSync(editionPath, '// stomped\n', 'utf8');
    restore();

    expect(readFileSync(editionPath, 'utf8')).toBe(original);
  });
});

describe('mcpb bundle packaging', () => {
  it('buildMcpbManifest() emits the required v0.3 fields wired to the node server', () => {
    const m = buildMcpbManifest('1.2.3');
    expect(m.manifest_version).toBe('0.3');
    expect(m.name).toBe('editmamei');
    expect(m.version).toBe('1.2.3');
    expect(m.server.type).toBe('node');
    expect(m.server.entry_point).toBe('dist/index.js');
    expect(m.server.mcp_config.command).toBe('node');
    expect(m.server.mcp_config.args).toEqual(['${__dirname}/dist/index.js']);
    // Photoshop is desktop-only — no linux target.
    expect(m.compatibility.platforms).toEqual(['darwin', 'win32']);
    // The Pro license key + telemetry toggles are collected via user_config (no terminal in
    // Claude Desktop) and injected as env vars the server reads at boot.
    expect(m.user_config?.license_key).toMatchObject({ type: 'string', sensitive: true });
    expect(m.user_config?.license_key.required).toBe(false); // blank → one-click Community
    // Telemetry switches mirror the CLI's opt-out usage / opt-in diagnostics, defaults match
    // the privacy posture (usage on, diagnostics off).
    expect(m.user_config?.telemetry_usage).toMatchObject({ type: 'boolean', default: true });
    expect(m.user_config?.telemetry_diagnostics).toMatchObject({ type: 'boolean', default: false });
    // The boot update-check opt-out is reachable by Desktop users (no terminal) via user_config.
    expect(m.user_config?.update_check).toMatchObject({ type: 'boolean', default: true });
    // The verbose-diagnostics opt-in is off by default (logs stay richer only when reproducing).
    expect(m.user_config?.verbose_logging).toMatchObject({ type: 'boolean', default: false });
    expect(m.server.mcp_config.env).toEqual({
      EDITMAMEI_LICENSE_KEY: '${user_config.license_key}',
      EDITMAMEI_TELEMETRY_USAGE: '${user_config.telemetry_usage}',
      EDITMAMEI_TELEMETRY_DIAGNOSTICS: '${user_config.telemetry_diagnostics}',
      EDITMAMEI_UPDATE_CHECK: '${user_config.update_check}',
      EDITMAMEI_VERBOSE_LOGGING: '${user_config.verbose_logging}',
      // Install-channel marker so the boot update check tells .mcpb users to download +
      // reinstall the extension (not "npm install"); the npm path sets no such env.
      EDITMAMEI_INSTALL_CHANNEL: 'mcpb',
    });
  });

  it('stageMcpb() copies the CE dist (incl. go-core binaries) + writes a version-matched manifest', () => {
    const work = mkdtempSync(join(tmpdir(), 'editmamei-mcpb-'));
    try {
      const srcCe = join(work, 'ce');
      mkdirSync(join(srcCe, 'dist', 'bin'), { recursive: true });
      writeFileSync(join(srcCe, 'dist', 'index.js'), '// server\n', 'utf8');
      writeFileSync(join(srcCe, 'dist', 'bin', 'editmamei-core-win-x64.exe'), 'BIN', 'utf8');
      writeFileSync(join(srcCe, 'package.json'), JSON.stringify({ name: 'editmamei' }), 'utf8');
      // stageMcpb requires these to be present (copyDistributionFiles guarantees them in a
      // real CE build) — a synthetic fixture has to supply them too.
      writeFileSync(join(srcCe, 'LICENSE.md'), 'LICENSE\n', 'utf8');
      writeFileSync(join(srcCe, 'NOTICES.md'), 'NOTICES\n', 'utf8');
      writeFileSync(join(srcCe, 'README.md'), 'README\n', 'utf8');

      const staging = join(work, 'staging');
      stageMcpb(srcCe, staging, '9.9.9');

      expect(existsSync(join(staging, 'dist', 'index.js'))).toBe(true);
      // go-core binaries ride along so the bundle is self-contained.
      expect(existsSync(join(staging, 'dist', 'bin', 'editmamei-core-win-x64.exe'))).toBe(true);
      // The legal docs must land next to the bundle too — deleting the copy
      // loop in stageMcpb would still pass every other assertion here.
      expect(existsSync(join(staging, 'LICENSE.md'))).toBe(true);
      expect(existsSync(join(staging, 'NOTICES.md'))).toBe(true);
      expect(existsSync(join(staging, 'README.md'))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8'));
      expect(manifest.version).toBe('9.9.9');
      expect(manifest.server.entry_point).toBe('dist/index.js');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('stageMcpb() refuses when the CE dist is missing', () => {
    const work = mkdtempSync(join(tmpdir(), 'editmamei-mcpb-'));
    try {
      expect(() => stageMcpb(join(work, 'nope'), join(work, 'staging'), '1.0.0')).toThrow(
        /not found/
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('pruneOnnxWasm() keeps only the simd-threaded wasm and drops the rest', () => {
    const work = mkdtempSync(join(tmpdir(), 'editmamei-mcpb-'));
    try {
      const ortDist = join(work, 'node_modules', 'onnxruntime-web', 'dist');
      mkdirSync(ortDist, { recursive: true });
      const wasms = [
        'ort-wasm-simd-threaded.wasm', // the one ps_detect uses
        'ort-wasm-simd-threaded.asyncify.wasm',
        'ort-wasm-simd-threaded.jsep.wasm',
        'ort-wasm-simd-threaded.jspi.wasm',
      ];
      for (const w of wasms) writeFileSync(join(ortDist, w), 'WASM', 'utf8');
      // A non-wasm sibling must survive the prune.
      writeFileSync(join(ortDist, 'ort.min.mjs'), '// js\n', 'utf8');

      pruneOnnxWasm(work);

      expect(existsSync(join(ortDist, 'ort-wasm-simd-threaded.wasm'))).toBe(true);
      expect(existsSync(join(ortDist, 'ort-wasm-simd-threaded.asyncify.wasm'))).toBe(false);
      expect(existsSync(join(ortDist, 'ort-wasm-simd-threaded.jsep.wasm'))).toBe(false);
      expect(existsSync(join(ortDist, 'ort-wasm-simd-threaded.jspi.wasm'))).toBe(false);
      // Non-wasm backend files are left alone.
      expect(existsSync(join(ortDist, 'ort.min.mjs'))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('pruneOnnxWasm() is a no-op when onnxruntime-web is absent', () => {
    const work = mkdtempSync(join(tmpdir(), 'editmamei-mcpb-'));
    try {
      expect(() => pruneOnnxWasm(work)).not.toThrow();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
