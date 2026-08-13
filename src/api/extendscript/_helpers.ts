/**
 * Shared helpers for the ExtendScript snippet library.
 *
 * Moved out of `src/api/extendscript.ts` on 2026-06-09 as the first step of
 * the 6500-line monolith split. Every category file under
 * `src/api/extendscript/` (`filters.ts`, `selections.ts`, etc.) imports the
 * helpers it needs from here, and `src/api/extendscript.ts` re-exports the
 * three already-public helpers (`restoreCompositeChannel`, `getContextInfo`,
 * `getMinimalContextInfo`) so the 22 existing consumers (`src/tools/*.ts`,
 * `src/core/server.ts`, `tests/`) keep working without import changes.
 *
 * Previously-private constants (`helperFunctions`, `normNameHelper`,
 * `selectionTypeHelpers`, `getSelectionInfo`, `duplicateForOp`) are now
 * exported so the category files can interpolate / call them — they were
 * file-private only because the prior monolith didn't need module
 * boundaries.
 *
 * (`findLastTopLevelSeparator` / `stripLeadingCommentsAndWhitespace` were
 * relocated to `src/api/custom-script.ts` alongside `wrapCustomScript` in
 * Go sidecar Phase 3 — they transform user code, not snippet IP.)
 */

import { jsLit } from '../../utils/jsx.js';

/**
 * Helper functions for character/string ID conversion
 */
export const helperFunctions = `
function cTID(s) { return app.charIDToTypeID(s); }
function sTID(s) { return app.stringIDToTypeID(s); }
`;

/**
 * Shared layer-name normalizer for snippets that look up layers / groups
 * by name. Originally lived inline inside `moveLayerToGroup` (Bug I from
 * the 2026-05-30 PS 27.x cross-platform bug roster) — the LLM frequently
 * sends a hyphen-minus where the layer was actually created with an
 * em-dash (U+2014) or en-dash (U+2013), and raw string equality silently
 * fails. Lifted here so `selectLayer`, `renameLayer`, `deleteLayer`, and
 * every other name-lookup snippet can share the same dash-normalization
 * + whitespace collapse + case-insensitive comparison.
 *
 * Use via `normName(s)` after interpolating `normNameHelper` into the
 * snippet body. The helper is idempotent — re-interpolation into a
 * snippet that already includes it is harmless (function redeclaration
 * is allowed in ExtendScript).
 */
export const normNameHelper = `
function normName(s) {
  if (s === null || s === undefined) return '';
  var out = String(s);
  // Normalize visually-similar dash variants to ASCII hyphen.
  var dashy = '\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015';
  var result = '';
  for (var i = 0; i < out.length; i++) {
    var c = out.charAt(i);
    result += (dashy.indexOf(c) >= 0) ? '-' : c;
  }
  // Collapse internal whitespace runs to single spaces and trim.
  return result.replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '').toLowerCase();
}
`;

/**
 * Name-miss error builder — mirrors `vault.NotFound` in the go-core (the
 * mirror guard pins the two bodies together). A bare "Layer not found: X" is a
 * dead end for the caller; naming what IS there lets the next call succeed
 * without a round trip through `ps_read_scene`.
 *
 * Use via `__notFoundMessage(label, requested, groupsOnly)` after interpolating
 * this into the snippet body. Idempotent, like `normNameHelper`.
 */
export const notFoundMessageHelper = `
function __notFoundMessage(label, requested, groupsOnly) {
  var kept = [];
  var total = 0;
  function consider(layer) {
    total++;
    if (kept.length >= 8) return;
    var nm = String(layer.name);
    if (nm.length > 40) nm = nm.substring(0, 40) + '...';
    kept.push(nm);
  }
  function walk(layers, depth) {
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      var isGroup = false;
      try { isGroup = (l instanceof LayerSet); } catch (eG) {}
      if (isGroup || !groupsOnly) consider(l);
      if (isGroup && depth < 1) {
        try { walk(l.layers, depth + 1); } catch (eD) {}
      }
    }
  }
  try { walk(app.activeDocument.layers, 0); } catch (eW) {}
  var have;
  if (total === 0) {
    have = groupsOnly ? '(no groups)' : '(none)';
  } else {
    have = kept.join(', ');
    if (total > kept.length) have += ' (+' + (total - kept.length) + ' more)';
  }
  return label + ' not found: ' + requested + '. Have: ' + have;
}
`;

// `requirePixelLayer` (a helper for bake-style adjustments/filters) was
// removed 2026-05-31 with the four destructive bake adjustment tools that
// were its only callers. The filter family (apply_*_blur, apply_sharpen,
// apply_noise) inlines its own rasterize-or-throw logic. If a future bake
// tool needs the helper back, restore from git history before commit (the
// 2026-05-31 tool-removals commit).

/**
 * Helper that maps a 'replace'|'add'|'subtract'|'intersect' string to the
 * PS SelectionType enum, plus a routine that combines a freshly-made selection
 * (created via an AM event that always REPLACEs) with a stored original
 * selection in the requested mode.
 *
 * Pattern (for AM-based selections like autoCutout / selectSky which don't
 * accept a SelectionType parameter):
 *   1. saveCurrentSelectionToChannel() — stores existing selection or null
 *   2. <run the AM selection event — replaces selection with new>
 *   3. combineWithSavedSelection(savedChannel, 'add') — loads saved channel
 *      back in EXTEND/DIMINISH/INTERSECT mode; for 'replace', no-op.
 *
 * For DOM-based selections that take a SelectionType natively (e.g.
 * Selection.select(bounds, type, ...)), use mapSelType() directly and skip
 * the channel hop.
 *
 * **Channel-pollution contract (2026-06-07 audit).** Both
 * `saveSelectionToTempChannel` and `combineWithSavedSelection` call
 * `doc.channels.add()` — same bug class as `getSelectionInfo` and
 * `get_selection_preview`. The normal-return path of every current caller
 * (selectSubject / selectSky / selectColorRange / magicWand) is safe
 * because each returns `selection_info: getSelectionInfo()`, which runs
 * `restoreCompositeChannel(doc)` in its finally. The EARLY-EXIT throws in
 * each caller (AM event failure, no-fsel-after-success) skip the
 * getSelectionInfo() call — so each early-exit MUST call
 * `restoreCompositeChannel(doc);` itself before throwing. Verified across
 * all 4 callers in the 2026-06-07 audit; future callers using this helper
 * block need to honour the same contract.
 */
export const selectionTypeHelpers = `
function mapSelType(s) {
  if (s === 'add' || s === 'extend') return SelectionType.EXTEND;
  if (s === 'subtract' || s === 'diminish') return SelectionType.DIMINISH;
  if (s === 'intersect') return SelectionType.INTERSECT;
  return SelectionType.REPLACE;
}

function hasActiveSelection(doc) {
  var r = new ActionReference();
  r.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('fsel'));
  r.putEnumerated(app.charIDToTypeID('Dcmn'), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
  return app.executeActionGet(r).hasKey(app.charIDToTypeID('fsel'));
}

function saveSelectionToTempChannel(doc) {
  if (!hasActiveSelection(doc)) return null;
  var ch = doc.channels.add();
  doc.selection.store(ch, SelectionType.REPLACE);
  // channels.add() makes the new alpha the ACTIVE channel. A pixel-sampling
  // selection op that runs next (magic wand / color range / grow / similar)
  // would then sample THIS alpha — uniform inside the stored selection — and
  // flood the whole region, so a subsequent add/subtract/intersect collapses
  // to empty/full. Geometric ops (rectangle/ellipse) are immune. Restore the
  // composite so the sampler reads RGB. (See restoreCompositeChannel for the
  // sibling cleanup-time case.)
  doc.activeChannels = doc.componentChannels;
  return ch;
}

function combineWithSavedSelection(doc, savedChannel, selection_type) {
  // savedChannel is the channel storing the original selection (or null).
  // The "current" PS selection is the newly-made one we want to combine with it.
  if (selection_type === 'replace' || !savedChannel) {
    if (savedChannel) { try { savedChannel.remove(); } catch (e) {} }
    return;
  }
  // Stash the new (current) selection so we can restore the original first.
  var newCh = doc.channels.add();
  doc.selection.store(newCh, SelectionType.REPLACE);
  // Restore original, then combine with the new one in the requested mode.
  doc.selection.load(savedChannel, SelectionType.REPLACE);
  doc.selection.load(newCh, mapSelType(selection_type));
  try { savedChannel.remove(); } catch (e) {}
  try { newCh.remove(); } catch (e) {}
}
`;

/**
 * Snippet-side helper: restore the document's active channel to the
 * composite (RGB / CMYK / Lab / Gray, per the doc's mode) after any
 * `doc.channels.add()` work.
 *
 * **The bug class this prevents.** `doc.channels.add()` makes the newly-
 * created alpha channel the active channel. Removing that channel later
 * (`tempCh.remove()`) leaves the document on an indeterminate channel.
 * The next AM event that requires composite — `Mk Chnl At=Msk` from
 * `ps_layer_mask` is the canonical case — then fails with
 * "command 'Make' is not currently available."
 *
 * Use via `${restoreCompositeChannel}` (interpolates the function
 * definition) then call `restoreCompositeChannel(doc)` after any
 * channel cleanup. Uses `app.charIDToTypeID(...)` directly so it does
 * NOT require `${helperFunctions}` in scope.
 *
 * Defined ahead of `getSelectionInfo` so getSelectionInfo's own template
 * literal can interpolate it — every snippet that uses getSelectionInfo
 * gets the restoration for free in its cleanup.
 *
 * **Early-return optimization (2026-06-07).** If the active channels
 * already are the composite (length matches component channels — RGB→3,
 * CMYK→4, Gray→1), the function returns without firing the `slct` AM
 * event. PS does sometimes naturally fall back to composite after a
 * temp-channel `.remove()`, in which case the redundant slct would add
 * a "Select RGB Channel" entry to the user-visible undo history. The
 * check costs ~one DOM property access and skips the cosmetic noise on
 * the common case. The slct still fires when composite is genuinely
 * NOT active — i.e. when the fix is actually needed.
 */
export const restoreCompositeChannel = `
function restoreCompositeChannel(doc) {
  try {
    // 2026-06-08: v0.5.3 added an active-channel-length short-circuit
    // here to skip the slct event when composite was supposedly already
    // active, avoiding a cosmetic "Select RGB Channel" entry in the undo
    // history. That optimization false-positived on macOS PS 27.7 — a
    // chain of selection-tool calls (each going through getSelectionInfo's
    // finally) saw the length check evaluate true after tempCh.remove()
    // when the active set was NOT actually composite, so the restore
    // never fired and channel-state pollution compounded. The next
    // create_layer_mask call inherited the broken state and failed with
    // "command Make not currently available." See the v0.5.4 CHANGELOG
    // for the trace. Rolled back to v0.5.2 behaviour: fire slct
    // unconditionally. The cosmetic undo entry is a small cost; the
    // Mac regression is not.
    var compositeEnum = app.charIDToTypeID('RGB ');
    var docMode = String(doc.mode);
    if (docMode === 'DocumentMode.CMYK') compositeEnum = app.charIDToTypeID('CMYK');
    else if (docMode === 'DocumentMode.GRAYSCALE') compositeEnum = app.charIDToTypeID('Gry ');
    else if (docMode === 'DocumentMode.LAB') compositeEnum = app.charIDToTypeID('Lab ');
    var restoreDesc = new ActionDescriptor();
    var restoreRef = new ActionReference();
    restoreRef.putEnumerated(app.charIDToTypeID('Chnl'), app.charIDToTypeID('Chnl'), compositeEnum);
    restoreDesc.putReference(app.charIDToTypeID('null'), restoreRef);
    app.executeAction(app.charIDToTypeID('slct'), restoreDesc, DialogModes.NO);
  } catch (eRestore) {}
}
`;

/**
 * Helper that returns a rich selection-info bundle the agent can use to
 * verify what a selection op actually picked up — bounds, pixel count
 * weighted by coverage, area %, fully-vs-partial breakdown, and an
 * edge_complexity metric (fraction of partially-selected pixels).
 *
 * Computed by storing the selection to a temp alpha channel, reading its
 * histogram (256 bins of pixel counts at each value), deriving the metrics,
 * then deleting the temp channel. Wrapped in try/finally so the channel
 * is always cleaned up even if histogram access throws.
 *
 * Returns { has_selection: false } cleanly when no selection is active —
 * never throws on missing selection (uses the fsel ActionReference probe).
 *
 * Cost: ~150-300ms per call. Inline this in every selection-tool return
 * via \`selection_info: getSelectionInfo()\` so the agent gets feedback
 * without an extra round-trip.
 *
 * **Composite-channel restoration (2026-06-07 hotfix).** The interpolated
 * `${restoreCompositeChannel}` at the top of this body is called in the
 * finally block after the temp alpha channel is removed. Without it,
 * `doc.channels.add()` leaves the document on a non-composite channel and
 * a downstream `ps_layer_mask` (and any other AM event that
 * requires composite) fails with "command 'Make' is not currently available."
 */
export const getSelectionInfo = `
${restoreCompositeChannel}
function getSelectionInfo() {
  if (app.documents.length === 0) {
    return { has_selection: false };
  }
  var doc = app.activeDocument;

  // fsel probe — never throws (raw doc.selection.bounds raises uncatchable
  // PS 2024+ error 1302 when no selection).
  var probeRef = new ActionReference();
  probeRef.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('fsel'));
  probeRef.putEnumerated(app.charIDToTypeID('Dcmn'), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
  if (!app.executeActionGet(probeRef).hasKey(app.charIDToTypeID('fsel'))) {
    return { has_selection: false };
  }

  // Safe now — selection exists, bounds won't throw.
  var b = doc.selection.bounds;
  var L = b[0].as('px'), T = b[1].as('px'), R = b[2].as('px'), Bot = b[3].as('px');
  var canvasW = doc.width.as('px');
  var canvasH = doc.height.as('px');

  // Store selection to a temp alpha channel and read its histogram.
  // Wrap in try/finally so we always clean up the channel.
  var tempCh = null;
  try {
    tempCh = doc.channels.add();
    doc.selection.store(tempCh, SelectionType.REPLACE);
    var bins = tempCh.histogram;

    var weightedSum = 0;
    var fullySel = 0;
    var partialSel = 0;
    var anySel = 0;
    for (var i = 0; i < bins.length; i++) {
      var c = bins[i];
      if (i === 255) fullySel = c;
      else if (i >= 1) partialSel += c;
      if (i > 0) anySel += c;
      weightedSum += c * (i / 255);
    }
    var pixelCount = Math.round(weightedSum);
    var canvasArea = canvasW * canvasH;
    var boundsArea = (R - L) * (Bot - T);

    return {
      has_selection: true,
      bounds: { left: L, top: T, right: R, bottom: Bot },
      bounds_width: R - L,
      bounds_height: Bot - T,
      bounds_area: boundsArea,
      pixel_count: pixelCount,
      pixels_with_any_selection: anySel,
      fully_selected_pixels: fullySel,
      partial_pixels: partialSel,
      area_percent: canvasArea > 0 ? (pixelCount / canvasArea) * 100 : 0,
      bounds_fill_ratio: boundsArea > 0 ? pixelCount / boundsArea : 0,
      edge_complexity: anySel > 0 ? partialSel / anySel : 0
    };
  } catch (eInfo) {
    return { has_selection: true, error: 'selection_info_failed: ' + eInfo.message };
  } finally {
    if (tempCh) {
      try { tempCh.remove(); } catch (eClean) {}
    }
    // Restore composite channel — doc.channels.add() above made the alpha
    // channel active; tempCh.remove() doesn't reliably restore composite.
    // Skipping this restoration is what caused the 2026-06-07 hotfix:
    // every selection tool that inlines getSelectionInfo as its return
    // value left the document on a non-composite channel, breaking the
    // very next ps_layer_mask call.
    restoreCompositeChannel(doc);
  }
}
`;

/**
 * 2026-06-01 helper: produce the ExtendScript fragment that runs
 * BEFORE a destructive operation so the op acts on a duplicate of the
 * active layer rather than the layer itself. The pattern keeps every
 * pixel-modifying tool non-destructive by default — the original layer
 * stays in place, the duplicate gets the operation, and the caller can
 * undo by deleting the duplicate.
 *
 * Power users (or callers that have already explicitly duplicated the
 * layer themselves) pass `applyToActiveLayer = true` to skip the auto-
 * duplicate and bake into the active layer in the historical way.
 *
 * Contract:
 *   - Caller must have `var doc = app.activeDocument;` in scope before
 *     this fragment runs.
 *   - After this fragment, `doc.activeLayer` is the layer the destructive
 *     op should act on (either a fresh copy or the original).
 *   - The fragment writes a `__opTargetIsCopy` boolean that snippets
 *     should return in their result so the caller knows what happened.
 *   - The original layer name is preserved in the copy's display name as
 *     "<OpName> (<Original Name>)" — predictable enough that the LLM can
 *     read the layer tree and see which adjustment landed where.
 */
export function duplicateForOp(opName: string, applyToActiveLayer: boolean): string {
  if (applyToActiveLayer) {
    return `
    // apply_to_active_layer=true: skip the auto-duplicate, bake directly
    // into the original. The original-layer-preserving pattern is the
    // safe default; callers opt out only when they explicitly want the
    // historical destructive behavior.
    var __opTargetIsCopy = false;
    var __opOriginalName = doc.activeLayer.name;
    `;
  }
  return `
    // Auto-duplicate-first: the destructive op below will act on
    // a fresh copy of the active layer so the original is preserved.
    // Undoing the op is as simple as deleting the copy.
    var __opOriginal = doc.activeLayer;
    var __opOriginalName = __opOriginal.name;
    var __opCopy = __opOriginal.duplicate();
    __opCopy.name = ${jsLit(opName)} + ' (' + __opOriginalName + ')';
    doc.activeLayer = __opCopy;
    var __opTargetIsCopy = true;
    `;
}

/**
 * Recursive layer counter (Phase 4, 2026-07): `doc.layers.length` only
 * counts TOP-LEVEL entries — a group nested three deep contributes exactly
 * 1 to that count no matter how many descendants it holds. `layerCount` /
 * `layer_count` were both documented (wrongly) as "total layer count in the
 * document" while actually being this shallow count, which is why a nested
 * creation could read as a flat, unchanged count and look like clean
 * success. This helper walks every level (instanceof LayerSet — not
 * layer.typename) and counts every layer, including groups themselves.
 * Prepended to `getContextInfo` below (same pattern as
 * `restoreCompositeChannel` + `getSelectionInfo`) so every consumer of
 * getContextInfo also gets `__countLayersRecursive` in scope for free —
 * `getMetadata`'s `result.document` block (metadata.ts) reuses it too.
 */
export const countLayersRecursiveHelper = `
function __countLayersRecursive(layers) {
  var total = 0;
  var n = 0;
  try { n = layers.length; } catch (eN) { n = 0; }
  for (var i = 0; i < n; i++) {
    var candidate = null;
    try { candidate = layers[i]; } catch (eC) { continue; }
    if (!candidate) continue;
    total++;
    var isGroup = false;
    try { isGroup = (candidate instanceof LayerSet); } catch (eG) {}
    if (isGroup) {
      var childLayers = null;
      try { childLayers = candidate.layers; } catch (eCl) { childLayers = null; }
      if (childLayers) total += __countLayersRecursive(childLayers);
    }
  }
  return total;
}
`;

/**
 * Helper function to get current context information.
 *
 * Exported so handler files that compose their own inline JSX (e.g.
 * preview-tools.ts's flattened-duplicate script) can embed the same helper
 * other snippets use.
 */
export const getContextInfo = `
${countLayersRecursiveHelper}
function getContextInfo() {
  // The whole body is wrapped in try/catch — a destructive op that
  // succeeded but then triggered "document closed" / "active layer gone"
  // during the context probe should NOT make the op look failed to the
  // caller. On any unexpected throw we return a degraded context with
  // an error_reading field so the caller can see something happened
  // but the structured result still arrives.
  try {
    var context = {
      hasDocument: app.documents.length > 0
    };

    if (context.hasDocument) {
      var doc = app.activeDocument;
      context.document = {
        name: doc.name,
        width: doc.width.as('px'),
        height: doc.height.as('px'),
        resolution: doc.resolution,
        colorMode: String(doc.mode),
        layerCount: doc.layers.length,
        total_layer_count: __countLayersRecursive(doc.layers),
        hasSelection: (function () {
          // ExtendScript throws "No such element" when accessing doc.selection.bounds
          // with no active selection, and that error is NOT catchable when DoJavaScript
          // is invoked via COM in PS 2024+ — it propagates as PS error 1302. Use the
          // ActionManager instead, which never throws.
          var ref = new ActionReference();
          ref.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('fsel'));
          ref.putEnumerated(app.charIDToTypeID('Dcmn'), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
          return app.executeActionGet(ref).hasKey(app.charIDToTypeID('fsel'));
        })()
      };

      if (doc.activeLayer) {
        var layer = doc.activeLayer;

        // layer.visible on the ExtendScript DOM returns EFFECTIVE
        // visibility (parent-chain AND own flag) NO MATTER which proxy
        // resolves it -- re-reading through a fresh doc.layers walk does
        // NOT recover the layer's own flag (verified live 2026-07: a
        // visible child inside a hidden group reads visible:false from
        // every DOM proxy, active-layer or walked). The own flag is only
        // readable via Action Manager's Vsbl property, keyed by the
        // layer's stable id (putIdentifier, not putName -- names aren't
        // unique). Confirmed live on both an ArtLayer and a LayerSet.
        // Falls back to the DOM (effective) value if the AM read throws,
        // so a failure degrades to the old behavior instead of breaking
        // the context block every tool returns.
        var __effectiveVisible = layer.visible;
        var __ownVisible = __effectiveVisible;
        try {
          var __visRef = new ActionReference();
          __visRef.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('Vsbl'));
          __visRef.putIdentifier(app.charIDToTypeID('Lyr '), layer.id);
          __ownVisible = app.executeActionGet(__visRef).getBoolean(app.charIDToTypeID('Vsbl'));
        } catch (eOwn) {}

        context.activeLayer = {
          name: layer.name,
          kind: String(layer.kind),
          opacity: layer.opacity,
          blendMode: String(layer.blendMode),
          visible: __ownVisible,
          effectively_visible: __effectiveVisible,
          locked: layer.allLocked,
          isBackground: layer.isBackgroundLayer
        };

        // Add bounds if available
        try {
          var bounds = layer.bounds;
          context.activeLayer.bounds = {
            left: bounds[0].as('px'),
            top: bounds[1].as('px'),
            right: bounds[2].as('px'),
            bottom: bounds[3].as('px')
          };
        } catch (e) {
          // Bounds not available for some layer types
        }
      }
    }

    return context;
  } catch (e) {
    // Best-effort degraded context. Carries error_reading so the caller
    // can see the probe failed but the structured result still arrives
    // (and the destructive op the caller just performed is NOT marked
    // failed because of a context-read failure).
    return {
      hasDocument: false,
      error_reading: (e && e.message) ? String(e.message) : String(e)
    };
  }
}
`;

/**
 * Slim context payload — emitted by tools that change a *property* of
 * the already-active layer (set_opacity, set_blend_mode, rename, apply_*
 * filters, etc.) rather than changing *what* is active or *what* exists.
 *
 * Returns only `{ document_name, activeLayer_name }`. The full
 * getContextInfo() payload (bounds, opacity, kind, blendMode, locked,
 * isBackground, document dims/mode, layerCount, hasSelection) repeats on
 * every tool call and bloats LLM context — the 2026-06-06 full-tool demo
 * showed LLM-thinking time growing to 70+ minutes over 108 calls,
 * dominated by re-processing duplicated context payloads. Tools on the
 * "EXEMPT" list in docs/engineering/tool-design.md don't change what's
 * active, so the LLM already knew it from the prior result; minimal-context just confirms
 * the document and active layer are still what the caller expected.
 *
 * Tools that DO change what's active (create_layer, select_layer, etc.)
 * continue to return full getContextInfo() — the LLM needs the kind /
 * bounds / blend mode of the newly-active thing.
 */
export const getMinimalContextInfo = `
function getMinimalContextInfo() {
  try {
    if (app.documents.length === 0) {
      return { hasDocument: false };
    }
    var doc = app.activeDocument;
    var layerName = null;
    try { layerName = doc.activeLayer ? doc.activeLayer.name : null; } catch (e) {}
    return {
      hasDocument: true,
      document_name: doc.name,
      activeLayer_name: layerName
    };
  } catch (e) {
    return {
      hasDocument: false,
      error_reading: (e && e.message) ? String(e.message) : String(e)
    };
  }
}
`;

/**
 * Phase 4 (layer-placement bug) — report where a newly-created layer
 * actually landed. Walks `doc.layers` recursively from the root, matching
 * the target layer by object identity (===) — NOT `layer.typename`
 * (unreliable on COM-bridged DOM objects, see getLayerTree in
 * metadata.ts / the LayerResolve helpers above). Group discrimination is
 * `instanceof LayerSet`, the same pattern used throughout this file.
 *
 * Returns `[]` when the layer is top-level (document root), the chain of
 * containing group names (outermost first) when nested, or `null` if the
 * layer could not be located at all (shouldn't happen for a layer that was
 * just created/resolved, but degrades safely rather than throwing).
 *
 * Mirrored byte-for-byte (modulo whitespace/comments) in
 * go-core/cmd/buildtemplates/fragments.go's vault.ParentPath — the golden
 * test pins the two together for the twin-shared creators.
 */
export const parentPathHelper = `
function __parentPathOf(doc, layer) {
  function __ppWalk(layers, trail) {
    var n = 0;
    try { n = layers.length; } catch (eN) {}
    for (var i = 0; i < n; i++) {
      var candidate = null;
      try { candidate = layers[i]; } catch (eC) { continue; }
      if (!candidate) continue;
      if (candidate === layer) return trail;
      var isGroup = false;
      try { isGroup = (candidate instanceof LayerSet); } catch (eG) {}
      if (isGroup) {
        var cname = null;
        try { cname = candidate.name; } catch (eNm) {}
        var childLayers = null;
        try { childLayers = candidate.layers; } catch (eCl) {}
        if (childLayers) {
          var found = __ppWalk(childLayers, trail.concat([cname]));
          if (found !== null) return found;
        }
      }
    }
    return null;
  }
  return __ppWalk(doc.layers, []);
}
`;

/**
 * Phase 4 (layer-placement bug) — hoist a just-created layer back out of
 * the group that was active before the \`Mk\` call, unless the caller opted
 * into Photoshop's native nesting.
 *
 * The bug: AM \`Mk\` descriptors for AdjL/layerSection/contentLayer carry NO
 * target reference, so Photoshop applies its native "relative to current
 * target" rule — with a group active, the new layer/group lands INSIDE it.
 * That silently contradicts every one of these tools' documented "above the
 * active layer" placement. This helper restores that promise by default:
 * when the pre-Mk active layer was a group AND the new layer landed
 * directly inside it, move the new layer out to sit just above (a sibling
 * of) that group. \`intoActiveGroup\` (the tool's \`into_active_group\` input,
 * default false) opts back into the native nesting behavior.
 *
 * Membership is checked by walking \`preMkActive.layers\` directly (object
 * identity) rather than relying on a \`layer.parent\` property — the DOM
 * doesn't reliably expose one, and the codebase's established pattern
 * (LayerResolve, ParentPath above) is to walk from a known container.
 *
 * Mirrored byte-for-byte (modulo whitespace/comments) in
 * go-core/cmd/buildtemplates/fragments.go's vault.HoistGroup.
 */
export const hoistFromActiveGroupHelper = `
function __hoistFromActiveGroupIfNeeded(doc, preMkActive, newLayer, intoActiveGroup) {
  if (intoActiveGroup) return false;
  var preWasGroup = false;
  try { preWasGroup = (preMkActive instanceof LayerSet); } catch (eG) {}
  if (!preWasGroup) return false;
  var landedInside = false;
  try {
    var n = preMkActive.layers.length;
    for (var i = 0; i < n; i++) {
      if (preMkActive.layers[i] === newLayer) { landedInside = true; break; }
    }
  } catch (eIn) {}
  if (!landedInside) return false;
  try {
    newLayer.move(preMkActive, ElementPlacement.PLACEBEFORE);
    try { doc.activeLayer = newLayer; } catch (eA) {}
    return true;
  } catch (eMove) {}
  return false;
}
`;
