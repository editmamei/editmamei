import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countLayersRecursiveHelper,
  parentPathHelper,
  hoistFromActiveGroupHelper,
  getContextInfo,
  getSelectionInfo,
  restoreCompositeChannel,
  getMinimalContextInfo,
  selectionTypeHelpers,
  helperFunctions,
  normNameHelper,
  notFoundMessageHelper,
} from '@editmamei/api/extendscript/_helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * The go-core <-> TS ExtendScript helper mirror is
 * unguarded and hand-maintained. Every mirrored helper exists in TWO
 * hand-kept copies: a raw-string fragment in a go-core
 * `go-core/cmd/buildtemplates/fragments_*.go` file (keyed by a
 * `internal/vault/vault.go` const) and an exported TS string const in
 * `src/api/extendscript/_helpers.ts`. `vault.go`'s own doc comments claim
 * each pair is "Mirrored byte-for-byte (modulo whitespace/comments)" — but
 * nothing enforced that claim before this test. If the two copies drift,
 * the go-core tool path (every ps_ tool via snippetClient.build()) and the
 * TS/perception path (perception/*, detection/*, two Pro tools that still
 * import _helpers.ts directly) run different helper code for the same
 * logical operation.
 *
 * Pairs covered (all 10 mirrored string-const exports in _helpers.ts, all
 * confirmed sourced from fragments_context.go):
 *   - vault.LayerCountRecursive <-> countLayersRecursiveHelper (__countLayersRecursive)
 *   - vault.ParentPath          <-> parentPathHelper (__parentPathOf / __ppWalk)
 *   - vault.HoistGroup          <-> hoistFromActiveGroupHelper (__hoistFromActiveGroupIfNeeded)
 *   - vault.Ctx                 <-> getContextInfo
 *   - vault.GSI                 <-> getSelectionInfo
 *   - vault.RCC                 <-> restoreCompositeChannel
 *   - vault.MinCtx              <-> getMinimalContextInfo
 *   - vault.SelType             <-> selectionTypeHelpers
 *   - vault.HelperFns           <-> helperFunctions
 *   - vault.NormName            <-> normNameHelper
 *   - vault.NotFound            <-> notFoundMessageHelper (__notFoundMessage)
 *
 * `bitsPerChannelHelper` and `layerResolveHelpers` were deleted from
 * _helpers.ts (zero references anywhere in src/, tests/, scripts/ as of
 * 2026-07-29) — their go-core twins (vault.BitsPerCh, vault.LayerResolve)
 * are the live runtime copies and are go-core-only now, needing no TS
 * guard. `duplicateForOp` is a function (not a string const) and is
 * TS_ONLY-allowlisted below — see that block for why.
 *
 * All ten vault keys currently live in fragments_context.go (confirmed by
 * grepping go-core/cmd/buildtemplates for each key ahead of writing this
 * test) — if a future fragments_*.go split moves one, the loud extraction
 * failure below (not a silent vacuous pass) is what points at the fix.
 */

/**
 * Strips JS comments and collapses whitespace runs to a single space so the
 * go-core and TS copies can be compared "modulo whitespace/comments" — the
 * exact tolerance vault.go's own doc comments claim. Both sides run through
 * this SAME function so neither side gets a more lenient pass than the
 * other.
 */
function normalize(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/\/\/.*$/gm, '') // line comments
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts the raw-string body of a `vault.<Key>: \`...\`` map entry from a
 * go-core fragments_*.go source file. These fragments are static JS with no
 * `%s`-style fmt.Sprintf interpolation slots (confirmed by inspection —
 * none of the ten bodies contain a `%` character), so the extracted text is
 * the literal snippet body with no substitution to undo. Throws (rather
 * than returning an empty/undefined match) so a broken extraction fails
 * loudly instead of letting the guard vacuously pass.
 */
function extractGoCoreFragment(source: string, vaultKey: string, fileLabel: string): string {
  const re = new RegExp('vault\\.' + vaultKey + ':\\s*`([\\s\\S]*?)`');
  const match = source.match(re);
  if (!match) {
    throw new Error(
      `helpers-mirror-guard: could not find "vault.${vaultKey}: \`...\`" in ` +
        `${fileLabel}. Either the extraction regex needs updating, or the ` +
        `fragment moved to a different fragments_*.go file after a split — ` +
        `grep go-core/cmd/buildtemplates for "vault.${vaultKey}:" to relocate it.`
    );
  }
  return match[1];
}

const FRAGMENTS_CONTEXT_PATH = join(
  REPO_ROOT,
  'go-core',
  'cmd',
  'buildtemplates',
  'fragments_context.go'
);
const fragmentsContextSrc = readFileSync(FRAGMENTS_CONTEXT_PATH, 'utf8');

const pairs: {
  pairName: string;
  vaultKey: string;
  tsExportName: string;
  tsHelper: string;
  composedFromTs?: boolean;
}[] = [
  {
    pairName: 'LayerCountRecursive <-> countLayersRecursiveHelper',
    vaultKey: 'LayerCountRecursive',
    tsExportName: 'countLayersRecursiveHelper',
    tsHelper: countLayersRecursiveHelper,
  },
  {
    pairName: 'ParentPath <-> parentPathHelper',
    vaultKey: 'ParentPath',
    tsExportName: 'parentPathHelper',
    tsHelper: parentPathHelper,
  },
  {
    pairName: 'HoistGroup <-> hoistFromActiveGroupHelper',
    vaultKey: 'HoistGroup',
    tsExportName: 'hoistFromActiveGroupHelper',
    tsHelper: hoistFromActiveGroupHelper,
  },
  {
    pairName: 'RCC <-> restoreCompositeChannel',
    vaultKey: 'RCC',
    tsExportName: 'restoreCompositeChannel',
    tsHelper: restoreCompositeChannel,
  },
  {
    pairName: 'MinCtx <-> getMinimalContextInfo',
    vaultKey: 'MinCtx',
    tsExportName: 'getMinimalContextInfo',
    tsHelper: getMinimalContextInfo,
  },
  {
    pairName: 'SelType <-> selectionTypeHelpers',
    vaultKey: 'SelType',
    tsExportName: 'selectionTypeHelpers',
    tsHelper: selectionTypeHelpers,
  },
  {
    pairName: 'HelperFns <-> helperFunctions',
    vaultKey: 'HelperFns',
    tsExportName: 'helperFunctions',
    tsHelper: helperFunctions,
  },
  {
    pairName: 'NormName <-> normNameHelper',
    vaultKey: 'NormName',
    tsExportName: 'normNameHelper',
    tsHelper: normNameHelper,
  },
  {
    pairName: 'NotFound <-> notFoundMessageHelper',
    vaultKey: 'NotFound',
    tsExportName: 'notFoundMessageHelper',
    tsHelper: notFoundMessageHelper,
  },
  {
    // getContextInfo's TS export interpolates ${countLayersRecursiveHelper}
    // ahead of its own `function getContextInfo() {...}` body so every
    // consumer gets __countLayersRecursive in scope for free. The go-core
    // side composes that same dependency in separately at BUILD time (the
    // emitter prepends LayerCountRecursive ahead of Ctx — see vault.Ctx's
    // comment in fragments_context.go) rather than embedding it in the raw
    // string, so vault.Ctx is just the "own" function. That makes the TS
    // runtime string the (textual) SUPERSET of vault.Ctx — the containment
    // check below runs in the opposite direction from the other pairs.
    pairName: 'Ctx <-> getContextInfo',
    vaultKey: 'Ctx',
    tsExportName: 'getContextInfo',
    tsHelper: getContextInfo,
    composedFromTs: true,
  },
  {
    // Same composition shape as Ctx above: getSelectionInfo interpolates
    // ${restoreCompositeChannel} ahead of its own body; vault.GSI's own
    // comment says "WITHOUT the leading ${restoreCompositeChannel} — the Go
    // emitter prepends RCC". TS is the superset here too.
    pairName: 'GSI <-> getSelectionInfo',
    vaultKey: 'GSI',
    tsExportName: 'getSelectionInfo',
    tsHelper: getSelectionInfo,
    composedFromTs: true,
  },
];

describe('go-core <-> TS ExtendScript helper mirror guard (review debt B3)', () => {
  for (const { pairName, vaultKey, tsExportName, tsHelper, composedFromTs } of pairs) {
    // Anti-vacuous floor (1/2): the TS side must actually have content —
    // an accidentally-emptied export would otherwise make the toContain
    // assertion below pass trivially (an empty string is contained in
    // anything).
    it(`${pairName}: TS export "${tsExportName}" is non-empty`, () => {
      expect(
        tsHelper.trim().length,
        `${tsExportName} is empty — the mirror guard would vacuously pass ` +
          `against an empty needle. Check the export in _helpers.ts.`
      ).toBeGreaterThan(0);
    });

    // Anti-vacuous floor (2/2): the go-core side must actually be found —
    // extractGoCoreFragment throws (rather than matching an empty string)
    // when the key is missing, so this test also covers "grep found
    // nothing" failing loudly instead of silently.
    it(`${pairName}: go-core vault.${vaultKey} fragment was found`, () => {
      const goBody = extractGoCoreFragment(fragmentsContextSrc, vaultKey, 'fragments_context.go');
      expect(
        goBody.trim().length,
        `vault.${vaultKey} was matched but extracted an empty body.`
      ).toBeGreaterThan(0);
    });

    it(`${pairName}: normalized bodies match (modulo whitespace/comments)`, () => {
      const goBody = extractGoCoreFragment(fragmentsContextSrc, vaultKey, 'fragments_context.go');
      const normalizedGo = normalize(goBody);
      const normalizedTs = normalize(tsHelper);

      const driftMessage =
        `DRIFT DETECTED: go-core vault.${vaultKey} and TS ${tsExportName} have diverged.\n\n` +
        `--- normalized TS (${tsExportName}) ---\n${normalizedTs}\n\n` +
        `--- normalized go-core (vault.${vaultKey}) ---\n${normalizedGo}`;

      if (composedFromTs) {
        // TS interpolates a dependency helper ahead of its own body, so the
        // TS runtime string is the superset; vault.<Key> is just the "own"
        // function the go-core emitter composes in separately at build
        // time. Check that the (smaller) go-core body appears inside the
        // (larger) TS body.
        expect(normalizedTs, driftMessage).toContain(normalizedGo);
      } else {
        // toContain, not toBe: vault.go documents other fragments in this
        // same file being prepended with a bit more — so a go-core body
        // that wraps the mirrored function with additional surrounding
        // text is a legitimate shape, not drift. toContain tolerates that
        // wrapping without producing a false positive the way a
        // substring-of-empty-string toBe("") could. As observed while
        // writing this test, all of these pairs are in fact byte-identical
        // once normalized (no wrapping present today) — if that stays true
        // going forward, toBe would also pass; toContain is kept as the
        // standing check because it's the strictly weaker (safer against
        // false failures) of the two and matches vault.go's own "mirrored
        // ... modulo whitespace/comments" wording rather than an
        // exact-equality claim.
        expect(normalizedGo, driftMessage).toContain(normalizedTs);
      }
    });
  }
});

/**
 * Completeness guard — so the pair table above can never silently go stale.
 * Every top-level `export const` / `export function` in _helpers.ts must be
 * accounted for: either mirror-guarded above, or explicitly allowlisted
 * here with a reason. A new export that's neither breaks the "every export
 * accounted for" test below instead of quietly shipping unguarded.
 */
const TS_ONLY: { tsExportName: string; reason: string }[] = [
  {
    tsExportName: 'duplicateForOp',
    reason:
      'Function that returns one of two ExtendScript fragments (the ' +
      'opName + applyToActiveLayer branches), not a plain string const — ' +
      'the byte-comparison guard above only applies to string consts. A ' +
      'go-core twin DOES exist (vault.DupCopy / vault.DupActive, also in ' +
      'fragments_context.go) and was manually confirmed to match ' +
      "(modulo the Go %s slot standing in for TS's ${jsLit(opName)} " +
      'interpolation) while building this guard on 2026-07-29. Promote to ' +
      'a real guarded pair if the machinery above is ever extended to ' +
      'compare function-shaped fragments branch-by-branch.',
  },
];

describe('_helpers.ts export completeness (review debt B3 — never go stale)', () => {
  const HELPERS_PATH = join(REPO_ROOT, 'src', 'api', 'extendscript', '_helpers.ts');
  const helpersSrc = readFileSync(HELPERS_PATH, 'utf8');

  function extractExportNames(source: string): string[] {
    const re = /^export (?:const|function) (\w+)/gm;
    const names: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      names.push(match[1]);
    }
    return names;
  }

  const exportNames = extractExportNames(helpersSrc);
  const guardedNames = new Set(pairs.map((p) => p.tsExportName));
  const allowlistedNames = new Set(TS_ONLY.map((t) => t.tsExportName));

  // Anti-vacuous floor: the extraction regex must actually find something,
  // or the "every export is accounted for" test below would pass
  // vacuously against an empty list.
  it('extraction regex finds at least one export in _helpers.ts', () => {
    expect(exportNames.length).toBeGreaterThan(0);
  });

  it('every export in _helpers.ts is either mirror-guarded or explicitly TS_ONLY-allowlisted', () => {
    const unaccounted = exportNames.filter(
      (name) => !guardedNames.has(name) && !allowlistedNames.has(name)
    );
    expect(
      unaccounted,
      `New/renamed export(s) in _helpers.ts with no mirror-guard coverage and no ` +
        `TS_ONLY allowlist reason: ${unaccounted.join(', ')}. Either add a pair to the ` +
        `"pairs" table above (if it has a go-core twin) or add it to TS_ONLY with a ` +
        `one-line reason (if it's TS-only — e.g. no go-core mirror, or not a plain ` +
        `string const).`
    ).toEqual([]);
  });

  it('every guarded/allowlisted name still exists as a real export in _helpers.ts (no stale entries)', () => {
    const exportSet = new Set(exportNames);
    const stale = [...guardedNames, ...allowlistedNames].filter((name) => !exportSet.has(name));
    expect(
      stale,
      `The pair table / TS_ONLY allowlist references export(s) that no longer exist in ` +
        `_helpers.ts: ${stale.join(', ')}. Remove the stale entry.`
    ).toEqual([]);
  });
});
