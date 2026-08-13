package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// getMinimalContextInfo helper body (verbatim from _helpers.ts).
		vault.MinCtx: `
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
`,

		// duplicateForOp — auto-duplicate-first branch. The single %s is the
		// jsLit-quoted op name.
		vault.DupCopy: `
    // Auto-duplicate-first: the destructive op below will act on
    // a fresh copy of the active layer so the original is preserved.
    // Undoing the op is as simple as deleting the copy.
    var __opOriginal = doc.activeLayer;
    var __opOriginalName = __opOriginal.name;
    var __opCopy = __opOriginal.duplicate();
    __opCopy.name = %s + ' (' + __opOriginalName + ')';
    doc.activeLayer = __opCopy;
    var __opTargetIsCopy = true;
    `,

		// duplicateForOp — apply-to-active branch.
		vault.DupActive: `
    // apply_to_active_layer=true: skip the auto-duplicate, bake directly
    // into the original. The original-layer-preserving pattern is the
    // safe default; callers opt out only when they explicitly want the
    // historical destructive behavior.
    var __opTargetIsCopy = false;
    var __opOriginalName = doc.activeLayer.name;
    `,

		// vault.LayerResolve — independent layer re-resolution helpers (Phase 2
		// write-verification, 2026-07). A write to layer.<prop> only proves
		// itself if the read-back comes through a DIFFERENT resolution path
		// than the proxy that performed the write — re-reading the SAME proxy
		// (the old ps_set_layer bug: "verification" was a same-proxy echo)
		// proves nothing. captureLayerIdentity() runs BEFORE the write and
		// records the layer's stable Photoshop id (layer.id — present on both
		// ArtLayer and LayerSet) or, when unavailable, an index-path built via
		// reference match against the SAME proxy (safe here: it records
		// POSITION only, never the property under verification).
		// resolveLayerFresh() runs AFTER the write and walks doc.layers again
		// from scratch (fresh proxies from doc.layers / group.layers), matching
		// by id or path — never touching the proxy that wrote. Group
		// discrimination uses instanceof LayerSet, not layer.typename
		// (unreliable on COM-bridged DOM objects — see getLayerTree below).
		vault.LayerResolve: `
function __safeGet(fn, fallback) {
  try { var v = fn(); return (v === undefined ? fallback : v); }
  catch (e) { return fallback; }
}

function __findLayerPath(layers, target, prefix) {
  var n = __safeGet(function () { return layers.length; }, 0);
  for (var i = 0; i < n; i++) {
    var candidate = __safeGet(function () { return layers[i]; }, null);
    if (!candidate) continue;
    if (candidate === target) return prefix.concat([i]);
    var isGroup = false;
    try { isGroup = (candidate instanceof LayerSet); } catch (eG) {}
    if (isGroup) {
      var childLayers = __safeGet(function () { return candidate.layers; }, null);
      if (childLayers) {
        var found = __findLayerPath(childLayers, target, prefix.concat([i]));
        if (found) return found;
      }
    }
  }
  return null;
}

function __findLayerById(layers, id) {
  var n = __safeGet(function () { return layers.length; }, 0);
  for (var i = 0; i < n; i++) {
    var candidate = __safeGet(function () { return layers[i]; }, null);
    if (!candidate) continue;
    var cid = __safeGet(function () { return candidate.id; }, null);
    if (cid === id) return candidate;
    var isGroup = false;
    try { isGroup = (candidate instanceof LayerSet); } catch (eG) {}
    if (isGroup) {
      var childLayers = __safeGet(function () { return candidate.layers; }, null);
      if (childLayers) {
        var found = __findLayerById(childLayers, id);
        if (found) return found;
      }
    }
  }
  return null;
}

function __resolvePath(doc, path) {
  var current = doc;
  for (var i = 0; i < path.length; i++) {
    var idx = path[i];
    current = __safeGet(function () { return current.layers[idx]; }, null);
    if (!current) return null;
  }
  return current;
}

function __captureLayerIdentity(doc, layer) {
  var id = null;
  try { if (typeof layer.id !== 'undefined') { id = layer.id; } } catch (eId) {}
  var path = null;
  if (id === null) {
    path = __findLayerPath(doc.layers, layer, []);
  }
  return { id: id, path: path };
}

function __resolveLayerFresh(doc, identity) {
  if (identity.id !== null) {
    var byId = __findLayerById(doc.layers, identity.id);
    if (byId) return byId;
  }
  if (identity.path) {
    return __resolvePath(doc, identity.path);
  }
  return null;
}

function __resolveLayerFreshOrActive(doc, identity) {
  var resolved = __resolveLayerFresh(doc, identity);
  if (resolved) return resolved;
  // Identity resolution came up empty even though the write may have
  // landed — e.g. Photoshop auto-promoting a Background layer as a side
  // effect of the property write. Fall back to the current active layer
  // (these setters always operate on doc.activeLayer, and Photoshop keeps
  // it pointed at the promoted layer) rather than treating an unresolved
  // identity as proof the write failed.
  return __safeGet(function () { return doc.activeLayer; }, null);
}
`,

		// ParentPath — Phase 4 layer-placement-bug fix (2026-07): reports where a
		// newly-created layer actually landed. Walks doc.layers recursively from
		// the root, matching by object identity (===) — NOT layer.typename
		// (unreliable on COM-bridged DOM objects, see getLayerTree below).
		// Returns [] when the layer is top-level, the chain of containing group
		// names (outermost first) when nested, or null if the layer could not be
		// located at all. Mirrored byte-for-byte (modulo whitespace/comments) in
		// src/api/extendscript/_helpers.ts's parentPathHelper.
		vault.ParentPath: `
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
`,

		// HoistGroup — Phase 4 layer-placement-bug fix (2026-07): AM Mk
		// descriptors for AdjL/layerSection/contentLayer carry NO target
		// reference, so Photoshop applies its native "relative to current
		// target" rule — with a group active, the new layer/group lands INSIDE
		// it, silently contradicting the tool's documented "above the active
		// layer" placement. This helper restores that promise by default: when
		// the pre-Mk active layer was a group AND the new layer landed directly
		// inside it, move the new layer back out to sit just above (a sibling
		// of) that group. intoActiveGroup (the tool's into_active_group input,
		// default false) opts back into the native nesting. Membership is
		// checked by walking preMkActive.layers directly (object identity)
		// rather than a layer.parent property (the DOM doesn't reliably expose
		// one). Mirrored byte-for-byte (modulo whitespace/comments) in
		// src/api/extendscript/_helpers.ts's hoistFromActiveGroupHelper.
		vault.HoistGroup: `
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
`,

		// LayerCountRecursive — recursive layer counter (Phase 4, 2026-07):
		// doc.layers.length only counts TOP-LEVEL entries — a group nested three
		// deep contributes exactly 1 to that count no matter how many
		// descendants it holds. layerCount / layer_count were both documented
		// (wrongly) as "total layer count in the document" while actually being
		// this shallow count, which is why a nested creation could read as a
		// flat, unchanged count and look like clean success. Walks every level
		// (instanceof LayerSet — not layer.typename) and counts every layer,
		// including groups themselves.
		vault.LayerCountRecursive: `
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
`,

		// getContextInfo (full context) helper body (verbatim from _helpers.ts).
		// Interpolated by snippets that change WHAT is active/exists. Prepended
		// with LayerCountRecursive by the getContextInfo() accessor (same
		// pattern as restoreCompositeChannel + getSelectionInfo) so
		// __countLayersRecursive is in scope wherever getContextInfo is.
		vault.Ctx: `
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
`,

		// restoreCompositeChannel helper (verbatim from _helpers.ts). No slots.
		vault.RCC: `
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
`,

		// getSelectionInfo function (verbatim from _helpers.ts, WITHOUT the
		// leading ${restoreCompositeChannel} — the Go emitter prepends RCC). No
		// slots.
		vault.GSI: `
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
`,

		// selectionTypeHelpers (verbatim from _helpers.ts). No slots.
		vault.SelType: `
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
`,

		// helperFunctions (cTID/sTID) — verbatim from _helpers.ts. No slots.
		vault.HelperFns: `
function cTID(s) { return app.charIDToTypeID(s); }
function sTID(s) { return app.stringIDToTypeID(s); }
`,

		// bitsPerChannelHelper — verbatim from _helpers.ts. No slots.
		vault.BitsPerCh: `
function getBitsPerChannelInt(doc) {
  try {
    var bpc = doc.bitsPerChannel;
    if (bpc === BitsPerChannelType.ONE) return 1;
    if (bpc === BitsPerChannelType.EIGHT) return 8;
    if (bpc === BitsPerChannelType.SIXTEEN) return 16;
    if (bpc === BitsPerChannelType.THIRTYTWO) return 32;
  } catch (e) {}
  return 0;
}
`,

		// normNameHelper — verbatim from _helpers.ts. No slots. The \u escapes
		// and \s regex tokens are SINGLE-backslash in the emitted JSX (the TS
		// template literal's \\u became \u); Go raw strings keep them literal.
		vault.NormName: `
function normName(s) {
  if (s === null || s === undefined) return '';
  var out = String(s);
  // Normalize visually-similar dash variants to ASCII hyphen.
  var dashy = '\u2010\u2011\u2012\u2013\u2014\u2015';
  var result = '';
  for (var i = 0; i < out.length; i++) {
    var c = out.charAt(i);
    result += (dashy.indexOf(c) >= 0) ? '-' : c;
  }
  // Collapse internal whitespace runs to single spaces and trim.
  return result.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').toLowerCase();
}
`,

		// notFoundMessage helper — turns a name miss into an error the caller can
		// act on, by naming what IS there. Without it "Layer not found: Curves 1"
		// is a dead end: the client either guesses again or spends a round trip on
		// ps_read_scene. No slots.
		//
		// The walk recurses to the SAME depth cap as the lookups that call it
		// (findLayerByName/findGroupByName stop at depth 32), so the "+N more"
		// count is honest: a layer three groups deep is counted even when the
		// 8-name list is full. A walk that broke before counting anything emits
		// no "Have:" clause at all rather than asserting "(none)" about a
		// document it could not read. Runs ONLY on the failure path.
		//
		// Bounded on purpose. At most 8 names, each clipped to 40 characters, the
		// rest counted as "(+N more)" — an unbounded list on a 300-layer document
		// would bury the actual error. Non-ASCII characters in names are escaped
		// as \uXXXX: the Windows cscript stdout transport is codepage-bound and
		// flattens raw non-ASCII to '?' (measured live, PS 27.2.0 — a document
		// name of U+80CC U+666F arrived as '??'), while the escape survives any
		// transport losslessly and the list's reader is an LLM, which reads
		// \uXXXX fine. The list is for reading, not for matching against.
		//
		// The wording is load-bearing for telemetry. ERROR_CLASS_TABLE in
		// src/utils/session-log.ts classifies these messages, so "Have:" and
		// "(+N more)" must stay clear of every other class's pattern — see the
		// tier-order note in that file before changing this text.
		vault.NotFound: `
function __notFoundMessage(label, requested, groupsOnly) {
  var kept = [];
  var total = 0;
  function consider(layer) {
    total++;
    if (kept.length >= 8) return;
    var nm = String(layer.name);
    var esc = '';
    for (var c = 0; c < nm.length; c++) {
      var code = nm.charCodeAt(c);
      if (code >= 32 && code <= 126) {
        esc += nm.charAt(c);
      } else {
        var hex = code.toString(16);
        while (hex.length < 4) hex = '0' + hex;
        esc += '\\u' + hex;
      }
    }
    nm = esc;
    if (nm.length > 40) nm = nm.substring(0, 40) + '...';
    kept.push(nm);
  }
  var walkBroke = false;
  function walk(layers, depth) {
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      var isGroup = false;
      try { isGroup = (l instanceof LayerSet); } catch (eG) {}
      if (isGroup || !groupsOnly) consider(l);
      if (isGroup && depth < 32) {
        try { walk(l.layers, depth + 1); } catch (eD) { walkBroke = true; }
      }
    }
  }
  try { walk(app.activeDocument.layers, 0); } catch (eW) { walkBroke = true; }
  if (walkBroke && total === 0) {
    return label + ' not found: ' + requested;
  }
  var have;
  if (total === 0) {
    have = groupsOnly ? '(no groups)' : '(none)';
  } else {
    have = kept.join(', ');
    if (total > kept.length) have += ' (+' + (total - kept.length) + ' more)';
  }
  return label + ' not found: ' + requested + '. Have: ' + have;
}
`,

		// getPathInfo helper — path inventory (count + per-path kind/subpath/anchor
		// counts). The path analog of getSelectionInfo; interpolated into the
		// path-interchange snippets and called in their return. No param slots.
		vault.GPI: `
    function getPathInfo() {
      var __pidoc = app.activeDocument;
      var __ppaths = [];
      for (var __pi = 0; __pi < __pidoc.pathItems.length; __pi++) {
        var __pp = __pidoc.pathItems[__pi];
        var __pkind = 'normal';
        try {
          if (__pp.kind == PathKind.WORKPATH) { __pkind = 'work'; }
          else if (__pp.kind == PathKind.CLIPPINGPATH) { __pkind = 'clipping'; }
          else if (__pp.kind == PathKind.VECTORMASK) { __pkind = 'vector_mask'; }
        } catch (__pek) {}
        var __psub = 0;
        var __panch = 0;
        try {
          __psub = __pp.subPathItems.length;
          for (var __pj = 0; __pj < __pp.subPathItems.length; __pj++) {
            __panch += __pp.subPathItems[__pj].pathPoints.length;
          }
        } catch (__pes) {}
        __ppaths.push({ name: __pp.name, kind: __pkind, subpaths: __psub, anchors: __panch });
      }
      return { count: __pidoc.pathItems.length, paths: __ppaths };
    }
  `,
	})
}
