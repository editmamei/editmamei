import { describe, it, expect } from 'vitest';
import {
  getContextInfo,
  getMinimalContextInfo,
  restoreCompositeChannel,
  parentPathHelper,
  hoistFromActiveGroupHelper,
  countLayersRecursiveHelper,
  notFoundMessageHelper,
} from '@editmamei/api/extendscript/_helpers.ts';
import { classifyError } from '@editmamei/utils/session-log.ts';

// ===========================================================================
// This file preserves the direct-constant coverage of _helpers.ts ahead of
// retiring the legacy TS ExtendScript twin (src/api/extendscript.ts + its
// category files under src/api/extendscript/). _helpers.ts is the ONE file
// in that directory with real runtime consumers (perception/*, detection/*,
// two Pro tools) — everything else in the twin is test-only dead code whose
// coverage moved to go-core/golden_test.go and tests/spec/*.
//
// Moved verbatim from tests/unit/extendscript.test.ts (S1b, 2026-07-28).
// Only `it`s that assert directly on one of the six helper constants below
// were kept; `it`s that built a snippet via ExtendScriptSnippets.X(...) to
// exercise a helper indirectly were dropped along with the twin they
// depend on.
// ===========================================================================

// ===========================================================================
// T05 P1-4 — getContextInfo body must be wrapped in try/catch
// so a destructive op that succeeded but raised an error during the
// context probe (doc closed mid-call, active layer gone, etc.) does
// not get marked failed at the caller side. Pin the contract in the
// ExtendScript snippet text so a future refactor cannot drop the
// try/catch silently.
// ===========================================================================
describe('getContextInfo (T05 P1-4 contract)', () => {
  it('wraps the whole body in a top-level try/catch', () => {
    // Whole-body wrap, not just inner `try { bounds }` blocks.
    // Match the outer "try {" that opens the function body and the
    // matching catch(e) that returns the degraded shape.
    expect(getContextInfo).toMatch(/function getContextInfo\(\)\s*\{\s*\/\/[\s\S]*?try\s*\{/);
    expect(getContextInfo).toMatch(/\}\s*catch\s*\(\s*e\s*\)\s*\{/);
  });

  it('degraded return surfaces error_reading and hasDocument:false', () => {
    // The catch arm returns { hasDocument: false, error_reading: <msg> }
    // so downstream callers can distinguish "no doc" from "probe failed".
    expect(getContextInfo).toContain('error_reading');
    expect(getContextInfo).toContain('hasDocument: false');
  });
});

// ===========================================================================
// Fix 5 (Phase 2, 2026-07) — B3(a) effective-vs-own visibility conflation.
//
// `layer.visible` on the ExtendScript DOM reflects EFFECTIVE visibility
// (parent-chain AND own flag) NO MATTER which proxy resolves it — a layer
// inside a hidden group reports `visible: false` from every DOM proxy,
// including one re-resolved via a fresh doc.layers walk. (The first cut of
// this fix assumed a getLayerTree-style walk would recover the own flag;
// live verification against a real hidden-group/child pair disproved that
// — the DOM simply cannot express the own flag once EffectiveVisible is
// computed. Corrected below.) The own flag is only readable via Action
// Manager's Vsbl property, keyed by the layer's stable id (`putIdentifier`,
// not `putName` — names aren't unique). getContextInfo now reads the own
// flag via AM for `visible`, and exposes the DOM (effective) reading
// separately as `effectively_visible`, falling back to the DOM value if
// the AM read throws.
// ===========================================================================
describe('getContextInfo (Fix 5 — own vs effective visibility)', () => {
  it('activeLayer.visible is populated from the AM own-flag read, not doc.activeLayer.visible directly', () => {
    expect(getContextInfo).toContain('visible: __ownVisible');
    expect(getContextInfo).not.toContain('visible: layer.visible');
  });

  it('exposes effectively_visible as the raw doc.activeLayer (DOM) reading', () => {
    expect(getContextInfo).toContain('effectively_visible: __effectiveVisible');
    expect(getContextInfo).toContain('var __effectiveVisible = layer.visible;');
  });

  it('reads the own flag via Action Manager Vsbl, keyed by the layer id (not name)', () => {
    expect(getContextInfo).toContain(
      "putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('Vsbl'))"
    );
    expect(getContextInfo).toContain("putIdentifier(app.charIDToTypeID('Lyr '), layer.id)");
    expect(getContextInfo).toContain("getBoolean(app.charIDToTypeID('Vsbl'))");
    // (Checks the actual call, not the bare word — the explanatory
    // comment above the AM read legitimately mentions "not putName".)
    expect(getContextInfo).not.toContain('.putName(');
  });

  // The regression this guards against: re-deriving __ownVisible from ANY
  // DOM `.visible` read (directly, or via a re-resolved/walked proxy) is
  // the exact bug the live-verification round caught — the DOM cannot
  // express the own flag once a layer's effective visibility is false.
  //
  // The blanket "getContextInfo never contains instanceof LayerSet"
  // assertion this test used to carry was retired 2026-07 (Phase 4,
  // layer-placement-bug fix): getContextInfo now legitimately bundles
  // countLayersRecursiveHelper's __countLayersRecursive (prepended, same
  // pattern as restoreCompositeChannel + getSelectionInfo), which uses
  // `instanceof LayerSet` to recurse into groups for a real total layer
  // count — entirely unrelated to own-vs-effective visibility. The regex
  // below is the precise guard for the actual regression class (own-flag
  // derivation from a .visible read) and doesn't false-positive on that.
  it('does NOT derive the own flag from a DOM .visible read anywhere', () => {
    expect(getContextInfo).not.toMatch(/__ownVisible = [^;]*\.visible/);
  });

  it('the AM own-flag read is best-effort — a failure degrades to the effective value, not a throw', () => {
    // Sits inside its own try/catch that swallows to a no-op, so an AM
    // read failure can't turn a successful destructive op into a
    // reported failure (same philosophy as the outer try/catch).
    expect(getContextInfo).toMatch(
      /try\s*\{\s*var __visRef[\s\S]*?\}\s*catch\s*\(\s*eOwn\s*\)\s*\{\s*\}/
    );
  });
});

// ===========================================================================
// 2026-06-06 — getMinimalContextInfo helper for EXEMPT-list tools.
//
// Property setters + pure filters don't change *what's active*, so
// re-emitting the full ~300-token getContextInfo() payload on every
// call bloats LLM context. The minimal helper returns only document_name
// and activeLayer_name — enough for the LLM to confirm the editor is
// still pointing at the expected thing, with none of the duplicate
// bounds / opacity / blend mode / kind / lock state / isBackground /
// doc dims / mode / layerCount / hasSelection that's already known.
//
// The full-tool demo (2026-06-06, 108 calls) showed LLM-thinking time
// hitting 70+ minutes for ~1.5 minutes of actual tool work — context
// bloat dominated. This helper is the highest-impact lever.
// ===========================================================================
describe('getMinimalContextInfo (2026-06-06 — EXEMPT-list context trim)', () => {
  it('returns hasDocument + document_name + activeLayer_name (and nothing else expensive)', () => {
    expect(getMinimalContextInfo).toContain('function getMinimalContextInfo');
    expect(getMinimalContextInfo).toContain('hasDocument: true');
    expect(getMinimalContextInfo).toContain('document_name: doc.name');
    expect(getMinimalContextInfo).toContain('activeLayer_name: layerName');
    // The expensive fields from the full helper must NOT appear here.
    // Each one represents a payload-cost item we explicitly skipped.
    expect(getMinimalContextInfo).not.toContain('bounds');
    expect(getMinimalContextInfo).not.toContain('opacity');
    expect(getMinimalContextInfo).not.toContain('blendMode');
    expect(getMinimalContextInfo).not.toContain('layerCount');
    expect(getMinimalContextInfo).not.toContain('hasSelection');
  });

  it('wraps in try/catch with degraded shape (same contract as getContextInfo)', () => {
    // Same degradation contract: a context probe failure must not mark
    // the surrounding tool call failed.
    expect(getMinimalContextInfo).toMatch(/try\s*\{[\s\S]*\}\s*catch\s*\(\s*e\s*\)\s*\{/);
    expect(getMinimalContextInfo).toContain('error_reading');
    expect(getMinimalContextInfo).toContain('hasDocument: false');
  });
});

// ===========================================================================
// 2026-06-07 hotfix — restoreCompositeChannel helper (direct unit test).
//
// The original create_layer_mask "command 'Make' not currently available"
// failure traced back to TWO snippets calling doc.channels.add() without
// restoring composite afterward: get_selection_preview AND getSelectionInfo
// (which is inlined as the return value of every selection tool — select_
// subject / sky / rectangle / magic_wand / color_range / feather / etc.).
// The helper is the single source of truth for the restoration sequence;
// pin its shape here so a future refactor of the body can't silently lose
// a doc-mode case or break the try/catch contract.
// ===========================================================================
describe('restoreCompositeChannel (2026-06-07 hotfix)', () => {
  it('defines a function wrapped in try/catch with an empty catch', () => {
    expect(restoreCompositeChannel).toContain('function restoreCompositeChannel(doc)');
    // Whole body wrapped in try; catch arm is empty (best-effort cleanup —
    // a restore failure must never throw into the caller, which is itself
    // probably handling a different failure).
    expect(restoreCompositeChannel).toMatch(
      /try\s*\{[\s\S]*\}\s*catch\s*\(\s*eRestore\s*\)\s*\{\s*\}/
    );
  });

  it('dispatches across all four supported document modes', () => {
    expect(restoreCompositeChannel).toContain('DocumentMode.CMYK');
    expect(restoreCompositeChannel).toContain('DocumentMode.GRAYSCALE');
    expect(restoreCompositeChannel).toContain('DocumentMode.LAB');
    // RGB is the default (no `if`/`else if`) — pin the four composite charIDs
    // by literal so a "let me consolidate" refactor wouldn't silently drop
    // a mode.
    expect(restoreCompositeChannel).toContain("'RGB '");
    expect(restoreCompositeChannel).toContain("'CMYK'");
    expect(restoreCompositeChannel).toContain("'Gry '");
    expect(restoreCompositeChannel).toContain("'Lab '");
  });

  it('uses app.charIDToTypeID directly (no helperFunctions dependency)', () => {
    // The helper must work without ${helperFunctions} being interpolated
    // before it, so the cTID/sTID shorthand isn't legal here. Pin the
    // full names so a "drop in cTID for brevity" refactor breaks the test.
    expect(restoreCompositeChannel).toContain('app.charIDToTypeID');
    // The body should contain at least the four-mode composite + the
    // Chnl/Chnl/composite reference build.
    expect(restoreCompositeChannel).toContain("app.charIDToTypeID('Chnl')");
    expect(restoreCompositeChannel).toContain("app.executeAction(app.charIDToTypeID('slct')");
  });

  // ===========================================================================
  // 2026-06-08 v0.5.4 — REGRESSION GUARD on the rolled-back v0.5.3
  // early-return optimization. The v0.5.3 build added an
  // `if (doc.activeChannels.length === doc.componentChannels.length) return;`
  // short-circuit at the top of restoreCompositeChannel to avoid a
  // cosmetic "Select RGB Channel" undo entry. That check false-positived
  // on macOS PS 27.7 — a chain of selection-tool calls (each going
  // through getSelectionInfo's finally) saw the length check evaluate
  // true after tempCh.remove() when the active set was NOT actually
  // composite. Composite never got restored; the next create_layer_mask
  // call failed with "command Make not currently available." v0.5.4
  // rolls back to v0.5.2 behaviour: fire slct unconditionally. Pin that
  // the length-equality short-circuit doesn't come back.
  // ===========================================================================
  it('does NOT short-circuit on doc.activeChannels.length (v0.5.4 rollback guard)', () => {
    // The exact comparison shape v0.5.3 used; any future attempt at the
    // same optimization should write it differently AND prove it works
    // on macOS PS before reintroducing it.
    expect(restoreCompositeChannel).not.toContain(
      'doc.activeChannels.length === doc.componentChannels.length'
    );
    // The slct AM event must execute on every call — no upstream return,
    // no guarded conditional. Strip whitespace to make the assertion
    // robust against future reformat.
    const compact = restoreCompositeChannel.replace(/\s+/g, '');
    expect(compact).toContain("executeAction(app.charIDToTypeID('slct')");
  });
});

// ===========================================================================
// F4 (2026-07 QA review) — Phase 4 layer-placement helpers had no direct
// body assertions here, only indirect golden equality (which pins the Go
// port against the TS output, not the TS output against its own documented
// behavior). A rename/typo on either helper could drift silently as long
// as both sides of the golden pin drifted together. These pin the actual
// load-bearing shape of each helper body.
// ===========================================================================
describe('parentPathHelper (Phase 4 — layer-placement bug)', () => {
  it('defines __parentPathOf recursing via instanceof LayerSet, not layer.typename', () => {
    expect(parentPathHelper).toContain('function __parentPathOf(doc, layer)');
    expect(parentPathHelper).toContain('function __ppWalk(layers, trail)');
    expect(parentPathHelper).toContain('candidate instanceof LayerSet');
    expect(parentPathHelper).not.toMatch(/\.typename\s*===\s*['"]LayerSet['"]/);
  });

  it('matches the target layer by object identity, walking from doc.layers', () => {
    expect(parentPathHelper).toContain('if (candidate === layer) return trail;');
    expect(parentPathHelper).toContain('return __ppWalk(doc.layers, []);');
  });

  it('builds the trail from containing GROUP NAMES (outermost first), not indices', () => {
    expect(parentPathHelper).toMatch(/__ppWalk\(childLayers, trail\.concat\(\[cname\]\)\)/);
  });

  it('every call site is wrapped defensively — a throw reading .layers/.length degrades instead of propagating', () => {
    // Both the length probe and the recursive childLayers walk are inside
    // try/catch, so a COM-bridged proxy that throws on .layers doesn't
    // blow up the whole tool call.
    expect(parentPathHelper).toMatch(/try\s*\{\s*n\s*=\s*layers\.length;\s*\}\s*catch/);
    expect(parentPathHelper).toMatch(
      /try\s*\{\s*childLayers\s*=\s*candidate\.layers;\s*\}\s*catch/
    );
  });
});

describe('hoistFromActiveGroupHelper (Phase 4 — layer-placement bug)', () => {
  it('defines __hoistFromActiveGroupIfNeeded with the intoActiveGroup early-out', () => {
    expect(hoistFromActiveGroupHelper).toContain(
      'function __hoistFromActiveGroupIfNeeded(doc, preMkActive, newLayer, intoActiveGroup)'
    );
    expect(hoistFromActiveGroupHelper).toContain('if (intoActiveGroup) return false;');
  });

  it('only hoists when the pre-Mk active layer was actually a group (instanceof LayerSet)', () => {
    expect(hoistFromActiveGroupHelper).toContain('preWasGroup = (preMkActive instanceof LayerSet)');
    expect(hoistFromActiveGroupHelper).toContain('if (!preWasGroup) return false;');
  });

  it('confirms the new layer actually landed inside that group before moving it (membership check, not assumption)', () => {
    expect(hoistFromActiveGroupHelper).toContain('if (preMkActive.layers[i] === newLayer)');
    expect(hoistFromActiveGroupHelper).toContain('if (!landedInside) return false;');
  });

  it('moves the layer out via PLACEBEFORE, restores it as active, and reports the outcome truthfully', () => {
    expect(hoistFromActiveGroupHelper).toContain(
      'newLayer.move(preMkActive, ElementPlacement.PLACEBEFORE);'
    );
    expect(hoistFromActiveGroupHelper).toContain('doc.activeLayer = newLayer;');
    expect(hoistFromActiveGroupHelper).toContain('return true;');
    // F8 (2026-07 QA review): a failed move must report false, not throw —
    // the caller decides whether to surface it via the `hoisted` field.
    expect(hoistFromActiveGroupHelper).toMatch(
      /catch\s*\(\s*eMove\s*\)\s*\{\s*\}\s*\n\s*return false;/
    );
  });
});

describe('countLayersRecursiveHelper (Phase 4 — layer-count-mislabel fix)', () => {
  it('defines __countLayersRecursive, counting every layer including groups themselves', () => {
    expect(countLayersRecursiveHelper).toContain('function __countLayersRecursive(layers)');
    expect(countLayersRecursiveHelper).toContain('total++;');
    expect(countLayersRecursiveHelper).toContain('candidate instanceof LayerSet');
    expect(countLayersRecursiveHelper).toMatch(
      /if \(isGroup\)[\s\S]*total \+= __countLayersRecursive\(childLayers\);/
    );
  });

  it('degrades to 0 rather than throwing when .layers/.length is unavailable', () => {
    expect(countLayersRecursiveHelper).toMatch(
      /try\s*\{\s*n\s*=\s*layers\.length;\s*\}\s*catch\s*\(\s*eN\s*\)\s*\{\s*n\s*=\s*0;\s*\}/
    );
  });

  it('total_layer_count is a genuinely recursive count, distinct from the pre-existing shallow layerCount', () => {
    // getContextInfo — the MUST-list context every create/select/etc tool
    // returns.
    expect(getContextInfo).toContain('layerCount: doc.layers.length,');
    expect(getContextInfo).toContain('total_layer_count: __countLayersRecursive(doc.layers)');
  });
});

// ===========================================================================
// __notFoundMessage — BEHAVIORAL coverage. The helper is pure ES3 over
// `app.activeDocument.layers` + `instanceof LayerSet`, so the real emitted
// body runs here against a stubbed DOM: what these tests exercise is the
// exact string the engine ships, not a hand-written imitation. The
// classifier round-trips prove the engine-produced wording (not just a
// hand-authored copy of it) lands in its intended error class.
// ===========================================================================

class FakeLayerSet {
  name: string;
  layers: unknown[];
  constructor(name: string, layers: unknown[] = []) {
    this.name = name;
    this.layers = layers;
  }
}
const flat = (name: string) => ({ name });
const group = (name: string, layers: unknown[] = []) => new FakeLayerSet(name, layers);

function runNotFound(
  label: string,
  requested: string,
  groupsOnly: boolean,
  appObj: unknown
): string {
  const fn = new Function(
    'app',
    'LayerSet',
    'label',
    'requested',
    'groupsOnly',
    `${notFoundMessageHelper}\nreturn __notFoundMessage(label, requested, groupsOnly);`
  );
  return fn(appObj, FakeLayerSet, label, requested, groupsOnly) as string;
}
const withLayers = (layers: unknown[]) => ({ activeDocument: { layers } });

describe('__notFoundMessage (behavioral, real emitted body)', () => {
  it('names what exists', () => {
    const msg = runNotFound(
      'Layer',
      'Curves 1',
      false,
      withLayers([flat('Background'), flat('dodge-burn')])
    );
    expect(msg).toBe('Layer not found: Curves 1. Have: Background, dodge-burn');
  });

  it('caps the list at 8 and counts the remainder honestly', () => {
    const layers = Array.from({ length: 12 }, (_, i) => flat(`L${i + 1}`));
    const msg = runNotFound('Layer', 'X', false, withLayers(layers));
    expect(msg).toContain('L8');
    expect(msg).not.toContain('L9');
    expect(msg).toContain('(+4 more)');
  });

  it('clips a long name to 40 characters', () => {
    const long = 'A'.repeat(50);
    const msg = runNotFound('Layer', 'X', false, withLayers([flat(long)]));
    expect(msg).toContain('A'.repeat(40) + '...');
    expect(msg).not.toContain('A'.repeat(41));
  });

  it('counts and lists layers nested deeper than one group level', () => {
    // Regression pin for the depth-1 walk: the lookup recurses to depth 32,
    // so a miss must not undercount what exists — an LLM told "(+1 more)"
    // when its target sits three groups deep will re-create a layer that
    // already exists.
    const doc = withLayers([
      flat('Background'),
      group('Retouch', [group('Skin', [group('FreqSep', [flat('dodge-burn')])])]),
    ]);
    const msg = runNotFound('Layer', 'dodge–burn', false, doc);
    expect(msg).toContain('dodge-burn');
    expect(msg).not.toContain('more)');
  });

  it('groupsOnly lists only groups, including nested ones', () => {
    const doc = withLayers([flat('a'), group('G1', [group('G2', [flat('b')])])]);
    const msg = runNotFound('Group', 'edits', true, doc);
    expect(msg).toBe('Group not found: edits. Have: G1, G2');
  });

  it('reports honest empties', () => {
    expect(runNotFound('Layer', 'X', false, withLayers([]))).toContain('Have: (none)');
    expect(runNotFound('Group', 'X', true, withLayers([flat('a')]))).toContain('Have: (no groups)');
  });

  // Raw non-ASCII flattens to '?' on the codepage-bound cscript stdout
  // transport (measured live, PS 27.2.0: 背景テスト arrived as '?????'), so
  // names escape non-ASCII as \uXXXX — lossless through any transport, and
  // the list's reader is an LLM, which reads the escape fine.
  it('escapes non-ASCII name characters as transport-safe \\uXXXX', () => {
    const msg = runNotFound('Layer', 'sky', false, withLayers([flat('背景'), flat('Ebene 1')]));
    expect(msg).toContain('\\u80cc\\u666f');
    expect(msg).not.toContain('背景');
    expect(msg).toContain('Ebene 1');
  });

  it('omits the Have: clause entirely when the walk broke before counting anything', () => {
    const broken = {
      activeDocument: {
        get layers(): unknown[] {
          throw new Error('proxy dead');
        },
      },
    };
    const msg = runNotFound('Layer', 'X', false, broken);
    expect(msg).toBe('Layer not found: X');
    expect(msg).not.toContain('Have:');
  });

  // The wording is load-bearing for telemetry — round-trip the REAL
  // engine-produced strings (wrapped in their handler prefixes) through the
  // classifier, including the adversarial layer name that motivated the
  // tier hoist.
  it('classifies as its not-found class even when user layer names carry input-error vocabulary', () => {
    const doc = withLayers([flat('invalid crop guide'), flat('must be dodged')]);
    const layerMiss = 'Error selecting layer: ' + runNotFound('Layer', 'Curves 1', false, doc);
    expect(classifyError(layerMiss)).toBe('layer_not_found');
    const groupMiss =
      'Error moving layer to group: ' +
      runNotFound('Group', 'edits', true, withLayers([group('invalid stuff')]));
    expect(classifyError(groupMiss)).toBe('group_not_found');
  });
  it('marks a partially broken walk as incomplete instead of presenting a truncated list as authoritative', () => {
    const layers = {
      length: 3,
      0: flat('Background'),
      get 1(): unknown {
        throw new Error('dead proxy');
      },
      2: flat('Sky'),
    };
    const msg = runNotFound('Layer', 'X', false, { activeDocument: { layers } });
    expect(msg).toContain('Background');
    expect(msg).toContain('Sky');
    expect(msg).toContain('(list may be incomplete)');
    expect(classifyError('Error selecting layer: ' + msg)).toBe('layer_not_found');
  });

  it('escapes backslash so the encoding is injective', () => {
    // A layer literally named \u00e9 (six ASCII chars) must not collide with
    // a layer actually named é.
    const msg = runNotFound('Layer', 'X', false, withLayers([flat('\\u00e9'), flat('é')]));
    expect(msg).toContain('\\u005cu00e9');
    expect(msg).toContain(', \\u00e9');
  });

  it('clips to the last complete escape, never a dangling half escape', () => {
    // 9 CJK characters escape to 54 chars; the 40-char cut lands mid-escape
    // and must back off to a 6-char escape boundary.
    const msg = runNotFound('Layer', 'X', false, withLayers([flat('背景テスト画像設定拡')]));
    expect(msg).toMatch(/(?:\\u[0-9a-f]{4})+\.\.\./);
    expect(msg).not.toMatch(/\\u[0-9a-f]{0,3}\.\.\./);
  });

  it('the helper body stays ES3 (Photoshop rejects modern syntax at runtime)', () => {
    // new Function proves behavior under Node's parser, which accepts syntax
    // ExtendScript's ES3 engine does not — pin the source shape too.
    expect(notFoundMessageHelper).not.toMatch(/\b(const |let )/);
    expect(notFoundMessageHelper).not.toContain('=>');
    expect(notFoundMessageHelper).not.toMatch(/\.(map|forEach|filter|includes|trim)\(/);
  });
});
