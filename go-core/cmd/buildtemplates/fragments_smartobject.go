package main

import "editmamei-core/internal/vault"

// Smart-filter fragments — read, toggle, re-blend and remove the filters stacked
// on a Smart Object.
//
// Photoshop addresses these two different ways, and the asymmetry is its own, not
// ours (verified live on PS 27.2.0, 2026-08-08):
//
//   - READ: the filter list hangs off the layer's `smartObject` compound
//     (layer -> smartObject -> filterFX[]), NOT a top-level layer key. Each entry
//     carries name / enabled / blendOptions{opacity,mode} / filter (whose CLASS is
//     the filter type, e.g. gaussianBlur) / filterID.
//   - WRITE: every op addresses ONE filter as a `filterFX` INDEX reference on the
//     target layer, and the index is 1-BASED while the read list is 0-based.
//     Measured mapping: write index N is read entry [N-1] — direct, not reversed.
//
// We expose ONE numbering to callers: 1-based, matching what op=list reports, so
// what you read is what you pass. Index 1 is the FIRST-APPLIED filter, which sits
// at the bottom of the Smart Filters stack in the Layers panel.
//
// Ground truth: m4a STEP-03 (apply) / STEP-04 (blendOptions setd) / STEP-05
// (Hd /Shw  visibility) / STEP-07 (Dlt ), plus the live structural probe above.
//
// Why every write validates first: PS answers an out-of-range index, a 0 index,
// AND a non-Smart-Object layer with the same useless "General Photoshop error
// occurred. This functionality may not be available in this version" — measured,
// all three. Left to Photoshop the caller cannot tell a typo from a wrong layer,
// so the guard resolves the list itself and throws something actionable.
func init() {
	addFragments(map[string]string{
		// Shared smart-filter helpers. No slots. Also carries the no-document
		// guard and active-layer resolution every one of the five fragments
		// below needs — hoisted here (2026-08-09) instead of five hand-copies.
		// fragments_prologue.go documents the production defect this EXACT
		// pattern of duplication (fourteen copies in the filter family alone)
		// caused: a fix to the guard had to be applied in every copy to land.
		// Five copies became one.
		vault.SFGuard: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var layer = app.activeDocument.activeLayer;

    // Blend modes: ONE table, used in both directions, so ps_smart_filter speaks
    // the same vocabulary as ps_set_layer / ps_set_group_blend_mode instead of
    // making the caller learn a second set of names for the same modes. Keys are
    // the ExtendScript BlendMode enum names (the canonical surface vocabulary,
    // src/utils/blend-modes.ts); values are the Action-Manager stringIDs the
    // filterFX blendOptions descriptor actually speaks. All 27 pairs were
    // round-trip verified against live PS 27.2.0 (set via stringIDToTypeID, read
    // back via typeIDToStringID, 27/27 exact) — this replaces the version-fragile
    // charID lore ('Scrn'/'Nrml'/...) rather than reproducing it.
    var __SF_MODES = {
      NORMAL: 'normal', DISSOLVE: 'dissolve', DARKEN: 'darken', MULTIPLY: 'multiply',
      COLORBURN: 'colorBurn', LINEARBURN: 'linearBurn', DARKERCOLOR: 'darkerColor',
      LIGHTEN: 'lighten', SCREEN: 'screen', COLORDODGE: 'colorDodge',
      LINEARDODGE: 'linearDodge', LIGHTERCOLOR: 'lighterColor', OVERLAY: 'overlay',
      SOFTLIGHT: 'softLight', HARDLIGHT: 'hardLight', VIVIDLIGHT: 'vividLight',
      LINEARLIGHT: 'linearLight', PINLIGHT: 'pinLight', HARDMIX: 'hardMix',
      DIFFERENCE: 'difference', EXCLUSION: 'exclusion', SUBTRACT: 'blendSubtraction',
      DIVIDE: 'blendDivide', HUE: 'hue', SATURATION: 'saturation',
      COLORBLEND: 'color', LUMINOSITY: 'luminosity'
    };

    function __sfAmMode(dom) {
      var am = __SF_MODES[dom];
      if (!am) throw new Error('Unknown blend mode: ' + dom);
      return am;
    }

    // Unknown values pass through as Photoshop's own name rather than being
    // coerced into a wrong one — a mode this build has not seen should read as
    // itself, not silently as NORMAL.
    function __sfDomMode(am) {
      for (var k in __SF_MODES) {
        if (__SF_MODES[k] === am) return k;
      }
      return am;
    }

    function __sfRead() {
      var ref = new ActionReference();
      ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
      var ld = executeActionGet(ref);
      var soKey = stringIDToTypeID('smartObject');
      if (!ld.hasKey(soKey)) return null;
      return __sfReadFrom(ld.getObjectValue(soKey));
    }

    // Parses the filter list out of an ALREADY-FETCHED smartObject compound.
    // Split out of __sfRead() so a caller that already holds the compound (e.g.
    // getSmartObjectInfo, which reads the layer descriptor for its own purposes
    // anyway) can reuse the parsing without a second, identical
    // executeActionGet round trip.
    function __sfReadFrom(so) {
      var fxKey = stringIDToTypeID('filterFX');
      if (!so.hasKey(fxKey)) return [];

      var lst = so.getList(fxKey);
      var fltrKey = charIDToTypeID('Fltr');
      var boKey = stringIDToTypeID('blendOptions');
      var out = [];
      for (var i = 0; i < lst.count; i++) {
        var e = lst.getObjectValue(i);
        var opacity = 100;
        var mode = 'normal';
        if (e.hasKey(boKey)) {
          var bo = e.getObjectValue(boKey);
          var opctKey = stringIDToTypeID('opacity');
          var modeKey = stringIDToTypeID('mode');
          if (bo.hasKey(opctKey)) opacity = bo.getUnitDoubleValue(opctKey);
          if (bo.hasKey(modeKey)) mode = typeIDToStringID(bo.getEnumerationValue(modeKey));
        }
        out.push({
          index: i + 1,
          name: e.hasKey(stringIDToTypeID('name')) ? e.getString(stringIDToTypeID('name')) : '',
          type: e.hasKey(fltrKey) ? typeIDToStringID(e.getClass(fltrKey)) : 'unknown',
          enabled: e.hasKey(stringIDToTypeID('enabled')) ? e.getBoolean(stringIDToTypeID('enabled')) : true,
          opacity: opacity,
          blend_mode: __sfDomMode(mode),
          filter_id: e.hasKey(stringIDToTypeID('filterID')) ? e.getInteger(stringIDToTypeID('filterID')) : -1
        });
      }
      return out;
    }

    // Resolves the filter list and validates index BEFORE touching Photoshop, so
    // the caller gets a message naming the actual problem instead of PS's generic
    // "General Photoshop error occurred" (which it returns for all three cases).
    function __sfTarget(index) {
      var layer = app.activeDocument.activeLayer;
      var filters = __sfRead();
      if (filters === null) {
        throw new Error('The active layer ("' + layer.name + '") is not a Smart Object, so it has no Smart Filters. Convert it first with ps_convert_to_smart_object.');
      }
      if (filters.length === 0) {
        throw new Error('The Smart Object "' + layer.name + '" has no Smart Filters yet. Apply one with ps_apply_filter using as_smart_filter=true.');
      }
      if (index < 1 || index > filters.length) {
        throw new Error('No Smart Filter at index ' + index + '. "' + layer.name + '" has ' + filters.length + ' (valid: 1-' + filters.length + ', where 1 is the first-applied filter at the bottom of the stack). Call ps_smart_filter op=list to see them.');
      }
      return filters;
    }

    function __sfRef(index) {
      var r = new ActionReference();
      r.putIndex(stringIDToTypeID('filterFX'), index);
      r.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
      return r;
    }
`,

		// listSmartFilters. Slots: 1=SFGuard helpers, 2=getMinimalContextInfo body.
		// Read-only. Distinguishes "not a Smart Object" (is_smart_object:false) from
		// "a Smart Object with an empty stack" (true, count 0) — the caller needs to
		// tell those apart to know whether to convert or to apply.
		vault.SFList: `
    %s
    %s

    var filters = __sfRead();

    return {
      is_smart_object: filters !== null,
      count: filters === null ? 0 : filters.length,
      filters: filters === null ? [] : filters,
      layer_name: layer.name,
      context: getMinimalContextInfo()
    };
  `,

		// setSmartFilterVisibility. Slots: 1=SFGuard, 2=getMinimalContextInfo,
		// 3=index literal, 4=enabled literal. Hd /Shw  on a filterFX index ref
		// (m4a STEP-05). Re-reads after the write so the reported state is
		// Photoshop's, not our assumption.
		vault.SFVis: `
    %s
    %s

    var index = %s;
    var enabled = %s;
    __sfTarget(index);

    var d = new ActionDescriptor();
    d.putReference(charIDToTypeID('null'), __sfRef(index));
    executeAction(charIDToTypeID(enabled ? 'Shw ' : 'Hd  '), d, DialogModes.NO);

    // Verified post-condition, not a hardcoded success flag: re-read the stack
    // and confirm the filter actually changed state. Photoshop can return
    // without error and leave visibility untouched, and a claimed success that
    // nothing checked is worse than an honest failure.
    var after = __sfRead();
    if (after === null || !after[index - 1]) {
      throw new Error('The write completed but "' + layer.name + '" no longer reads back as a Smart Object with a filter at index ' + index + ', so the result could not be verified.');
    }
    var entry = after[index - 1];
    if (entry.enabled !== enabled) {
      throw new Error('Photoshop reported no error, but Smart Filter ' + index + ' (' + entry.name + ') is still ' + (entry.enabled ? 'visible' : 'hidden') + '. The visibility change did not take.');
    }
    return {
      visibility_set: entry.enabled === enabled,
      index: index,
      requested_enabled: enabled,
      enabled: entry.enabled,
      filter_name: entry.name,
      filter_type: entry.type,
      layer_name: layer.name,
      context: getMinimalContextInfo()
    };
  `,

		// setSmartFilterBlend. Slots: 1=SFGuard, 2=getMinimalContextInfo, 3=index,
		// 4=opacity block (or empty), 5=mode block (or empty). The setd carries ONLY
		// blendOptions: verified live that this preserves the filter's own parameters
		// (a gaussianBlur kept radius=5 across the write) and leaves sibling filters
		// untouched, so no read-modify-write of the filter body is needed. Omitting a
		// key leaves that property alone, which is why the blocks are conditional.
		vault.SFBlend: `
    %s
    %s

    var index = %s;
    __sfTarget(index);

    // The emitted blocks below assign these alongside the descriptor keys, so
    // the verification checks exactly what was asked for and stays silent about
    // the half the caller left alone.
    var __expectOpacity = null;
    var __expectMode = null;

    var bo = new ActionDescriptor();
    %s
    %s

    var fx = new ActionDescriptor();
    fx.putObject(stringIDToTypeID('blendOptions'), stringIDToTypeID('blendOptions'), bo);

    var d = new ActionDescriptor();
    d.putReference(charIDToTypeID('null'), __sfRef(index));
    d.putObject(stringIDToTypeID('filterFX'), stringIDToTypeID('filterFX'), fx);
    executeAction(charIDToTypeID('setd'), d, DialogModes.NO);

    // Verified post-condition. Opacity is compared with a tolerance because
    // Photoshop stores it as a percentage double and rounds on the way back.
    var after = __sfRead();
    if (after === null || !after[index - 1]) {
      throw new Error('The write completed but "' + layer.name + '" no longer reads back as a Smart Object with a filter at index ' + index + ', so the result could not be verified.');
    }
    var entry = after[index - 1];
    if (__expectMode !== null && entry.blend_mode !== __expectMode) {
      throw new Error('Photoshop reported no error, but Smart Filter ' + index + ' is still in ' + entry.blend_mode + ' (asked for ' + __expectMode + '). The blend change did not take.');
    }
    if (__expectOpacity !== null && Math.abs(entry.opacity - __expectOpacity) > 0.5) {
      throw new Error('Photoshop reported no error, but Smart Filter ' + index + ' is still at ' + entry.opacity + ' opacity (asked for ' + __expectOpacity + '). The blend change did not take.');
    }
    return {
      index: index,
      opacity: entry.opacity,
      blend_mode: entry.blend_mode,
      filter_name: entry.name,
      filter_type: entry.type,
      layer_name: layer.name,
      context: getMinimalContextInfo()
    };
  `,

		// removeSmartFilter. Slots: 1=SFGuard, 2=getContextInfo, 3=index literal.
		// Dlt  on a filterFX index ref (m4a STEP-07). Removes something (changes
		// what exists), so it carries the FULL context block — unlike the other
		// four smart-filter fragments, which only read or toggle state and use
		// getMinimalContextInfo. Reports the removed filter's identity (captured
		// before the delete) plus the remaining count.
		vault.SFDel: `
    %s
    %s

    var index = %s;
    var before = __sfTarget(index);
    var removed = before[index - 1];

    var d = new ActionDescriptor();
    d.putReference(charIDToTypeID('null'), __sfRef(index));
    executeAction(charIDToTypeID('Dlt '), d, DialogModes.NO);

    // Verified post-condition: the stack must actually be one shorter. A Dlt
    // that silently no-ops would otherwise be reported as a successful removal.
    var after = __sfRead();
    var remaining = after === null ? 0 : after.length;
    var expected = before.length - 1;
    if (remaining !== expected) {
      throw new Error('Photoshop reported no error, but "' + layer.name + '" still has ' + remaining + ' Smart Filter(s) instead of ' + expected + '. The filter was not removed.');
    }
    return {
      removed: remaining === expected,
      index: index,
      removed_filter_name: removed.name,
      removed_filter_type: removed.type,
      remaining_count: remaining,
      layer_name: layer.name,
      context: getContextInfo()
    };
  `,

		// getSmartObjectInfo. Slots: 1=SFGuard, 2=getMinimalContextInfo. Read-only.
		// Keys measured off the live smartObject compound: placed (enum), documentID,
		// compsList, linked (bool), fileReference, filterFX. `linked` distinguishes a
		// LINKED Smart Object (fileReference points at a file on disk that PS reads
		// through) from an EMBEDDED one (the source lives inside the PSD) — the
		// distinction that decides whether replacing the source affects other docs.
		vault.SOInfo: `
    %s
    %s

    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    var ld = executeActionGet(ref);
    var soKey = stringIDToTypeID('smartObject');

    if (!ld.hasKey(soKey)) {
      return {
        is_smart_object: false,
        layer_name: layer.name,
        layer_kind: String(layer.kind),
        context: getMinimalContextInfo()
      };
    }

    var so = ld.getObjectValue(soKey);
    var filters = __sfReadFrom(so);
    var linkedKey = stringIDToTypeID('linked');
    var fileRefKey = stringIDToTypeID('fileReference');
    var docIDKey = stringIDToTypeID('documentID');
    var placedKey = stringIDToTypeID('placed');

    var info = {
      is_smart_object: true,
      linked: so.hasKey(linkedKey) ? so.getBoolean(linkedKey) : false,
      file_reference: null,
      document_id: null,
      placed: null,
      smart_filter_count: filters === null ? 0 : filters.length,
      layer_name: layer.name,
      context: getMinimalContextInfo()
    };

    // Each of these three throws if the stored type differs from what the
    // getter expects (a malformed/unusual Smart Object entry can have a key
    // present but not shaped the way getString/getEnumerationValue want), so
    // each gets its own try/catch defaulting to null — same style as bounds
    // below — rather than letting one bad field fail the whole read.
    try {
      info.file_reference = so.hasKey(fileRefKey) ? so.getString(fileRefKey) : null;
    } catch (eF) {
      info.file_reference = null;
    }

    try {
      info.document_id = so.hasKey(docIDKey) ? so.getString(docIDKey) : null;
    } catch (eD) {
      info.document_id = null;
    }

    try {
      info.placed = so.hasKey(placedKey) ? typeIDToStringID(so.getEnumerationValue(placedKey)) : null;
    } catch (eP) {
      info.placed = null;
    }

    try {
      var b = layer.bounds;
      info.bounds = [b[0].as('px'), b[1].as('px'), b[2].as('px'), b[3].as('px')];
    } catch (eB) {
      info.bounds = null;
    }

    return info;
  `,
	})
}
