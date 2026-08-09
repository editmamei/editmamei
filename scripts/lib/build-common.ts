/**
 * Shared helpers for build-ce.ts and build-pro.ts.
 *
 * The build scripts are intentionally small: they patch `src/edition.ts`,
 * invoke tsc, copy a small set of artifacts (package.json, LICENSE.md,
 * README.md, NOTICES.md), then write SHA256 checksums. Minification,
 * property mangling, and obfuscation are deferred to a follow-up.
 *
 * Both scripts share these helpers; nothing here is build-flavor specific.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSkillZip } from '../build-skill-zip.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..');

export type Edition = 'community' | 'pro';

/** Where build artifacts land under `packages/`. */
export function packageDir(edition: Edition): string {
  return join(REPO_ROOT, 'packages', edition === 'community' ? 'ce' : 'pro');
}

/**
 * Rewrites src/edition.ts so that EDITION === <edition> before tsc runs.
 * The default committed value is 'dev' (so local development sees the
 * full tool surface including the dev-tier in-progress tools). Build
 * scripts overwrite to 'community' or 'pro' to lock the shipped bundle
 * to one edition and exclude dev-tier tools. We restore the original
 * 'dev' default after compile so the working tree stays clean.
 */
export function patchEditionFile(edition: Edition): () => void {
  const path = join(REPO_ROOT, 'src', 'edition.ts');
  const original = readFileSync(path, 'utf8');

  // Safety net for interrupted prior builds: src/edition.ts must start in
  // the committed default state ('dev'). If it doesn't, an earlier build
  // was killed before restore() ran — refuse to start so the working
  // tree doesn't drift further. Fix: revert src/edition.ts manually.
  if (!original.includes(`= 'dev';`)) {
    throw new Error(
      `patchEditionFile: src/edition.ts is not in the expected 'dev' default state. ` +
        `A previous build was likely interrupted before its restore() ran. ` +
        `Revert src/edition.ts so EDITION reads 'dev' and re-run.`
    );
  }

  const patched = original.replace(
    /export const EDITION: 'dev' \| 'community' \| 'pro' = '(dev|community|pro)';/,
    `export const EDITION: 'dev' | 'community' | 'pro' = '${edition}';`
  );
  if (patched === original && !original.includes(`= '${edition}';`)) {
    throw new Error(
      `patchEditionFile: failed to rewrite EDITION in src/edition.ts — the export shape changed?`
    );
  }
  writeFileSync(path, patched, 'utf8');
  return () => writeFileSync(path, original, 'utf8');
}

/**
 * Runs `tsc -p tsconfig.build.json --outDir <packageDir>/dist` so the build
 * writes directly to the per-edition output. The project's own `./dist/`
 * is never touched, which means the dev MCP server (which boots from
 * `./dist/`) stays at the canonical committed-source edition regardless
 * of which bundle was last produced. Returns the count of .js files written.
 *
 * `tsconfig.build.json` extends the root config but turns OFF sourceMap +
 * declaration + declarationMap and ON removeComments — published bundles
 * carry no source maps (no `sourcesContent` leak), no `.d.ts`/`.d.ts.map`
 * dead weight, and no build-machine paths embedded in comments.
 *
 * Source `.js` import suffixes (TS ESM convention) resolve correctly in
 * the output because tsc preserves the rootDir-relative tree shape under
 * --outDir: src/core/server.ts -> <distOut>/core/server.js, etc.
 */
export function compileToPackageDir(edition: Edition): number {
  const out = packageDir(edition);
  mkdirSync(out, { recursive: true });
  const distOut = join(out, 'dist');
  // Clean prior output so stale files from an earlier build (e.g. a tool
  // that was deleted) don't linger in the new bundle.
  if (existsSync(distOut)) {
    rmSync(distOut, { recursive: true, force: true });
  }
  mkdirSync(distOut, { recursive: true });

  const require = createRequire(import.meta.url);
  const tscEntry = require.resolve('typescript/bin/tsc');
  const tsc = spawnSync(
    process.execPath,
    [tscEntry, '-p', 'tsconfig.build.json', '--outDir', distOut],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    }
  );
  if (tsc.status !== 0) {
    throw new Error(`tsc failed with exit code ${tsc.status}`);
  }

  let jsCount = 0;
  walk(distOut, (f) => {
    if (f.endsWith('.js')) jsCount++;
  });
  return jsCount;
}

/**
 * Pro-only DIRECTORIES stripped from the CE bundle's `dist/` AFTER tsc. The
 * Pro module is a DOWNLOADED module loaded via dynamic import (server.ts) —
 * never statically linked — so a CE build (EDITION='community') skips
 * `loadModules()` entirely and these compiled files are unreferenced.
 * `templates/` (authoring-doctrine, template-lint, signature, histogram-stats
 * — the signature DSL + lint IP) is imported ONLY by template-tools-pro; it
 * would otherwise ship as orphan IP whose prose carries Pro tool names the
 * tree-wide tool-name guard misses.
 *
 * The TOOL files are deliberately NOT listed here: `pruneProFromCE` derives
 * them from disk (every `dist/tools/*-pro.js`) at prune time. The previous
 * hand-maintained list silently missed the five 2026-07-04 *-pro files and
 * the next build:ce would have shipped their implementations in the free
 * tarball. A derived set cannot drift.
 */
export const CE_PRUNE_DIRS = ['modules/pro', 'templates'];

/**
 * Strip Pro code from the CE bundle after compile, so the published CE tarball
 * carries zero Pro IP. Replaces the old pre-tsc stub-swap (`stubProFilesForCE`):
 * once server.ts stopped statically importing the Pro module, the CE
 * build no longer needs stub factories to satisfy the type-checker — it compiles
 * everything, then deletes the orphan Pro files here. No-op for a Pro build.
 * Returns the count of paths removed.
 *
 * The pruned set = CE_PRUNE_DIRS + every `tools/*-pro.js` found in the compiled
 * output. This deliberately includes DEV-tier *-pro files (camera-raw,
 * select-object, the warp trio, the detection orchestrations): they're
 * registered only by the (pruned) Pro module and reference Pro/dev tool names
 * as string literals, so they'd be orphan leaks in CE regardless of tier.
 * Counterpart test derivation: tests/integration/build-output.test.ts globs
 * `src/tools/*-pro.ts` (the source side of the same set).
 */
/**
 * Does this working tree carry commercial sources at all?
 *
 * Asked of `src/`, not of the compiled output, because it is answering "could
 * there have been anything to prune" — a question about what was compiled, not
 * about what the prune found. In this repository the answer is no; in the
 * repository that builds the paid module it is yes.
 */
export function treeContainsProSources(): boolean {
  const srcTools = join(REPO_ROOT, 'src', 'tools');
  const hasProTool =
    existsSync(srcTools) && readdirSync(srcTools).some((f) => f.endsWith('-pro.ts'));
  return hasProTool || existsSync(join(REPO_ROOT, 'src', 'modules', 'pro'));
}

export function pruneProFromCE(edition: Edition): number {
  if (edition !== 'community') return 0;
  const distOut = join(packageDir(edition), 'dist');
  const toolsDir = join(distOut, 'tools');
  const proTools = existsSync(toolsDir)
    ? readdirSync(toolsDir).filter((f) => f.endsWith('-pro.js'))
    : [];
  // Zero matches means one of two opposite things, and telling them apart is
  // the whole point.
  //
  // If the source tree HAS commercial files, zero is alarming: the glob must
  // have broken — a renamed directory, a changed suffix — and proceeding would
  // ship those files in the free tarball. That must fail loudly, which is what
  // this guard was written for when both editions lived in one repository.
  //
  // If the source tree has NO commercial files, zero is simply correct. There is
  // nothing to prune because there was never anything to prune. Since the split
  // this is the normal case here, and the original guard turned it into a build
  // failure — which is exactly how it failed the first release rehearsal.
  //
  // So ask the source tree rather than assuming.
  if (proTools.length === 0) {
    if (treeContainsProSources()) {
      throw new Error(
        `pruneProFromCE: found zero *-pro.js files under ${toolsDir}, but this tree DOES ` +
          `contain commercial sources — the prune derivation is broken (renamed directory?); ` +
          `refusing to produce an unpruned CE bundle`
      );
    }
    return 0;
  }
  let removed = 0;
  for (const rel of [...CE_PRUNE_DIRS, ...proTools.map((f) => `tools/${f}`)]) {
    const p = join(distOut, rel);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/** Recursively copies srcDir → dstDir. Returns number of .js files copied. */
export function copyTree(srcDir: string, dstDir: string): number {
  if (!existsSync(srcDir)) {
    throw new Error(`copyTree: source ${srcDir} does not exist`);
  }
  mkdirSync(dstDir, { recursive: true });
  let jsCount = 0;
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const dstPath = join(dstDir, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      jsCount += copyTree(srcPath, dstPath);
    } else {
      writeFileSync(dstPath, readFileSync(srcPath));
      if (entry.endsWith('.js')) jsCount++;
    }
  }
  return jsCount;
}

/**
 * The two license files at play, and which edition ships which:
 *
 *  - `LICENSE.md` — the Fair Source License (FSL) text that governs this CE
 *    tree's source. Ships in the free npm tarball / .mcpb bundle.
 *  - `LICENSE` (no extension) — the commercial Pro EULA. Lives only in the
 *    private editmamei-pro repo root; this CE tree never contains it.
 *
 * This file is CE-owned but hydrates verbatim into editmamei-pro, where
 * `build:pro` runs against a root that carries BOTH files (its own `LICENSE`
 * plus, post-hydration, this repo's `LICENSE.md`). Picking the wrong one ships
 * the FSL text on the paid artifact and drops the EULA — or the reverse. Do
 * NOT collapse this to a single constant; the edition branch is the fix.
 */
export function licenseFileName(edition: Edition): string {
  return edition === 'pro' ? 'LICENSE' : 'LICENSE.md';
}

/**
 * The legal docs every published artifact must carry, edition-picked. The
 * single source of truth for three consumers: the npm `files` allowlist, the
 * package-dir copy step below, and the .mcpb staging in build-mcpb.ts —
 * lists whose silent divergence is exactly how 1.0.0 shipped without a
 * license file.
 */
export function requiredDistributionDocs(edition: Edition): string[] {
  return [licenseFileName(edition), 'README.md', 'NOTICES.md'];
}

/**
 * The npm `files` allowlist for the CE/Pro package.json — everything the
 * published tarball/bundle ships. Split out from writePackageJson (a pure
 * function, no I/O) so the edition-conditional license entry is directly
 * unit-testable without needing a built packages/<edition>/ dir on disk.
 */
export function packageFilesList(edition: Edition): string[] {
  return ['dist', ...requiredDistributionDocs(edition)];
}

/** The repo-root package.json fields the published manifest draws from. */
export interface SourcePackageJson {
  name: string;
  mcpName: string;
  bin: Record<string, string>;
  scripts: Record<string, string>;
  keywords: string[];
  author: string;
  license: string;
  repository: unknown;
  homepage: string;
  bugs: unknown;
  engines: unknown;
  dependencies: Record<string, string>;
}

/**
 * Builds the CE/Pro-flavored package.json object. The published package.json
 * carries the public-facing metadata only — devDependencies, dev scripts, and
 * internal-only fields are stripped by this explicit field whitelist.
 *
 * `mcpName` is on the whitelist deliberately: it is the official MCP
 * registry's npm-ownership marker, read from the PUBLISHED package.json and
 * required to match server.json's server name before the registry accepts a
 * listing. Dropping it here blocks that listing until the next patch release,
 * because npm versions are immutable — which is exactly what happened to
 * 1.0.0 through 1.0.2.
 *
 * Pure (no I/O) so the whitelist is directly unit-testable without needing a
 * built packages/<edition>/ dir on disk — same split as packageFilesList.
 */
export function buildPackageJson(
  edition: Edition,
  version: string,
  src: SourcePackageJson
): Record<string, unknown> {
  return {
    name: src.name,
    version,
    description:
      edition === 'community'
        ? 'Photoshop MCP server: natural-language AI photo editing with your own Photoshop (Community Edition)'
        : 'Photoshop MCP server: natural-language AI photo editing with your own Photoshop (Pro Edition)',
    mcpName: src.mcpName,
    main: 'dist/index.js',
    type: 'module',
    bin: src.bin,
    files: packageFilesList(edition),
    scripts: { start: src.scripts.start },
    keywords: src.keywords,
    author: src.author,
    license: src.license,
    repository: src.repository,
    homepage: src.homepage,
    bugs: src.bugs,
    engines: src.engines,
    dependencies: src.dependencies,
  };
}

/** Writes the CE/Pro-flavored package.json to <packageDir>. */
export function writePackageJson(edition: Edition, version: string): void {
  const src: SourcePackageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  writeFileSync(
    join(packageDir(edition), 'package.json'),
    JSON.stringify(buildPackageJson(edition, version, src), null, 2) + '\n',
    'utf8'
  );
}

/**
 * Copies the license (edition-picked — see licenseFileName), README.md, and
 * NOTICES.md from repo root to the package dir. These are the legal docs the
 * npm tarball and .mcpb bundle ship to end users — a silently-skipped copy
 * here means a published package with no license file, so a missing root doc
 * fails the build instead of being dropped quietly.
 */
export function copyDistributionFiles(edition: Edition): void {
  const out = packageDir(edition);
  for (const name of requiredDistributionDocs(edition)) {
    const src = join(REPO_ROOT, name);
    if (!existsSync(src)) {
      throw new Error(`copyDistributionFiles: required root doc missing: ${src}`);
    }
    writeFileSync(join(out, name), readFileSync(src));
  }
}

/**
 * Walks <packageDir>/dist and writes SHA256 sums to <packageDir>/SHA256SUMS.
 * The sums file matches the shape `sha256  relative/path` per line for use
 * with `sha256sum -c`.
 */
export function writeChecksums(edition: Edition): void {
  const out = packageDir(edition);
  const distOut = join(out, 'dist');
  const sums: string[] = [];
  walk(distOut, (file) => {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    sums.push(`${hash}  ${relative(out, file).replace(/\\/g, '/')}`);
  });
  writeFileSync(join(out, 'SHA256SUMS'), sums.join('\n') + '\n', 'utf8');
}

/**
 * Run `npm pack` inside the per-edition package directory to produce the
 * tarball that will eventually be uploaded (Pro: to R2 / CE: to npm).
 *
 * Without this step, there's no verifiable "what the tarball will actually look like"
 * artifact in the build output — making it impossible to sign or verify
 * the Pro release. Now every Pro build leaves a `.tgz` next to the
 * `dist/` tree and appends its SHA256 to `SHA256SUMS` so downstream
 * verification has a single source of truth.
 *
 * Also wipes any pre-existing `*.tgz` in the package dir before packing
 * (closes T07 P2 — the build pipeline previously kept stale tarballs
 * from earlier runs, which would become a foot-gun for any signing
 * step that globbed `*.tgz`).
 *
 * Returns the tarball filename (relative to the package dir).
 */
export function packPackage(edition: Edition): string {
  const pkgDir = packageDir(edition);

  // Clean any stale .tgz before producing a new one.
  for (const entry of readdirSync(pkgDir)) {
    if (entry.endsWith('.tgz')) {
      rmSync(join(pkgDir, entry));
    }
  }

  // `shell: true` is needed on Windows so the shim resolves `npm` to
  // `npm.cmd` correctly. Without it, spawnSync('npm.cmd', ...) returns
  // exit code null because the .cmd hand-off through cmd.exe isn't set up.
  const result = spawnSync('npm pack --pack-destination .', {
    cwd: pkgDir,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `npm pack failed with exit code ${result.status}${result.error ? ` (${result.error.message})` : ''}`
    );
  }
  // `npm pack` prints the tarball filename on its last stdout line.
  const lines = (result.stdout ?? '').trim().split(/\r?\n/);
  const tarballName = lines[lines.length - 1].trim();
  if (!tarballName || !tarballName.endsWith('.tgz')) {
    throw new Error(`npm pack did not report a .tgz filename; got: ${result.stdout}`);
  }
  return tarballName;
}

/**
 * Append the tarball's SHA256 to the existing `SHA256SUMS` file so the
 * checksums output covers BOTH the unpacked dist/ files AND the packed
 * tarball that will actually ship. A downstream signer can then sign
 * one file to attest to everything.
 */
export function appendTarballToChecksums(edition: Edition, tarballName: string): void {
  const out = packageDir(edition);
  const tarballPath = join(out, tarballName);
  const hash = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
  const line = `${hash}  ${tarballName}\n`;
  // Append rather than rewrite — preserves the existing dist/ entries.
  const sumsPath = join(out, 'SHA256SUMS');
  writeFileSync(sumsPath, readFileSync(sumsPath, 'utf8') + line, 'utf8');
}

/** A Go cross-compile target: GOOS/GOARCH + the bundled binary filename. */
export interface GoTarget {
  goos: string;
  goarch: string;
  out: string;
}

/**
 * The platforms the editmamei-core binary is cross-compiled for. Filenames use
 * Node's platform/arch vocabulary (win/x64, darwin/arm64) so `coreBinaryName()`
 * in src/api/snippet-client.ts resolves the right one at runtime. Photoshop
 * isn't on Linux, so no linux target.
 */
export function goCoreTargets(): GoTarget[] {
  return [
    { goos: 'windows', goarch: 'amd64', out: 'editmamei-core-win-x64.exe' },
    { goos: 'darwin', goarch: 'arm64', out: 'editmamei-core-darwin-arm64' },
    { goos: 'darwin', goarch: 'amd64', out: 'editmamei-core-darwin-x64' },
  ];
}

/**
 * Compile ONE go-core target: runs `go build` with the given args/env into
 * `out`, then does the redundant `codesign -s -` re-sign when the target is
 * darwin. Go's linker already ad-hoc-signs CGO_ENABLED=0 darwin binaries, so
 * the re-sign only does anything on a real macOS build host — elsewhere the
 * codesign tool is simply absent and it's skipped.
 *
 * Shared by `buildGoCore` / `buildProModuleBinaries` (cross-compile: `goos`/
 * `goarch` set, `isDarwin` = `goos === 'darwin'`) and `buildGoCoreDev`
 * (host-only build: `goos`/`goarch` unset so `go build` uses host defaults,
 * `isDarwin` = `process.platform === 'darwin'`). `label` prefixes every log
 * line/error so messages stay attributable to the calling function; `target`
 * names the thing being built in those messages (a `goos/goarch` pair for a
 * cross-compile, a parenthesized tag like `(CE host)` for the dev build).
 */
function compileGoTarget(opts: {
  goos?: string;
  goarch?: string;
  out: string;
  buildArgs: string[];
  cwd: string;
  label: string;
  target: string;
  isDarwin: boolean;
}): void {
  const { goos, goarch, out, buildArgs, cwd, label, target, isDarwin } = opts;
  const env: NodeJS.ProcessEnv = { ...process.env, CGO_ENABLED: '0' };
  if (goos) env.GOOS = goos;
  if (goarch) env.GOARCH = goarch;

  const res = spawnSync('go', ['build', ...buildArgs, '-o', out, '.'], {
    cwd,
    stdio: 'inherit',
    env,
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      `${label}: go build ${target} failed` +
        (res.error ? ` (${res.error.message})` : ` (exit ${res.status})`)
    );
  }

  // Belt-and-suspenders: Go's linker already ad-hoc-signed the darwin binary
  // (CGO_ENABLED=0), so this `codesign -s -` re-sign is redundant. It only does
  // anything on a macOS build host; elsewhere the codesign tool is absent and
  // we skip it — the binary is already signed and runs on Apple Silicon.
  if (isDarwin) {
    const sign = spawnSync('codesign', ['-s', '-', out], { stdio: 'inherit' });
    if (sign.error) {
      console.log(
        `[${label}] note: codesign tool absent (non-macOS host) — skipping the redundant ` +
          `re-sign for ${basename(out)} ${target}; it is already ad-hoc-signed by the Go ` +
          `linker and runs on Apple Silicon.`
      );
    } else if (sign.status !== 0) {
      throw new Error(`${label}: codesign ${basename(out)} failed (exit ${sign.status})`);
    }
  }
}

/**
 * Compile the editmamei-core Go binary (the sealed snippet/orchestration core)
 * for every target triple into <packageDir>/dist/bin/. Runs the template
 * generator first so the embedded encrypted blob is fresh, then cross-compiles.
 *
 * Fails loudly if the Go toolchain is missing or any build fails — we never
 * ship a bundle missing its core binary (a silent JS-only fallback would defeat
 * the at-rest protection AND break the handlers once they're flipped).
 *
 * NOTE: Go's internal linker (CGO_ENABLED=0, Go ≥1.16) auto-ad-hoc-signs the
 * darwin/arm64 binary during cross-compile, so it already satisfies Apple
 * Silicon's exec requirement and RUNS unmodified (verified codesign -dvv=adhoc
 * on a real Mac). The `codesign -s -` below is a redundant belt-and-suspenders
 * re-sign; on a non-macOS host the codesign tool is just absent and skipped. The
 * only residual is Gatekeeper download-quarantine on a browser-fetched .mcpb.
 */
export function buildGoCore(edition: Edition): void {
  const goCoreDir = join(REPO_ROOT, 'go-core');
  if (!existsSync(goCoreDir)) {
    throw new Error(`buildGoCore: go-core/ not found at ${goCoreDir}`);
  }

  // The Pro edition compiles the `//go:build pro`-tagged files (Pro snippet
  // emitters/fragments). The SAME tag must be passed to the generator so the
  // Pro fragments land in templates.enc, and to `go build` so the emitters +
  // registry dispatch compile in. CE passes no tag → Pro IP is excluded from
  // both the blob and the binary.
  const proTag = edition === 'pro' ? ['-tags', 'pro'] : [];

  // 1. Regenerate the encrypted template blob (templates.enc) before compiling.
  const gen = spawnSync('go', ['run', ...proTag, './cmd/buildtemplates'], {
    cwd: goCoreDir,
    stdio: 'inherit',
  });
  if (gen.error || gen.status !== 0) {
    throw new Error(
      `buildGoCore: template generation failed` +
        (gen.error ? ` (${gen.error.message})` : ` (exit ${gen.status})`) +
        `. Is the Go toolchain installed and on PATH?`
    );
  }

  // 2. Cross-compile each target into <packageDir>/dist/bin/.
  const binDir = join(packageDir(edition), 'dist', 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const t of goCoreTargets()) {
    compileGoTarget({
      goos: t.goos,
      goarch: t.goarch,
      out: join(binDir, t.out),
      buildArgs: [...proTag, '-trimpath', '-ldflags=-s -w'],
      cwd: goCoreDir,
      label: 'buildGoCore',
      target: `${t.goos}/${t.goarch}`,
      isDarwin: t.goos === 'darwin',
    });
  }
}

/**
 * Cross-compile the Pro module's go-core binary for every target platform into
 * `outBinDir`, using the generator's `-pro-only` blob (Pro fragments + their
 * community-helper deps, NO bulk community surface). This is the binary set the
 * downloaded Pro module artifact carries — one per platform so the install step
 * can pick the host's. Restores the community+Pro superset resting blob after.
 *
 * Fail-loud like `buildGoCore` (we never ship a Pro module missing a binary).
 * Go's linker ad-hoc-signs the darwin binaries (CGO_ENABLED=0), so they run on
 * Apple Silicon; the codesign re-sign below is redundant belt-and-suspenders.
 */
export function buildProModuleBinaries(outBinDir: string): void {
  const goCoreDir = join(REPO_ROOT, 'go-core');
  if (!existsSync(goCoreDir)) {
    throw new Error(`buildProModuleBinaries: go-core/ not found at ${goCoreDir}`);
  }
  const proTag = ['-tags', 'pro'];

  // 1. Pro-only blob (Pro fragments + helper deps only).
  genGoCoreBlob(goCoreDir, proTag, true);

  // 2. Cross-compile each target into outBinDir.
  mkdirSync(outBinDir, { recursive: true });
  for (const t of goCoreTargets()) {
    compileGoTarget({
      goos: t.goos,
      goarch: t.goarch,
      out: join(outBinDir, t.out),
      buildArgs: [...proTag, '-trimpath', '-ldflags=-s -w'],
      cwd: goCoreDir,
      label: 'buildProModuleBinaries',
      target: `${t.goos}/${t.goarch}`,
      isDarwin: t.goos === 'darwin',
    });
  }

  // 3. Restore the community+Pro superset resting blob (so `go test -tags pro` works).
  genGoCoreBlob(goCoreDir, proTag, false);
}

/**
 * Host-target binary filename for the dev build. MUST equal
 * `coreBinaryName()` in src/api/snippet-client.ts evaluated for the current
 * platform — that's the file the runtime resolver spawns. The build-pipeline
 * test pins this equality so the two can't drift.
 */
export function devCoreOutName(os: string = process.platform, cpu: string = process.arch): string {
  const osPart = os === 'win32' ? 'win' : os; // 'win' | 'darwin'
  const ext = os === 'win32' ? '.exe' : '';
  return `editmamei-core-${osPart}-${cpu}${ext}`;
}

/** Where the dev build drops the host binary: <repo>/dist/bin/ (next to tsc's dist/). */
export function devCoreBinDir(): string {
  return join(REPO_ROOT, 'dist', 'bin');
}

/** Full path the dev build emits — must equal resolveCoreBinaryPath() at runtime. */
export function devCoreOutPath(): string {
  return join(devCoreBinDir(), devCoreOutName());
}

/**
 * Where the dev build drops the Pro module's OWN go-core binary:
 * <repo>/dist/modules/pro/bin/. A sibling tree to dist/bin so the in-tree dev
 * Pro module mirrors a downloaded module's layout (`<install>/bin/`). Must equal
 * resolveProBinaryPath() in src/api/snippet-client.ts so the composite client
 * spawns the right binary; the build-pipeline test pins the equality.
 */
export function devProBinDir(): string {
  return join(REPO_ROOT, 'dist', 'modules', 'pro', 'bin');
}

/** Full path the dev build emits for the Pro-only binary. */
export function devProCoreOutPath(): string {
  return join(devProBinDir(), devCoreOutName());
}

/** Regenerate go-core/templates.enc for the given tags + pro-only flag. */
function genGoCoreBlob(goCoreDir: string, tags: string[], proOnly: boolean): void {
  const args = ['run', ...tags, './cmd/buildtemplates', ...(proOnly ? ['-pro-only'] : [])];
  const gen = spawnSync('go', args, { cwd: goCoreDir, stdio: 'inherit' });
  if (gen.error || gen.status !== 0) {
    throw new Error(
      `buildGoCoreDev: template generation failed` +
        (gen.error ? ` (${gen.error.message})` : ` (exit ${gen.status})`)
    );
  }
}

/**
 * Build the dev go-core binaries for the HOST platform so `npm run build`
 * produces what the live MCP server (`node dist/index.js`) spawns. Two binaries,
 * one per module (the target "one go-core per module" topology):
 *
 *  - **CE host** (community-only blob, no tag) → `dist/bin/` — the host/community
 *    binary the CE tools + the Pro module's composite fallback spawn.
 *  - **Pro-only** (`-tags pro` + pro-only blob) → `dist/modules/pro/bin/` — the
 *    binary the Pro module's composite client spawns for its own snippets.
 *
 * Then it leaves `templates.enc` as the community+Pro superset so a subsequent
 * `go test -tags pro ./...` works without regenerating (and a no-tag binary, even
 * with that blob embedded, still can't emit Pro IP — it has no proBuild dispatch).
 *
 * Unlike the release `buildGoCore()` (fail-loud cross-compile of all targets),
 * the dev build is host-only (fast) and **warns instead of failing when the Go
 * toolchain is absent** — so test-only contributors and `npm install` aren't
 * blocked. Release builds keep the strict guarantee.
 */
export function buildGoCoreDev(): {
  built: boolean;
  proBuilt: boolean;
  hostBinaryPath: string;
  proBinaryPath: string;
} {
  const hostBinaryPath = devCoreOutPath();
  const proBinaryPath = devProCoreOutPath();
  const goCoreDir = join(REPO_ROOT, 'go-core');
  if (!existsSync(goCoreDir)) {
    throw new Error(`buildGoCoreDev: go-core/ not found at ${goCoreDir}`);
  }

  // Probe the toolchain first so a missing Go is a warning, not a stack trace.
  const probe = spawnSync('go', ['version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    console.error(
      `[buildGoCoreDev] WARN: Go toolchain not found on PATH — skipping dev core build. ` +
        `Photoshop edit tools will fail at runtime until you install Go and re-run ` +
        `\`npm run build\`, or set EDITMAMEI_CORE_BIN to a prebuilt binary.`
    );
    return { built: false, proBuilt: false, hostBinaryPath, proBinaryPath };
  }

  const proTag = ['-tags', 'pro'];

  // The Pro side only exists in the private monorepo. In the fair-source
  // public tree the `//go:build pro` files are absent by construction
  // (allowlist export), and `-tags pro` there would drop registry_nonpro.go
  // (`//go:build !pro`) with nothing left defining proBuild — an unbuildable
  // combination. Presence is DERIVED from the pro dispatch file (never an
  // edition flag) so this same script works unchanged in both trees.
  const proSidePresent = existsSync(join(goCoreDir, 'registry_pro.go'));

  // ORDERING IS LOAD-BEARING FOR THE IP BOUNDARY. Each `go build` embeds the
  // templates.enc on disk AT THAT MOMENT (//go:embed), so each blob generation
  // must immediately precede the build that consumes it. Do NOT hoist the blob
  // generations or parallelize the builds — that would embed the wrong blob
  // (e.g. the Pro-only/superset blob into the CE binary, leaking Pro JSX into a
  // binary a non-payer can `strings`). The no-tag CE generator also structurally
  // excludes proFragments, so step 1's blob is community-only by construction.

  // 1. CE host binary: community-only blob, no build tag → no Pro IP, no proBuild.
  genGoCoreBlob(goCoreDir, [], false);
  mkdirSync(dirname(hostBinaryPath), { recursive: true });
  compileGoTarget({
    out: hostBinaryPath,
    buildArgs: ['-trimpath', '-ldflags=-s -w'],
    cwd: goCoreDir,
    label: 'buildGoCoreDev',
    target: '(CE host)',
    isDarwin: process.platform === 'darwin',
  });

  if (proSidePresent) {
    // 2. Pro-only binary: pro-only blob + `-tags pro` → carries ONLY Pro JSX + helper deps.
    genGoCoreBlob(goCoreDir, proTag, true);
    mkdirSync(dirname(proBinaryPath), { recursive: true });
    compileGoTarget({
      out: proBinaryPath,
      buildArgs: [...proTag, '-trimpath', '-ldflags=-s -w'],
      cwd: goCoreDir,
      label: 'buildGoCoreDev',
      target: '(Pro)',
      isDarwin: process.platform === 'darwin',
    });

    // 3. Resting blob: community+Pro superset so `go test -tags pro ./...` passes
    //    without a manual regen. (templates.enc is gitignored, rebuilt per build.)
    genGoCoreBlob(goCoreDir, proTag, false);
  } else {
    console.error(
      '[buildGoCoreDev] no go-core/registry_pro.go found (public/CE tree?) — built the CE host binary only.'
    );
  }

  return { built: true, proBuilt: proSidePresent, hostBinaryPath, proBinaryPath };
}

function walk(dir: string, visit: (file: string) => void): void {
  // Sort entries deterministically (readdirSync order is filesystem-dependent
  // — NTFS vs APFS vs ext4 differ). Stable iteration makes SHA256SUMS line
  // ordering identical across hosts so the same source produces the same
  // checksum file byte-for-byte.
  const entries = readdirSync(dir).slice().sort();
  for (const entry of entries) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, visit);
    else visit(p);
  }
}

/**
 * The top-level build flow shared by build-ce.ts and build-pro.ts. Patches
 * the edition marker, compiles, copies distribution files, writes checksums,
 * and always restores the edition marker on the way out.
 *
 * `tag` is the log prefix (`build-ce` / `build-pro`) so the two scripts
 * keep their distinct stderr signatures.
 */
/**
 * Stage the local-vision ONNX models into `<destDistDir>/models/` — the sibling
 * of `dist/bin/` that the detection runtime resolves via `import.meta.url`. The
 * npm tarball / `.mcpb` both ship `dist/`, so the models ride along. Mirrors how
 * `buildGoCore` lands binaries in `dist/bin/`. Returns the count copied (0 when
 * `models/` is absent — a test-only checkout without the weights still builds).
 */
export function copyModels(destDistDir: string): number {
  const srcDir = join(REPO_ROOT, 'models');
  if (!existsSync(srcDir)) return 0;
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.onnx'));
  if (files.length === 0) return 0;
  const destDir = join(destDistDir, 'models');
  mkdirSync(destDir, { recursive: true });
  for (const f of files) copyFileSync(join(srcDir, f), join(destDir, f));
  return files.length;
}

/**
 * Stage the PRO-only local-vision models (`models/pro/*.onnx`) into
 * `<destDistDir>/models/pro/`. These weights are Pro IP and MUST NOT reach the
 * CE bundle — `copyModels` (the CE path) globs only the TOP level of `models/`,
 * so the `pro/` subdir is invisible to it. This is the deliberate complement:
 * call it ONLY for the dev postbuild (so `node dist/index.js` resolves the Pro
 * weight in dev) and the Pro module build — never for CE. The detection runtime
 * resolves these via `resolveModelPath('pro/<file>')`. Returns the count copied.
 */
export function copyProModels(destDistDir: string): number {
  const srcDir = join(REPO_ROOT, 'models', 'pro');
  if (!existsSync(srcDir)) return 0;
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.onnx'));
  if (files.length === 0) return 0;
  const destDir = join(destDistDir, 'models', 'pro');
  mkdirSync(destDir, { recursive: true });
  for (const f of files) copyFileSync(join(srcDir, f), join(destDir, f));
  return files.length;
}

export async function runBuild(edition: Edition, tag: string): Promise<void> {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const version = pkg.version as string;

  console.error(`[${tag}] target: ${packageDir(edition)}`);
  console.error(`[${tag}] version: ${version}`);

  const restoreEdition = patchEditionFile(edition);
  try {
    const jsCount = compileToPackageDir(edition);
    // Strip the orphan Pro files from the CE bundle (Pro is a downloaded module,
    // never statically linked, so the compiled Pro dist is unreferenced). No-op
    // for the Pro bundle.
    const pruned = pruneProFromCE(edition);
    console.error(
      `[${tag}] tsc OK — ${jsCount} .js files` + (pruned ? ` (pruned ${pruned} Pro path(s))` : '')
    );
  } finally {
    // We MUST always put src/edition.ts back to its committed 'dev' default —
    // otherwise the next build's patchEditionFile safety net refuses to start
    // with "previous build was interrupted."
    restoreEdition();
  }

  writePackageJson(edition, version);
  copyDistributionFiles(edition);
  // Build the editmamei skill bundle into <packageDir>/dist/skills/.
  // The npm tarball ships dist/, so the zip rides along; the install
  // CLI copies it from there into the user's Downloads folder.
  const skillZipPath = join(packageDir(edition), 'dist', 'skills', 'editmamei-skill.zip');
  buildSkillZip({ destPath: skillZipPath, silent: true });
  console.error(`[${tag}] wrote skill bundle: dist/skills/editmamei-skill.zip`);
  // Compile + bundle the sealed Go core for every target platform. Runs after
  // tsc cleaned/wrote dist/, so the binaries (in dist/bin/) survive; runs
  // before writeChecksums so they're covered by SHA256SUMS.
  buildGoCore(edition);
  console.error(
    `[${tag}] built editmamei-core binaries → dist/bin/ (${goCoreTargets().length} targets)`
  );
  // Stage the local-vision models into dist/models/ (before checksums cover them).
  const modelCount = copyModels(join(packageDir(edition), 'dist'));
  console.error(`[${tag}] copied ${modelCount} detection model(s) → dist/models/`);
  writeChecksums(edition);
  console.error(`[${tag}] wrote package.json, distribution files, SHA256SUMS`);
  console.error(`[${tag}] done.`);
}
