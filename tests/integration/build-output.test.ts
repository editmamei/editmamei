/**
 * Build-output regression test.
 *
 * Pins the build-output invariants: the CE bundle must NOT contain Pro source
 * (the Pro module is pruned from CE dist after compile);
 * bundles must not ship source maps or .d.ts files; the lockfile must be
 * committed; tsconfig.build.json must keep its IP-protection flags set.
 *
 * The bundle assertions inspect pre-built artifacts in
 * `packages/{ce,pro}/dist/` — they do not run the build itself. CI must
 * run `npm run build:ce && npm run build:pro` before the test suite.
 * Local dev that skips the build sees skipped tests rather than spurious
 * failures (the bundles-built guard at the top of the file). The repo-
 * config assertions (lockfile, tsconfig.build.json, stub restoration)
 * always run since they don't need a build.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { toolsInTier } from '@editmamei/core/tool-tiers.ts';
import { packageFilesList } from '../../scripts/lib/build-common.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const CE_PKG_DIR = join(REPO_ROOT, 'packages', 'ce');
const CE_DIST = join(CE_PKG_DIR, 'dist');
const PRO_DIST = join(REPO_ROOT, 'packages', 'pro', 'dist');
// Source of truth: derived from tool-tiers.ts. Pre-2026-06-10 this was a
// hand-maintained list of 6 names — and only covered the tools that
// happened to live in stubbed files. New Pro tools added to shared files
// (the 9 that were flagged) slipped through silently. Deriving the
// list closes that drift class structurally.
const PRO_TOOL_NAMES = toolsInTier('pro');

// Pro tool sources aren't part of every checkout of this repo (Pro ships as
// a separate module) — the derivation below legitimately yields zero
// *-pro.ts files there. Use the presence of the Pro module's own entrypoint
// as the signal for "this checkout actually has Pro source to derive from."
const PRO_SOURCES_PRESENT = existsSync(join(REPO_ROOT, 'src', 'modules', 'pro', 'index.ts'));
const proIt = PRO_SOURCES_PRESENT ? it : it.skip;

// The expected prune set, DERIVED from disk: every
// `src/tools/*-pro.ts` — the source side of the same glob
// `pruneProFromCE` runs against dist at build time. A new *-pro.ts file joins
// the prune AND these assertions automatically; there is no hand list left to
// forget (the derived-list invariant). The old literal lists here went
// stale in lockstep with CE_PRUNE_PATHS — five 2026-07-04 files missing from
// both, four older ones pruned but never asserted.
const PRO_SRC_FILES = readdirSync(join(REPO_ROOT, 'src', 'tools')).filter((f) =>
  f.endsWith('-pro.ts')
);
if (PRO_SOURCES_PRESENT && PRO_SRC_FILES.length === 0) {
  // Mirror the prune's zero-file guard: an empty derivation would turn every
  // assertion below into a vacuous pass.
  throw new Error(
    'build-output.test.ts derived zero src/tools/*-pro.ts files — the derivation glob is broken'
  );
}
const PRO_TOOL_FILES = PRO_SRC_FILES.map((f) => `tools/${f.replace(/\.ts$/, '.js')}`);

// preview-tools-pro is intentionally an EMPTY factory post-v0.7.2 — its only
// tool (get_histogram, always 'community' in tool-tiers.ts) moved to CE
// preview-tools.ts; the stub stays so the proFactories array keeps its shape.
// It is still pruned from CE like every *-pro file, but exempt from the
// "real implementation" checks below, which would false-positive on the
// empty-but-intentional state (~70-byte compiled stub).
const INTENTIONALLY_EMPTY_PRO_FILES = new Set(['tools/preview-tools-pro.js']);
const PRO_REAL_IMPL_FILES = PRO_TOOL_FILES.filter((f) => !INTENTIONALLY_EMPTY_PRO_FILES.has(f));

// Same derivation for the src-intact guard (gutted-file detection).
const PRO_SOURCE_FILES = PRO_SRC_FILES.filter((f) => f !== 'preview-tools-pro.ts').map(
  (f) => `src/tools/${f}`
);

/** Walk a directory and return every file path relative to root. */
async function walk(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walk(root, rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

const bundlesBuilt = existsSync(CE_DIST) && existsSync(PRO_DIST);

describe.skipIf(!bundlesBuilt)('CE bundle composition', () => {
  // -------------------------------------------------------------------------
  // Slice 3d-3c: Pro is a DOWNLOADED module loaded via dynamic import, never
  // statically linked. The CE build compiles everything, then `pruneProFromCE`
  // (scripts/lib/build-common.ts) DELETES the orphan Pro files. The CE bundle
  // must contain neither the Pro module dir nor any Pro tool file — a stronger
  // guarantee than the old "tiny stub" model (the source isn't there at all).
  // -------------------------------------------------------------------------
  it('the Pro module, Pro tool files, and Pro template support are pruned from the CE bundle', () => {
    expect(existsSync(join(CE_DIST, 'modules', 'pro')), 'modules/pro must be pruned from CE').toBe(
      false
    );
    for (const file of PRO_TOOL_FILES) {
      expect(existsSync(join(CE_DIST, file)), `${file} must be pruned from CE`).toBe(false);
    }
    // The whole templates/ dir is Pro-only support (signature DSL, lint, doctrine)
    // imported only by template-tools-pro — it must not ship in CE.
    expect(existsSync(join(CE_DIST, 'templates')), 'templates/ must be pruned from CE').toBe(false);
  });

  // ===========================================================================
  // Tree-wide Pro-tier absent-from-CE assertion
  //
  // The per-stub-file check above proves the stub mechanism itself didn't
  // leak; THIS test proves no compiled .js file in the CE bundle's tree
  // (regardless of which source it came from) contains a Pro tool name as
  // a string literal. The pre-2026-06-10 build had 9 Pro tools living in
  // shared CE source files (action-tools.ts, layer-transform-tools.ts,
  // retouch-tools.ts) whose implementations DID compile into CE dist.
  // The runtime tier filter dropped them at registration, but their
  // identifier strings were trivially recoverable from a local install.
  //
  // The 2026-06-10 fix moved those tools into *-pro.ts files; this
  // assertion is what fails next time someone adds a Pro tool to a
  // shared file (forces them to use the stub mechanism).
  //
  // Scope note: this check covers Pro-tier names. Dev-tier names are
  // explicitly NOT enforced — the obfuscation layered defense is
  // deferred, and dev tools are gated only at runtime
  // by tool-tiers.ts. The Pro tier needs the build-time guarantee
  // because shipping Pro source for free defeats the licensing moat;
  // dev tools shipping in CE dist is accepted risk for now.
  // ===========================================================================
  it('no Pro tool name appears as a string literal anywhere in CE dist .js (tree-wide)', async () => {
    const files = await walk(CE_DIST);
    const jsFiles = files.filter((f) => f.endsWith('.js'));
    // Skip files that legitimately carry Pro tool name strings as metadata
    // (not as registered-tool implementation):
    //
    //  - `core/tool-tiers.js` — the TOOL_TIERS classification dictionary
    //    has every name (community + pro + dev + none) as a key. That's
    //    how tier classification works at runtime.
    //
    //  - `spec/**/*.js` — the AmEventSpec library cross-references each
    //    Pro tool by name in the `emittedBy: [...]` metadata field so the
    //    descriptor-vs-snippet tests can map specs back to their consumers.
    //    Specs are static data shipped to both editions (they're audit /
    //    documentation infrastructure), and dropping them from CE would
    //    weaken the runtime spec lookup. The reference is harmless — it
    //    doesn't register a tool or carry an implementation.
    //  - `tools/scene-tools.js` — the CE Scene tools (ps_read_scene /
    //    select_by_reference) reference the Pro tool names
    //    `ps_select_subject_instance` and `ps_select_face_feature`
    //    as host.invokeTool DELEGATION targets: when the host is Pro-entitled the
    //    CE Scene flow routes through those Pro tools, else it uses a CE fallback
    //    (the CE-loads-Pro-module broker pattern, scene-model-v2). Those are name
    //    strings for runtime delegation, NOT Pro implementation — the Pro source
    //    stays in the pruned `*-pro.js` files. Harmless, like the metadata refs above.
    //  - `core/server.js` — the raw-develop advisory tracker names
    //    `ps_apply_camera_raw` twice: a `this.toolRegistry.get(...)` existence
    //    check (is a camera-raw develop tool registered in this session?) and a
    //    `name === ...` check on the tool that just ran. Both read the live
    //    registry to decide whether to set or clear the pending flag — runtime
    //    delegation / entitlement checks, not Pro implementation. Same
    //    reference-not-implementation rationale as scene-tools above.
    //  - `perception/grounding-locate.js` + `tools/{brush,image,layer-transform,
    //    selection,shape}-tools.js` — these CE-shipped files carry
    //    `'ps_resolve_placement'` in their `placement`-param DESCRIPTIONS: a
    //    delegation/vocabulary REFERENCE, not an implementation. The locator
    //    (2026-07-07): the locator TOOL is Pro (its factory lives in the pruned
    //    grounding-tools-pro.js), but the grounding ENGINE stays CE-host-shipped so
    //    the community tools keep their placement params. Same delegation-not-impl
    //    rationale as scene-tools above.
    const isIgnored = (rel: string) => {
      const norm = rel.replace(/\\/g, '/');
      return (
        norm === 'core/tool-tiers.js' ||
        norm === 'core/tool-groups.js' ||
        norm === 'tools/scene-tools.js' ||
        // ps_apply_camera_raw registry/dispatch check, not implementation (see above).
        norm === 'core/server.js' ||
        // ps_resolve_placement reference-not-implementation (see above).
        norm === 'perception/grounding-locate.js' ||
        norm === 'tools/brush-tools.js' ||
        norm === 'tools/image-tools.js' ||
        norm === 'tools/layer-transform-tools.js' ||
        norm === 'tools/selection-tools.js' ||
        norm === 'tools/shape-tools.js' ||
        norm.startsWith('spec/')
      );
    };
    const leaks: Array<{ file: string; tool: string }> = [];
    for (const rel of jsFiles) {
      if (isIgnored(rel)) continue;
      const contents = readFileSync(join(CE_DIST, rel), 'utf8');
      for (const name of PRO_TOOL_NAMES) {
        if (contents.includes(`'${name}'`) || contents.includes(`"${name}"`)) {
          leaks.push({ file: rel, tool: name });
        }
      }
    }
    expect(
      leaks,
      'Pro tool name string literals leaked into CE dist:\n' +
        leaks.map((l) => `  ${l.file}: ${l.tool}`).join('\n')
    ).toEqual([]);
  });

  it('no *-pro.js file exists anywhere in CE dist (belt to the tree-wide name scan)', async () => {
    // The tree-wide scan above matches pro-TIER names only — a dev-tier
    // implementation living in a *-pro.js file (the five
    // 2026-07-04 files were all dev-tier) slips it entirely. Simpler, blunter
    // invariant: the CE bundle contains no file matching the pattern, period.
    const files = await walk(CE_DIST);
    const leaked = files.filter((f) => /-pro\.js$/.test(f.replace(/\\/g, '/')));
    expect(leaked, 'files matching *-pro.js leaked into CE dist').toEqual([]);
  });

  it('source maps are NOT shipped in the CE bundle', async () => {
    // tsconfig.build.json sets sourceMap: false, declaration: false,
    // declarationMap: false. The shipped CE bundle should have no .map
    // files (which would carry sourcesContent and leak the original TS),
    // no .d.ts files (dead weight for a CLI consumer), and no .d.ts.map.
    const files = await walk(CE_DIST);
    const maps = files.filter((f) => f.endsWith('.map'));
    const declarations = files.filter((f) => f.endsWith('.d.ts'));
    expect(maps, 'CE bundle should ship no .map files').toEqual([]);
    expect(declarations, 'CE bundle should ship no .d.ts files').toEqual([]);
  });

  it('CE bundle ships fewer .js files than Pro (CE prunes the Pro module + tool source)', async () => {
    const ceFiles = await walk(CE_DIST);
    const proFiles = await walk(PRO_DIST);
    const ceJs = ceFiles.filter((f) => f.endsWith('.js'));
    const proJs = proFiles.filter((f) => f.endsWith('.js'));
    // CE prunes modules/pro + the derived tools/*-pro.js set, so it carries
    // strictly fewer .js files than the (un-pruned) Pro bundle.
    expect(ceJs.length).toBeLessThan(proJs.length);
  });
});

// -----------------------------------------------------------------------
// The published npm tarball and .mcpb bundle previously shipped with NO
// license file: copyDistributionFiles (scripts/lib/build-common.ts) copied
// from a root file literally named `LICENSE`, but the repo's file is
// `LICENSE.md` — existsSync silently skipped the mismatch and the build
// "succeeded" with a package missing its license. copyDistributionFiles now
// throws on a missing root doc instead of skipping it; these assertions
// pin the resulting artifact so the gap can't reopen silently.
// -----------------------------------------------------------------------
// Does NOT need a prebuilt bundle — packageFilesList() is the same pure
// function writePackageJson() calls, so this exercises the manifest-
// generation logic directly and runs under plain `npm test`. Pins the
// edition split from the LICENSE/LICENSE.md mixup: a Pro build must ship
// the commercial EULA (`LICENSE`), never the FSL text (`LICENSE.md`), and
// vice versa for CE.
describe('package.json files[] — edition-conditional license entry', () => {
  it("community edition's files[] lists LICENSE.md", () => {
    expect(packageFilesList('community')).toContain('LICENSE.md');
  });

  it("pro edition's files[] lists LICENSE, not LICENSE.md", () => {
    const files = packageFilesList('pro');
    expect(files).toContain('LICENSE');
    expect(files).not.toContain('LICENSE.md');
  });
});

describe.skipIf(!bundlesBuilt)('CE package legal docs', () => {
  it('LICENSE.md is copied into the CE package directory', () => {
    expect(
      existsSync(join(CE_PKG_DIR, 'LICENSE.md')),
      'packages/ce/LICENSE.md is missing — the published npm tarball and .mcpb bundle would ship with no license file'
    ).toBe(true);
  });

  it('LICENSE.md content is the actual FSL text, not an empty or wrong file', () => {
    const content = readFileSync(join(CE_PKG_DIR, 'LICENSE.md'), 'utf8');
    expect(
      content,
      'packages/ce/LICENSE.md does not contain "Functional Source License" — an empty or wrong file would still pass the existsSync check above'
    ).toContain('Functional Source License');
  });

  it('the CE package.json files array lists LICENSE.md', () => {
    const pkg = JSON.parse(readFileSync(join(CE_PKG_DIR, 'package.json'), 'utf8'));
    expect(
      pkg.files,
      'packages/ce/package.json files[] must include LICENSE.md so npm actually ships it'
    ).toContain('LICENSE.md');
  });
});

describe.skipIf(!bundlesBuilt)('Pro bundle composition', () => {
  it('Pro tools-pro files contain the real implementations', () => {
    for (const file of PRO_REAL_IMPL_FILES) {
      const path = join(PRO_DIST, file);
      expect(existsSync(path)).toBe(true);
      const size = statSync(path).size;
      // Pro implementations are 3-15 KB. Anything under 500 bytes means
      // the build accidentally produced a stub.
      expect(size, `${file} should be the real Pro impl but is ${size} bytes`).toBeGreaterThan(500);
    }
  });

  it('Pro tool names appear in their respective Pro implementation files', () => {
    // The whole template surface is Pro, so
    // template-tools-pro.js carries all 7 template tools. layer-transform and
    // retouch became community-tier — their files are no longer *-pro.js and
    // ship in both editions, so they're not asserted here.
    const expectedInFile: Record<string, string[]> = {
      // selection-tools-pro.js is GONE (Sensei select_subject/select_sky
      // moved to community selection-tools.ts); camera-raw-tools-pro.js now ships as a
      // Pro file (apply_camera_raw promoted to pro).
      'tools/camera-raw-tools-pro.js': ['ps_apply_camera_raw'],
      'tools/template-tools-pro.js': [
        'ps_template_create_evidence',
        'ps_template_save',
        'ps_template_delete',
        'ps_template_list',
        'ps_template_apply',
        'ps_template_verify',
        'ps_template_recall',
      ],
      'tools/action-tools-pro.js': ['ps_list_actions', 'ps_play_action', 'ps_execute_script'],
    };
    for (const [file, names] of Object.entries(expectedInFile)) {
      const contents = readFileSync(join(PRO_DIST, file), 'utf8');
      for (const name of names) {
        expect(contents.includes(name), `Pro ${file} missing tool name ${name}`).toBe(true);
      }
    }
  });

  // ===========================================================================
  // Pro build produces a tarball + its SHA256 lands
  // in SHA256SUMS so downstream signing has a single source of truth for
  // "what file actually shipped to R2."
  // ===========================================================================
  it('Pro build produces a .tgz tarball next to dist/', () => {
    const proDir = join(REPO_ROOT, 'packages', 'pro');
    // Match any editmamei-<version>.tgz — don't pin the version so the
    // assertion survives package.json bumps (the pre-2026-06-04 form
    // hardcoded 'editmamei-0.2.0.tgz' and silently rotted).
    const tarballs = readdirSync(proDir).filter((f) => /^editmamei-.+\.tgz$/.test(f));
    expect(tarballs.length, `expected at least one editmamei-*.tgz in ${proDir}`).toBeGreaterThan(
      0
    );
  });

  it('SHA256SUMS includes the tarball entry alongside the dist/ entries', () => {
    const sumsPath = join(REPO_ROOT, 'packages', 'pro', 'SHA256SUMS');
    expect(existsSync(sumsPath)).toBe(true);
    const sums = readFileSync(sumsPath, 'utf8');
    // A line ending in `<sp><sp>editmamei-<version>.tgz` proves the
    // tarball was hashed and appended. We don't pin the version
    // (would couple test to package.json) — just that some .tgz hash
    // line is present.
    expect(sums).toMatch(/^[0-9a-f]{64}\s\s.+\.tgz$/m);
  });
});

describe.skipIf(!bundlesBuilt)('Bundle parity diagnostics', () => {
  it('CE is a strict subset of Pro — everything CE lacks is pruned Pro module/tool source', async () => {
    const ceFiles = new Set((await walk(CE_DIST)).filter((f) => f.endsWith('.js')));
    const proFiles = new Set((await walk(PRO_DIST)).filter((f) => f.endsWith('.js')));
    const onlyInCe = [...ceFiles].filter((f) => !proFiles.has(f));
    const onlyInPro = [...proFiles].filter((f) => !ceFiles.has(f));
    // CE adds nothing Pro lacks.
    expect(onlyInCe).toEqual([]);
    // Every file Pro has and CE doesn't is a pruned Pro path: the Pro module dir,
    // a Pro tool file, or the Pro-only templates/ support dir.
    const unexpected = onlyInPro.filter((f) => {
      const norm = f.replace(/\\/g, '/');
      return !(
        norm.startsWith('modules/pro/') ||
        norm.startsWith('templates/') ||
        /tools\/[a-z-]+-pro\.js$/.test(norm)
      );
    });
    expect(unexpected, `unexpected Pro-only files (not the pruned Pro surface)`).toEqual([]);
  });
});

// These assertions don't need built bundles — they verify repo-config state
// that should hold regardless of whether you've run the build. Run always.

describe('Repo-config invariants for the build pipeline', () => {
  // -----------------------------------------------------------------------
  // package-lock.json must be committed for `npm ci`
  // in CI and for npm provenance / reproducible builds. Was previously
  // gitignored; T07 P1 flagged the removal. Test pins the new state so
  // it cannot regress silently.
  // -----------------------------------------------------------------------
  it('package-lock.json is committed (required for npm ci + provenance)', () => {
    expect(existsSync(join(REPO_ROOT, 'package-lock.json'))).toBe(true);
  });

  it('.gitignore does NOT re-ignore package-lock.json', () => {
    const ignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    // Match the exact line (not buried inside a comment). The lockfile must
    // not appear as a top-level ignore pattern.
    const lines = ignore
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(lines).not.toContain('package-lock.json');
  });

  // -----------------------------------------------------------------------
  // tsconfig.build.json keeps the IP-protection flags
  // set. If any of these flips, the next CE/Pro build will start shipping
  // source maps / .d.ts files / inline TypeScript content.
  // -----------------------------------------------------------------------
  it('tsconfig.build.json has all IP-protection flags set', () => {
    const path = join(REPO_ROOT, 'tsconfig.build.json');
    expect(existsSync(path)).toBe(true);
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    expect(cfg.extends).toBe('./tsconfig.json');
    const opts = cfg.compilerOptions;
    expect(opts.sourceMap, 'sourceMap must be false').toBe(false);
    expect(opts.inlineSourceMap, 'inlineSourceMap must be false').toBe(false);
    expect(opts.inlineSources, 'inlineSources must be false').toBe(false);
    expect(opts.declaration, 'declaration must be false').toBe(false);
    expect(opts.declarationMap, 'declarationMap must be false').toBe(false);
    expect(opts.removeComments, 'removeComments must be true').toBe(true);
    expect(opts.stripInternal, 'stripInternal must be true').toBe(true);

    // Go-sidecar seal (v0.11.5): the AM spec library must be excluded from
    // the shipped build so the descriptor IP ships only in the encrypted
    // go-core binary, never as plaintext JS. If a future edit drops this,
    // the next CE/Pro build starts leaking the catalog again. (The legacy
    // TS ExtendScript twin this comment used to also cover — the snippet
    // assembler + its category files — was deleted outright in the
    // 2026-07-28 twin retirement; nothing left there to seal.)
    const excluded: string[] = cfg.exclude ?? [];
    expect(
      excluded,
      'tsconfig.build.json must exclude src/spec (AM Event Library / descriptor maps) from the shipped bundle'
    ).toContain('src/spec');
    // _helpers.ts is deliberately KEPT (generic helpers, imported by shipped
    // preview-tools) — guard against it being sealed by mistake.
    expect(excluded).not.toContain('src/api/extendscript/_helpers.ts');
  });

  // -----------------------------------------------------------------------
  // Pro source intact. Slice 3d-3c removed the pre-tsc stub-swap (the CE build
  // now prunes the compiled Pro dist instead), so the src/tools/*-pro.ts files
  // are NEVER mutated by a build — they always hold the real implementations.
  // This guard still earns its keep: it catches a Pro file being accidentally
  // gutted/emptied, independent of any build run.
  // -----------------------------------------------------------------------
  proIt('src/tools/*-pro.ts files contain the real Pro implementations', () => {
    // Every real Pro implementation registers at least one 'ps_*' tool.
    const REAL_MARKER = 'ps_';
    for (const rel of PRO_SOURCE_FILES) {
      const path = join(REPO_ROOT, rel);
      expect(existsSync(path), `expected Pro source at ${rel}`).toBe(true);
      const contents = readFileSync(path, 'utf8');
      expect(
        contents.includes(REAL_MARKER),
        `${rel} is missing the real-implementation marker — did the file get gutted?`
      ).toBe(true);
    }
  });
});
