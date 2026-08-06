package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// setLayerOpacityFull — sets fillOpacity (the "Fill" slider, distinct from
		// opacity) and optionally opacity in the same call. Slots:
		// 1=getMinimalContextInfo, 2=layerResolveHelpers, 3=opacity verify block
		// (empty-opacity variant when not setting opacity), 4=fillOpacity value.
		// Ground truth confirmed via ScriptListener capture (setd fillOpacity).
		// Phase 2 (2026-07): independent re-resolve + retry + hard-error on
		// persistent mismatch for BOTH fillOpacity (always) and opacity (when
		// present) — see vault.LayerResolve. No TS twin (Go-only snippet), so no
		// golden-parity obligation here.
		vault.SetFillOp: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    function __quantizeOpacityPercent(percent) {
      // Photoshop stores opacity/fillOpacity as an internal 0-255 byte and
      // reads back the round-tripped percentage (e.g. 35%% -> byte 89 ->
      // 34.9019607843137%%). Compute the same byte-quantized expected
      // readback so verification compares like-for-like instead of
      // raw-percent-vs-quantized-percent, which would false-negative on
      // ~every request not already aligned to the 1/255 grid.
      var quantizedByte = Math.round(percent / 100 * 255);
      return Math.round((quantizedByte / 255 * 100) * 100) / 100;
    }

    var __identity = __captureLayerIdentity(doc, layer);

    %s

    var __requestedFill = %s;
    var __expectedFill = __quantizeOpacityPercent(__requestedFill);

    layer.fillOpacity = __requestedFill;

    var __freshFill = __resolveLayerFreshOrActive(doc, __identity);
    var __actualFill = __freshFill ? Math.round(__freshFill.fillOpacity * 100) / 100 : undefined;
    var __verifiedFill = (__actualFill === __expectedFill);

    if (!__verifiedFill) {
      layer.fillOpacity = __requestedFill;
      __freshFill = __resolveLayerFreshOrActive(doc, __identity);
      __actualFill = __freshFill ? Math.round(__freshFill.fillOpacity * 100) / 100 : undefined;
      __verifiedFill = (__actualFill === __expectedFill);
    }

    if (!__verifiedFill) {
      throw new Error('Layer fillOpacity write did not verify: requested ' + __requestedFill + ' (expected readback ' + __expectedFill + '), actual ' + __actualFill + ' (after 1 retry)');
    }

    return {
      property: 'fillOpacity',
      fill_opacity: __actualFill,
      requested_fill_opacity: __requestedFill,
      fill_opacity_verified: __verifiedFill,
      opacity: __actualOpacity,
      requested_opacity: __requestedOpacity,
      opacity_verified: __verifiedOpacity,
      layerName: layer.name,
      context: getMinimalContextInfo()
    };
  `,

		// setLayerOpacity. Slots: 1=helper, 2=layerResolveHelpers, 3=requested
		// opacity value. Phase 2 (2026-07): independent re-resolve + retry +
		// hard-error on persistent mismatch, quantization-aware (see
		// __quantizeOpacityPercent) so a legitimate write doesn't false-negative
		// on the 0-255 internal opacity grid. TS twin: layer-properties.ts
		// setLayerOpacity — must move in lockstep (golden-pinned).
		vault.SetOpacity: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    function __quantizeOpacityPercent(percent) {
      // Photoshop stores opacity as 0-255 internally and reads back the
      // round-trip value (e.g. setting 35 yields 34.9019607843137 because
      // 35 = 89.25/255). Compute the same byte-quantized expected readback
      // so verification compares like-for-like instead of
      // raw-percent-vs-quantized-percent, which would false-negative on
      // ~every request not already aligned to the 1/255 grid.
      var quantizedByte = Math.round(percent / 100 * 255);
      return Math.round((quantizedByte / 255 * 100) * 100) / 100;
    }

    var __requested = %s;
    var __expected = __quantizeOpacityPercent(__requested);
    var __identity = __captureLayerIdentity(doc, layer);

    layer.opacity = __requested;

    var __fresh = __resolveLayerFreshOrActive(doc, __identity);
    var __actual = __fresh ? Math.round(__fresh.opacity * 100) / 100 : undefined;
    var __verified = (__actual === __expected);

    if (!__verified) {
      layer.opacity = __requested;
      __fresh = __resolveLayerFreshOrActive(doc, __identity);
      __actual = __fresh ? Math.round(__fresh.opacity * 100) / 100 : undefined;
      __verified = (__actual === __expected);
    }

    if (!__verified) {
      throw new Error('Layer opacity write did not verify: requested ' + __requested + ' (expected readback ' + __expected + '), actual ' + __actual + ' (after 1 retry)');
    }

    var result = {
      property: 'opacity',
      value: __actual,
      requested: __requested,
      verified: __verified,
      layerName: layer.name,
      context: getMinimalContextInfo()
    };
    return result;
  `,

		// setLayerBlendMode. Slots: 1=helper, 2=layerResolveHelpers, 3=blendMode
		// (raw enum name). Phase 2 (2026-07): independent re-resolve + retry +
		// hard-error on persistent mismatch. TS twin: layer-properties.ts
		// setLayerBlendMode — must move in lockstep (golden-pinned).
		vault.SetBlend: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    var __identity = __captureLayerIdentity(doc, layer);
    var __blendModeEnum = BlendMode.%s; // enum allow-listed in setLayerBlendMode (Go)
    var __requested = String(__blendModeEnum);

    layer.blendMode = __blendModeEnum;

    var __fresh = __resolveLayerFreshOrActive(doc, __identity);
    var __actual = __fresh ? String(__fresh.blendMode) : undefined;
    var __verified = (__actual === __requested);

    if (!__verified) {
      layer.blendMode = __blendModeEnum;
      __fresh = __resolveLayerFreshOrActive(doc, __identity);
      __actual = __fresh ? String(__fresh.blendMode) : undefined;
      __verified = (__actual === __requested);
    }

    if (!__verified) {
      throw new Error('Layer blend mode write did not verify: requested ' + __requested + ', actual ' + __actual + ' (after 1 retry)');
    }

    var result = {
      property: 'blendMode',
      value: __actual,
      requested: __requested,
      verified: __verified,
      layerName: layer.name,
      context: getMinimalContextInfo()
    };
    return result;
  `,

		// setLayerVisibility. Slots: 1=helper, 2=layerResolveHelpers, 3=visible.
		// Phase 2 (2026-07): independent re-resolve + retry + hard-error on
		// persistent mismatch — this is the fragment the incident traced back
		// to (a group hide that reported clean success and did not land). TS
		// twin: layer-properties.ts setLayerVisibility — must move in lockstep
		// (golden-pinned).
		//
		// Live-verification correction (2026-07): the first cut of this
		// fragment compared against __fresh.visible (DOM), which is EFFECTIVE
		// visibility (parent-chain AND own flag) regardless of proxy — for any
		// layer inside a hidden group this can never match a `visible: true`
		// request, so the retry always exhausted and the tool hard-errored on
		// a legitimate write. `layer.visible = x` sets the OWN flag, so the
		// own flag (read via Action Manager's Vsbl property, keyed by the
		// layer's stable id) is the correct thing to compare against.
		vault.SetVis: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    function __readOwnVisible(layerId) {
      // layer.visible on the DOM is EFFECTIVE visibility no matter which
      // proxy reads it; only Action Manager exposes the layer's own flag.
      var r = new ActionReference();
      r.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('Vsbl'));
      r.putIdentifier(app.charIDToTypeID('Lyr '), layerId);
      return app.executeActionGet(r).getBoolean(app.charIDToTypeID('Vsbl'));
    }

    // F5 (2026-07 QA review): getContextInfo already guards this identical
    // AM read with a try/catch that degrades gracefully; this setter's
    // verification step must degrade the same way instead of letting the
    // exception escape as a hard error on a write that may have landed — an
    // unreadable verification is not the same thing as a genuine mismatch.
    function __safeReadOwnVisible(layerId) {
      if (typeof layerId === 'undefined') return undefined;
      try { return __readOwnVisible(layerId); }
      catch (eRead) { return undefined; }
    }

    var __requested = %s;
    var __identity = __captureLayerIdentity(doc, layer);

    layer.visible = __requested;

    var __fresh = __resolveLayerFreshOrActive(doc, __identity);
    var __actual = __fresh ? __safeReadOwnVisible(__fresh.id) : undefined;
    var __verified = (__actual === __requested);

    if (!__verified) {
      layer.visible = __requested;
      __fresh = __resolveLayerFreshOrActive(doc, __identity);
      __actual = __fresh ? __safeReadOwnVisible(__fresh.id) : undefined;
      __verified = (__actual === __requested);
    }

    if (!__verified && __fresh && __actual === undefined) {
      // The layer resolved but the own-flag verification READ itself
      // failed/degraded (AM read threw, or the layer has no readable id) —
      // that is not proof the write failed, just that we couldn't confirm
      // it. Degrade to unverified rather than hard-erroring a write that
      // may well have landed.
      return {
        visible: __requested,
        requested: __requested,
        verified: false,
        verification_unreadable: true,
        name: layer.name,
        context: getMinimalContextInfo()
      };
    }

    if (!__verified) {
      throw new Error('Layer visibility write did not verify: requested ' + __requested + ', actual ' + __actual + ' (after 1 retry)');
    }

    return {
      visible: __actual,
      requested: __requested,
      verified: __verified,
      name: layer.name,
      context: getMinimalContextInfo()
    };
  `,

		// setLayerLocked. Slots: 1=helper, 2=layerResolveHelpers, 3=locked.
		// Phase 2 (2026-07): independent re-resolve + retry + hard-error on
		// persistent mismatch. TS twin: layer-properties.ts setLayerLocked —
		// must move in lockstep (golden-pinned).
		vault.SetLock: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    var __requested = %s;
    var __identity = __captureLayerIdentity(doc, layer);

    layer.allLocked = __requested;

    var __fresh = __resolveLayerFreshOrActive(doc, __identity);
    var __actual = __fresh ? __fresh.allLocked : undefined;
    var __verified = (__actual === __requested);

    if (!__verified) {
      layer.allLocked = __requested;
      __fresh = __resolveLayerFreshOrActive(doc, __identity);
      __actual = __fresh ? __fresh.allLocked : undefined;
      __verified = (__actual === __requested);
    }

    if (!__verified) {
      throw new Error('Layer locked write did not verify: requested ' + __requested + ', actual ' + __actual + ' (after 1 retry)');
    }

    return {
      locked: __actual,
      requested: __requested,
      verified: __verified,
      name: layer.name,
      context: getMinimalContextInfo()
    };
  `,

		// renameLayer. Slots: 1=helper, 2=layerResolveHelpers, 3=newName (jsLit).
		// Phase 2 (2026-07): independent re-resolve + retry + hard-error on
		// persistent mismatch. Identity is captured via layer.id / index-path
		// BEFORE the rename — matching by name (the thing being changed) would
		// be circular, so this fragment never does that. TS twin:
		// layer-properties.ts renameLayer — must move in lockstep (golden-pinned).
		vault.Rename: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    var oldName = layer.name;
    var __requested = %s;
    var __identity = __captureLayerIdentity(doc, layer);

    layer.name = __requested;

    var __fresh = __resolveLayerFreshOrActive(doc, __identity);
    var __actual = __fresh ? __fresh.name : undefined;
    var __verified = (__actual === __requested);

    if (!__verified) {
      layer.name = __requested;
      __fresh = __resolveLayerFreshOrActive(doc, __identity);
      __actual = __fresh ? __fresh.name : undefined;
      __verified = (__actual === __requested);
    }

    // F7 (2026-07 QA review): non-ASCII layer names round-trip lossily
    // through Photoshop's ExtendScript layer naming (confirmed live:
    // non-ASCII variants read back with '?' substitutions). The rename
    // genuinely did not verify — that error stands — but detect the
    // non-ASCII case and say so explicitly instead of leaving the caller
    // to guess at the cause from a generic mismatch message.
    if (!__verified) {
      throw new Error('Layer rename did not verify: requested ' + __requested + ', actual ' + __actual + ' (after 1 retry)' + (/[^\x00-\x7F]/.test(__requested) ? '. The requested name contains non-ASCII characters, which can round-trip lossily through Photoshop\'s ExtendScript layer naming (accented letters or other special characters may be replaced with "?"). Try an ASCII-only name.' : ''));
    }

    return {
      oldName: oldName,
      newName: __actual,
      requested: __requested,
      verified: __verified,
      context: getMinimalContextInfo()
    };
  `,

		// selectLayer. Slots: 1=normNameHelper, 2=getContextInfo, 3=name(jsLit),
		// 4=name(jsLit).
		vault.SelectLayer: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    // normName: hyphen/em-dash/en-dash normalization + whitespace collapse
    // + case-insensitive. Matches the policy in moveLayerToGroup so an
    // LLM that wrote "Mtn Sharpen" finds a layer created with a dash variant.
    // See Bug I in the 2026-05-30 PS 27.x cross-platform bug roster.
    var targetNorm = normName(%s);

    // Depth cap is defense-in-depth. PS limits group nesting in practice
    // but a malformed PSD could theoretically blow ExtendScript's stack.
    function findLayerByName(layers, depth) {
      if (depth === undefined) depth = 0;
      if (depth > 32) return null;
      for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        if (normName(layer.name) === targetNorm) return layer;
        var isGroup = false;
        try { isGroup = (layer instanceof LayerSet); } catch (e) {}
        if (isGroup) {
          try {
            var found = findLayerByName(layer.layers, depth + 1);
            if (found) return found;
          } catch (e) {}
        }
      }
      return null;
    }

    var found = findLayerByName(doc.layers);
    if (!found) {
      throw new Error('Layer not found: ' + %s);
    }
    doc.activeLayer = found;

    return {
      selected: true,
      name: found.name,
      kind: String(found.kind),
      context: getContextInfo()
    };
  `,

		// rasterizeLayer. Slots: 1=getContextInfo body (the two getContextInfo()
		// in the returns are calls into that one interpolated definition).
		vault.RasterizeLayer: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var layer = app.activeDocument.activeLayer;

    if (layer.kind === LayerKind.NORMAL) {
      return {
        message: 'Layer is already rasterized',
        kind: 'NORMAL',
        context: getContextInfo()
      };
    }

    var originalKind = String(layer.kind);
    layer.rasterize(RasterizeType.ENTIRELAYER);

    return {
      rasterized: true,
      originalKind: originalKind,
      newKind: 'NORMAL',
      context: getContextInfo()
    };
  `,

		// addLayerStyle. Slots (27): 1=helperFunctions, 2=getContextInfo,
		// 3=styleType(jsLit, drop_shadow if), 4..6=c.r/g/b, 7=opacity, 8=angle,
		// 9=distance, 10=spread, 11=size, 12=styleType(jsLit, stroke elif),
		// 13=strokePosEnum(jsLit), 14=opacity, 15=strokeSize, 16..18=c.r/g/b,
		// 19=styleType(jsLit, outer_glow elif), 20..22=c.r/g/b, 23=opacity,
		// 24=glowSpread, 25=glowSize, 26=styleType(jsLit, else), 27=styleType
		// (jsLit, result). The 50%%/0%% in the OrGl comment are escaped literals.
		vault.AddLayerStyle: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    if (layer.isBackgroundLayer) {
      throw new Error('Cannot apply layer style to a background layer. Convert it to a normal layer first.');
    }

    function rgbColor(red, green, blue) {
      var c = new ActionDescriptor();
      c.putDouble(cTID('Rd  '), red);
      c.putDouble(cTID('Grn '), green);
      c.putDouble(cTID('Bl  '), blue);
      return c;
    }

    var d = new ActionDescriptor();
    var r = new ActionReference();
    r.putProperty(cTID('Prpr'), cTID('Lefx'));
    r.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    d.putReference(cTID('null'), r);

    var lefx = new ActionDescriptor();
    lefx.putUnitDouble(cTID('Scl '), cTID('#Prc'), 100);

    if (%s === 'drop_shadow') {
      var ds = new ActionDescriptor();
      ds.putBoolean(cTID('enab'), true);
      // Schema completeness per the spec (2026-06-04 audit Group C STEP
      // 27): present + showInDialog + layerConceals match the captured
      // descriptor surface. layerConceals=true is PS's UI default — the
      // shadow does not show through the layer's own pixels.
      ds.putBoolean(sTID('present'), true);
      ds.putBoolean(sTID('showInDialog'), true);
      ds.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Mltp'));
      ds.putObject(cTID('Clr '), cTID('RGBC'), rgbColor(%s, %s, %s));
      ds.putUnitDouble(cTID('Opct'), cTID('#Prc'), %s);
      // uglg=false (unlink global angle) is an intentional Editmamei
      // design: the caller-supplied angle stays local to this layer and
      // is not subject to the document-wide global-light setting.
      ds.putBoolean(cTID('uglg'), false);
      ds.putUnitDouble(cTID('lagl'), cTID('#Ang'), %s);
      ds.putUnitDouble(cTID('Dstn'), cTID('#Pxl'), %s);
      ds.putUnitDouble(cTID('Ckmt'), cTID('#Prc'), %s);
      ds.putUnitDouble(cTID('blur'), cTID('#Pxl'), %s);
      ds.putUnitDouble(cTID('Nose'), cTID('#Prc'), 0);
      ds.putBoolean(cTID('AntA'), false);
      ds.putBoolean(sTID('layerConceals'), true);
      lefx.putObject(cTID('DrSh'), cTID('DrSh'), ds);
    } else if (%s === 'stroke') {
      var st = new ActionDescriptor();
      st.putBoolean(cTID('enab'), true);
      // Schema completeness per spec STEP 28.
      st.putBoolean(sTID('present'), true);
      st.putBoolean(sTID('showInDialog'), true);
      st.putEnumerated(cTID('Styl'), cTID('FStl'), cTID(%s));
      st.putEnumerated(cTID('PntT'), cTID('FrFl'), cTID('SClr'));
      st.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Nrml'));
      st.putUnitDouble(cTID('Opct'), cTID('#Prc'), %s);
      st.putUnitDouble(cTID('Sz  '), cTID('#Pxl'), %s);
      st.putObject(cTID('Clr '), cTID('RGBC'), rgbColor(%s, %s, %s));
      st.putBoolean(sTID('overprint'), false);
      lefx.putObject(cTID('FrFX'), cTID('FrFX'), st);
    } else if (%s === 'outer_glow') {
      var og = new ActionDescriptor();
      og.putBoolean(cTID('enab'), true);
      // Schema completeness per spec STEP 29.
      og.putBoolean(sTID('present'), true);
      og.putBoolean(sTID('showInDialog'), true);
      og.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Scrn'));
      og.putObject(cTID('Clr '), cTID('RGBC'), rgbColor(%s, %s, %s));
      og.putUnitDouble(cTID('Opct'), cTID('#Prc'), %s);
      og.putUnitDouble(cTID('Nose'), cTID('#Prc'), 0);
      og.putEnumerated(cTID('GlwT'), cTID('BETE'), cTID('SfBL'));
      og.putUnitDouble(cTID('Ckmt'), cTID('#Prc'), %s);
      og.putUnitDouble(cTID('blur'), cTID('#Pxl'), %s);
      // Spec-required (STEP 29 audit): Inpr (Range slider) and ShdN
      // (shading noise) are BOTH putUnitDouble with percentUnit, NOT
      // putInteger. PS UI defaults are 50%% and 0%% respectively.
      og.putUnitDouble(cTID('Inpr'), cTID('#Prc'), 50);
      og.putUnitDouble(cTID('ShdN'), cTID('#Prc'), 0);
      lefx.putObject(cTID('OrGl'), cTID('OrGl'), og);
    } else {
      throw new Error('Unknown style type: ' + %s);
    }

    d.putObject(cTID('T   '), cTID('Lefx'), lefx);
    executeAction(cTID('setd'), d, DialogModes.NO);

    return {
      applied: true,
      style: %s,
      layerName: layer.name,
      context: getContextInfo()
    };
  `,

		// AddLayerStyle2 — the m4b layer-style additions (inner_shadow/inner_glow/
		// color_overlay) on a SEPARATE fragment so the migration golden for the
		// original drop_shadow/stroke/outer_glow stays frozen. Self-contained.
		// Slots: 1=helperFunctions, 2=getContextInfo, then per branch
		// (styleType + color x3 + opacity [+ shape params]): inner_shadow (9),
		// inner_glow (7), color_overlay (5), then else styleType, result styleType.
		vault.AddLayerStyle2: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    if (layer.isBackgroundLayer) {
      throw new Error('Cannot apply layer style to a background layer. Convert it to a normal layer first.');
    }

    function rgbColor(red, green, blue) {
      var c = new ActionDescriptor();
      c.putDouble(cTID('Rd  '), red);
      c.putDouble(cTID('Grn '), green);
      c.putDouble(cTID('Bl  '), blue);
      return c;
    }

    var d = new ActionDescriptor();
    var r = new ActionReference();
    r.putProperty(cTID('Prpr'), cTID('Lefx'));
    r.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    d.putReference(cTID('null'), r);

    var lefx = new ActionDescriptor();
    lefx.putUnitDouble(cTID('Scl '), cTID('#Prc'), 100);

    if (%s === 'inner_shadow') {
      var is = new ActionDescriptor();
      is.putBoolean(cTID('enab'), true);
      is.putBoolean(sTID('present'), true);
      is.putBoolean(sTID('showInDialog'), true);
      is.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Mltp'));
      is.putObject(cTID('Clr '), cTID('RGBC'), rgbColor(%s, %s, %s));
      is.putUnitDouble(cTID('Opct'), cTID('#Prc'), %s);
      is.putBoolean(cTID('uglg'), false);
      is.putUnitDouble(cTID('lagl'), cTID('#Ang'), %s);
      is.putUnitDouble(cTID('Dstn'), cTID('#Pxl'), %s);
      is.putUnitDouble(cTID('Ckmt'), cTID('#Prc'), %s);
      is.putUnitDouble(cTID('blur'), cTID('#Pxl'), %s);
      is.putUnitDouble(cTID('Nose'), cTID('#Prc'), 0);
      is.putBoolean(cTID('AntA'), false);
      lefx.putObject(cTID('IrSh'), cTID('IrSh'), is);
    } else if (%s === 'inner_glow') {
      var ig = new ActionDescriptor();
      ig.putBoolean(cTID('enab'), true);
      ig.putBoolean(sTID('present'), true);
      ig.putBoolean(sTID('showInDialog'), true);
      ig.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Scrn'));
      ig.putObject(cTID('Clr '), cTID('RGBC'), rgbColor(%s, %s, %s));
      ig.putUnitDouble(cTID('Opct'), cTID('#Prc'), %s);
      ig.putUnitDouble(cTID('Nose'), cTID('#Prc'), 0);
      ig.putEnumerated(cTID('GlwT'), cTID('BETE'), cTID('SfBL'));
      ig.putUnitDouble(cTID('Ckmt'), cTID('#Prc'), %s);
      ig.putUnitDouble(cTID('blur'), cTID('#Pxl'), %s);
      ig.putUnitDouble(cTID('Inpr'), cTID('#Prc'), 50);
      ig.putUnitDouble(cTID('ShdN'), cTID('#Prc'), 0);
      lefx.putObject(cTID('IrGl'), cTID('IrGl'), ig);
    } else if (%s === 'color_overlay') {
      var co = new ActionDescriptor();
      co.putBoolean(cTID('enab'), true);
      co.putBoolean(sTID('present'), true);
      co.putBoolean(sTID('showInDialog'), true);
      co.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Nrml'));
      co.putObject(cTID('Clr '), cTID('RGBC'), rgbColor(%s, %s, %s));
      co.putUnitDouble(cTID('Opct'), cTID('#Prc'), %s);
      lefx.putObject(cTID('SoFi'), cTID('SoFi'), co);
    } else {
      throw new Error('Unknown style type: ' + %s);
    }

    d.putObject(cTID('T   '), cTID('Lefx'), lefx);
    executeAction(cTID('setd'), d, DialogModes.NO);

    return {
      applied: true,
      style: %s,
      layerName: layer.name,
      context: getContextInfo()
    };
  `,
	})
}
