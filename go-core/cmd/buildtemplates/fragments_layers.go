package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// newLayer. Slots: 1=parentPathHelper, 2=getContextInfo, 3=name assignment
		// line (or empty). Phase 4: doc.artLayers.add() is DOM and does NOT nest
		// inside an active group (measured live) — parent_path is reported for
		// consistency/observability, no hoist needed.
		vault.NewLayer: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.artLayers.add();
    %s

    var result = {
      created: true,
      layerName: layer.name,
      parent_path: __parentPathOf(doc, layer),
      context: getContextInfo()
    };
    return result;
  `,

		// deleteLayer outer. Slots: 1=getContextInfo, 2=branch block (named or
		// active, built by the emitter).
		vault.DeleteLayer: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    %s
  `,

		// deleteLayer — named branch. Slots: 1=normNameHelper,
		// 2=notFoundMessageHelper, 3=name(jsLit), 4=name(jsLit).
		//
		// The name must resolve to an ART LAYER, never a group. remove() on a
		// LayerSet takes the whole subtree with it and still reports a plain
		// success, so one over-matched name silently destroys layers the caller
		// never named — and every later delete aimed at one of those children
		// then fails as "not found", which makes the cause look like the
		// symptom. Deleting a group is ps_group(op=delete)'s job. groupNameMatch
		// remembers the first group whose name matched so the error can say so
		// rather than claim the name does not exist; its wording carries the
		// "layer kind" phrase ERROR_CLASS_TABLE (src/utils/session-log.ts)
		// classifies on, and that table hoists the phrase above the tiers whose
		// patterns a user-chosen group name could otherwise match.
		vault.DelLayerNamed: `
    %s
    %s
    var targetNorm = normName(%s);
    var groupNameMatch = null;
    function findLayerByName(layers, depth) {
      if (depth === undefined) depth = 0;
      if (depth > 32) return null;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        var isGroup = false;
        try { isGroup = (l instanceof LayerSet); } catch (e) {}
        // Em-dash / en-dash tolerant comparison (Bug I). The LLM
        // routinely swaps these silently — raw equality would miss.
        var nameMatches = (normName(l.name) === targetNorm);
        // Art layers only — a group is never a delete target (see Go comment).
        if (nameMatches && !isGroup) return l;
        if (nameMatches && isGroup && groupNameMatch === null) groupNameMatch = l.name;
        if (isGroup) {
          try {
            var found = findLayerByName(l.layers, depth + 1);
            if (found) return found;
          } catch (e) {}
        }
      }
      return null;
    }

    var target = findLayerByName(doc.layers);
    if (!target) {
      if (groupNameMatch !== null) {
        // "layer kind" is load-bearing: ERROR_CLASS_TABLE in
        // src/utils/session-log.ts classifies on it, and this is a
        // wrong_layer_kind, not a layer_not_found — the name exists.
        throw new Error('Cannot delete "' + groupNameMatch + '": that name is a group, not an art layer (layer kind mismatch). Use ps_group(op=delete) to delete a group and its contents.');
      }
      throw new Error(__notFoundMessage('Layer', %s, false));
    }
    var deletedName = target.name;
    target.remove();
    return { deleted: true, layerName: deletedName, context: getContextInfo() };
    `,

		// deleteLayer — active-layer branch. No slots.
		vault.DelLayerActive: `
    if (doc.activeLayer) {
      var deletedName = doc.activeLayer.name;
      doc.activeLayer.remove();
      return { deleted: true, layerName: deletedName, context: getContextInfo() };
    }
    throw new Error('No active layer');
    `,

		// fillLayer. Slots: 1=red, 2=green, 3=blue (color), 4=red, 5=green,
		// 6=blue (result). No context (pure setter).
		vault.FillLayer: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    if (layer.allLocked) {
      throw new Error('Cannot fill a fully locked layer: ' + layer.name);
    }
    if (layer.kind === LayerKind.TEXT) {
      throw new Error('Cannot fill a text layer. Rasterize it first.');
    }

    var color = new SolidColor();
    color.rgb.red = %s;
    color.rgb.green = %s;
    color.rgb.blue = %s;

    // doc.selection.bounds throws "No such element" with no active selection,
    // and that error is NOT catchable over the COM bridge in PS 2024+. Query
    // the ActionManager instead, which never throws.
    var hadSelection = (function () {
      var ref = new ActionReference();
      ref.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('fsel'));
      ref.putEnumerated(app.charIDToTypeID('Dcmn'), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
      return app.executeActionGet(ref).hasKey(app.charIDToTypeID('fsel'));
    })();

    if (!hadSelection) {
      doc.selection.selectAll();
    }
    doc.selection.fill(color);
    if (!hadSelection) {
      doc.selection.deselect();
    }

    return {
      filled: true,
      layerName: layer.name,
      color: { red: %s, green: %s, blue: %s }
    };
  `,

		// duplicateLayer. Slots: 1=parentPathHelper, 2=getContextInfo,
		// 3=newName assignment (or empty). Phase 4: layer.duplicate() is DOM and
		// is parent-preserving by DOM semantics (the copy stays wherever the
		// original was) — parent_path is reported for observability, no hoist
		// needed (there's nothing to correct).
		vault.DupLayer: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    var duplicated = layer.duplicate();
    %s

    // Ensure the new duplicate is the active layer. PS's DOM duplicate()
    // does normally make the new layer active, but in some COM-bridged
    // calls the active-layer ref stays on the original; force it.
    try { doc.activeLayer = duplicated; } catch (e) {}

    return {
      originalName: layer.name,
      newName: duplicated.name,
      activeLayer: doc.activeLayer.name,
      parent_path: __parentPathOf(doc, duplicated),
      context: getContextInfo()
    };
  `,

		// mergeVisibleLayers. Slots: 1=getContextInfo.
		vault.MergeVis: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    doc.mergeVisibleLayers();

    return {
      merged: true,
      context: getContextInfo()
    };
  `,

		// stampVisible. Slots: 1=getContextInfo.
		vault.StampVis: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var beforeLayerCount = doc.layers.length;
    var originalActiveName = doc.activeLayer.name;

    try {
      var desc = new ActionDescriptor();
      desc.putBoolean(charIDToTypeID('Dplc'), true);
      executeAction(charIDToTypeID('MrgV'), desc, DialogModes.NO);
    } catch (eRun) {
      // Common runtime failures: no visible layers (PS rejects the event),
      // active layer is a group with masking that breaks the merge
      // pipeline, or some smart-object descendant blocks. Surface PS's
      // own message so the LLM can recover.
      throw new Error('Stamp Visible failed: ' + eRun.message);
    }

    return {
      stamped: true,
      new_layer_name: doc.activeLayer.name,
      original_active_layer_name: originalActiveName,
      layer_count_before: beforeLayerCount,
      layer_count_after: doc.layers.length,
      context: getContextInfo()
    };
  `,

		// layerViaCopy — "Layer via Copy" (Ctrl+J). Copies the current selection
		// (or the whole active layer when nothing is selected) to a new layer above
		// it; the original is untouched and the new copy becomes active.
		// Parameterless AM event (CpTL) on the live selection. Slots:
		// 1=parentPathHelper, 2=hoistFromActiveGroupHelper, 3=getContextInfo,
		// 4=into_active_group(jsBool). Phase 4 (layer-placement bug): CpTL, like
		// the other bare-Mk/AM creators, has no target reference, so with a
		// group active PS nests the new layer INSIDE it.
		// __hoistFromActiveGroupIfNeeded moves it back out to a sibling of that
		// group by default; into_active_group:true keeps PS's native nesting.
		//
		// F9 (2026-07 QA review): before/after counts use __countLayersRecursive
		// (in scope via getContextInfo — see LayerCountRecursive), not
		// doc.layers.length, which only counts TOP-LEVEL entries. With
		// into_active_group:true the new layer lands INSIDE an existing group,
		// so doc.layers.length doesn't change and the old shallow comparison
		// reported copied_to_new_layer:false on a successful copy.
		vault.LayerViaCopy: `
    %s
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var beforeLayerCount = __countLayersRecursive(doc.layers);
    var __preMkActive = doc.activeLayer;
    var originalActiveName = __preMkActive.name;

    try {
      executeAction(charIDToTypeID('CpTL'), undefined, DialogModes.NO);
    } catch (eRun) {
      // CpTL fails when there is nothing copyable (e.g. an empty selection
      // over a layer with no pixels, or a non-pixel active layer). Surface
      // PS's own message so the LLM can recover.
      throw new Error('Layer via Copy failed: ' + eRun.message);
    }

    var __newLayer = doc.activeLayer;
    var __intoActiveGroup = %s;
    var __hoisted = __hoistFromActiveGroupIfNeeded(doc, __preMkActive, __newLayer, __intoActiveGroup);
    var afterLayerCount = __countLayersRecursive(doc.layers);

    return {
      copied_to_new_layer: afterLayerCount > beforeLayerCount,
      new_layer_name: __newLayer.name,
      original_active_layer_name: originalActiveName,
      layer_count_before: beforeLayerCount,
      layer_count_after: afterLayerCount,
      hoisted: __hoisted,
      parent_path: __parentPathOf(doc, __newLayer),
      context: getContextInfo()
    };
  `,

		// bakeLayer — flatten the active layer's ADJUSTED appearance (the layer + the
		// adjustment layers clipped to it + its layer styles) into a NEW pixel layer,
		// originals intact. Implemented as hide-all / show the clip group / stamp
		// (MrgV+Dplc) / restore visibility — no capture; reuses the proven stamp
		// mechanism. The decided desaturate/invert path: clip a Hue/Sat (-100) or an
		// Invert adjustment, then bake. Slots: 1=getContextInfo.
		//
		// Single-layer clip group (the active layer has nothing clipped to it): Merge
		// Visible needs >=2 visible layers, so with only the base showing PS rejects
		// MrgV with "Merge Visible is not currently available". In that case bake the
		// layer on its own — duplicate it and rasterize its full appearance (styles /
		// smart-object / text content) into a flat pixel layer (LayerSet base merges).
		vault.BakeLayer: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var base = doc.activeLayer;
    var sourceName = base.name;

    // Collect every layer (recursive) to save + restore visibility.
    var __all = [];
    function __collect(c) {
      for (var i = 0; i < c.layers.length; i++) {
        var ly = c.layers[i];
        __all.push(ly);
        if (ly.typename === 'LayerSet') { __collect(ly); }
      }
    }
    __collect(doc);

    // The active layer must be top-level for the clip-group walk below.
    var top = doc.layers;
    var bi = -1;
    for (var i = 0; i < top.length; i++) { if (top[i] === base) { bi = i; break; } }
    if (bi === -1) {
      throw new Error('bake_layer supports a top-level active layer (the active layer is inside a group).');
    }

    // Clip group = base + the consecutive clipped (grouped) layers directly above
    // it. doc.layers[0] is topmost, so clipped layers sit at lower indices.
    var group = [base];
    for (var i = bi - 1; i >= 0; i--) {
      if (top[i].grouped) { group.push(top[i]); } else { break; }
    }

    var savedVis = [];
    for (var i = 0; i < __all.length; i++) { savedVis.push(__all[i].visible); }

    var baked = null;
    try {
      for (var i = 0; i < __all.length; i++) { __all[i].visible = false; }
      for (var i = 0; i < group.length; i++) { group[i].visible = true; }
      doc.activeLayer = base;

      if (group.length === 1) {
        // Nothing for Merge Visible to merge (PS rejects MrgV on <2 visible
        // layers). Bake the lone layer = duplicate + rasterize its appearance.
        base.duplicate();
        baked = doc.activeLayer;
        if (baked.typename === 'LayerSet') {
          baked = baked.merge();
        } else {
          try { baked.rasterize(RasterizeType.ENTIRE); } catch (eRz) {}
        }
      } else {
        var mvDesc = new ActionDescriptor();
        mvDesc.putBoolean(charIDToTypeID('Dplc'), true);
        executeAction(charIDToTypeID('MrgV'), mvDesc, DialogModes.NO);
        baked = doc.activeLayer;
      }
      baked.name = sourceName + ' (baked)';
    } catch (eRun) {
      throw new Error('Bake layer failed: ' + eRun.message);
    } finally {
      for (var i = 0; i < __all.length; i++) {
        try { __all[i].visible = savedVis[i]; } catch (eV) {}
      }
    }

    return {
      baked: true,
      baked_layer_name: baked ? baked.name : null,
      source_layer_name: sourceName,
      clipped_layers_baked: group.length - 1,
      context: getContextInfo()
    };
  `,

		// addFillLayer — Mk contentLayer / solidColorLayer with an RGBC color.
		// Slots: 1=parentPathHelper, 2=hoistFromActiveGroupHelper, 3=getContextInfo,
		// 4=r, 5=g, 6=b, 7=into_active_group(jsBool), 8=r, 9=g, 10=b.
		// Ground truth confirmed via ScriptListener capture.
		// Phase 4 (layer-placement bug): the Mk descriptor below carries no
		// target reference, so with a group active PS nests the new fill layer
		// INSIDE it. __hoistFromActiveGroupIfNeeded moves it back out to a
		// sibling of that group by default; into_active_group:true keeps PS's
		// native nesting.
		vault.AddFillLayer: `
    %s
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var __preMkActive = doc.activeLayer;

    var mkDesc = new ActionDescriptor();
    var mkRef = new ActionReference();
    mkRef.putClass(stringIDToTypeID('contentLayer'));
    mkDesc.putReference(charIDToTypeID('null'), mkRef);
    var usingDesc = new ActionDescriptor();
    var typeDesc = new ActionDescriptor();
    var colorDesc = new ActionDescriptor();
    colorDesc.putDouble(charIDToTypeID('Rd  '), %s);
    colorDesc.putDouble(charIDToTypeID('Grn '), %s);
    colorDesc.putDouble(charIDToTypeID('Bl  '), %s);
    typeDesc.putObject(charIDToTypeID('Clr '), charIDToTypeID('RGBC'), colorDesc);
    usingDesc.putObject(charIDToTypeID('Type'), stringIDToTypeID('solidColorLayer'), typeDesc);
    mkDesc.putObject(charIDToTypeID('Usng'), stringIDToTypeID('contentLayer'), usingDesc);
    executeAction(charIDToTypeID('Mk  '), mkDesc, DialogModes.NO);

    var __newLayer = doc.activeLayer;
    var __intoActiveGroup = %s;
    var __hoisted = __hoistFromActiveGroupIfNeeded(doc, __preMkActive, __newLayer, __intoActiveGroup);

    return {
      created: true,
      fill_type: 'solid_color',
      color: { red: %s, green: %s, blue: %s },
      layer_name: __newLayer.name,
      hoisted: __hoisted,
      parent_path: __parentPathOf(doc, __newLayer),
      context: getContextInfo()
    };
  `,

		// flattenImage. Slots: 1=getContextInfo.
		vault.FlattenImg: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    doc.flatten();

    return {
      flattened: true,
      context: getContextInfo()
    };
  `,

		// convertToSmartObject (l8). Slot: 1=getContextInfo body.
		// Uses executeAction(stringIDToTypeID('newPlacedLayer'), ...) — the standard
		// AM event that wraps the active layer into a Smart Object. Works on pixel,
		// text, shape, and adjustment layers. Auto-promotes the background layer
		// so it can be wrapped (consistent with the layer-transform pattern).
		// VERIFIED: newPlacedLayer event confirmed by ScriptListener capture on
		// PS 27.x Windows in addition to broad practitioner
		// consensus. Tier: community.
		vault.ConvertToSO: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var layer = app.activeDocument.activeLayer;

    var backgroundPromoted = false;
    if (layer.isBackgroundLayer) {
      try {
        layer.isBackgroundLayer = false;
        backgroundPromoted = true;
      } catch (eBg) {
        throw new Error('Could not promote background layer: ' + (eBg.message || String(eBg)));
      }
    }

    var originalKind = String(layer.kind);
    var wasAlreadySmartObject = (layer.kind === LayerKind.SMARTOBJECT);

    executeAction(stringIDToTypeID('newPlacedLayer'), undefined, DialogModes.NO);

    var converted = app.activeDocument.activeLayer;
    var isSmartObject = (converted.kind === LayerKind.SMARTOBJECT);

    return {
      layer_name: converted.name,
      is_smart_object: isSmartObject,
      original_kind: originalKind,
      was_already_smart_object: wasAlreadySmartObject,
      background_promoted: backgroundPromoted,
      context: getContextInfo()
    };
  `,

		// newSmartObjectViaCopy (l12) — "New Smart Object via Copy": makes a NEW smart
		// object that is an INDEPENDENT copy (its own embedded source), unlinked from the
		// original SO's shared source — so editing the copy's contents does NOT propagate
		// to the original (unlike ps_duplicate_layer of an SO, which keeps the shared
		// source). Event placedLayerMakeCopy (parameterless). Ground truth: ScriptListener capture
		// (PS 27.x Windows). REQUIRES the active layer already be a smart object — throws
		// a clear error otherwise. Slot: 1=getContextInfo body.
		vault.SONewViaCopy: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var layer = app.activeDocument.activeLayer;
    if (layer.kind !== LayerKind.SMARTOBJECT) {
      throw new Error('new_via_copy requires a Smart Object layer (active layer kind is ' + String(layer.kind) + '). Convert it first with ps_convert_to_smart_object mode=convert.');
    }

    executeAction(stringIDToTypeID('placedLayerMakeCopy'), undefined, DialogModes.NO);

    var copied = app.activeDocument.activeLayer;
    return {
      layer_name: copied.name,
      is_smart_object: (copied.kind === LayerKind.SMARTOBJECT),
      source_unlinked: true,
      context: getContextInfo()
    };
  `,

		// createShape (l13) — Mk contentLayer: a real vector SHAPE layer, geometry baked
		// in ABSOLUTE document pixels. Ground truth: ScriptListener capture (rectangle/rounded =
		// Rctn bounds + 4 corner radii), ellipse (Elps bounds), line (
		// Ln Strt/End + Wdth + arrowheads off). All wrap in Usng:contentLayer{ Type:
		// solidColorLayer{fill}, Shp:<geometry>, strokeStyle{...} }. Slots (in order):
		// 1=parentPathHelper, 2=hoistFromActiveGroupHelper, 3=getContextInfo,
		// 4=type(jsLit), 5=top, 6=left, 7=bottom, 8=right, 9=cornerRadius,
		// 10=startX, 11=startY, 12=endX, 13=endY, 14=weight, 15=fillR, 16=fillG,
		// 17=fillB, 18=strokeWidth, 19=strokeR, 20=strokeG, 21=strokeB,
		// 22=into_active_group(jsBool). Phase 4 (layer-placement bug): the Mk
		// descriptor below carries no target reference, so with a group active
		// PS nests the new shape layer INSIDE it. __hoistFromActiveGroupIfNeeded
		// moves it back out to a sibling of that group by default;
		// into_active_group:true keeps PS's native nesting.
		vault.CreateShape: `
    %s
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var __preMkActive = doc.activeLayer;

    var __type = %s;
    var __top = %s, __left = %s, __bottom = %s, __right = %s, __radius = %s;
    var __sx = %s, __sy = %s, __ex = %s, __ey = %s, __weight = %s;
    var __fr = %s, __fg = %s, __fb = %s;
    var __strokeW = %s, __sr = %s, __sg = %s, __sb = %s;

    function c(x) { return app.charIDToTypeID(x); }
    function s(x) { return app.stringIDToTypeID(x); }
    function __rgb(r, g, b) {
      var d = new ActionDescriptor();
      d.putDouble(c('Rd  '), r);
      d.putDouble(c('Grn '), g);
      d.putDouble(c('Bl  '), b);
      return d;
    }
    function __pt(x, y) {
      var d = new ActionDescriptor();
      d.putUnitDouble(c('Hrzn'), c('#Pxl'), x);
      d.putUnitDouble(c('Vrtc'), c('#Pxl'), y);
      return d;
    }
    function __noArrow() {
      var a = new ActionDescriptor();
      a.putDouble(c('Wdth'), 5);
      a.putDouble(c('Lngt'), 10);
      a.putUnitDouble(c('Cncv'), c('#Prc'), 0);
      a.putBoolean(c('On  '), false);
      return a;
    }

    var __shp = new ActionDescriptor();
    var __shpClass;
    if (__type === 'rectangle' || __type === 'ellipse') {
      __shp.putInteger(s('unitValueQuadVersion'), 1);
      __shp.putUnitDouble(c('Top '), c('#Pxl'), __top);
      __shp.putUnitDouble(c('Left'), c('#Pxl'), __left);
      __shp.putUnitDouble(c('Btom'), c('#Pxl'), __bottom);
      __shp.putUnitDouble(c('Rght'), c('#Pxl'), __right);
      if (__type === 'rectangle') {
        __shp.putUnitDouble(s('topRight'), c('#Pxl'), __radius);
        __shp.putUnitDouble(s('topLeft'), c('#Pxl'), __radius);
        __shp.putUnitDouble(s('bottomLeft'), c('#Pxl'), __radius);
        __shp.putUnitDouble(s('bottomRight'), c('#Pxl'), __radius);
        __shpClass = c('Rctn');
      } else {
        __shpClass = c('Elps');
      }
    } else {
      __shp.putObject(c('Strt'), c('Pnt '), __pt(__sx, __sy));
      __shp.putObject(c('End '), c('Pnt '), __pt(__ex, __ey));
      __shp.putUnitDouble(c('Wdth'), c('#Pxl'), __weight);
      __shp.putObject(c('StrA'), c('cArw'), __noArrow());
      __shp.putObject(c('EndA'), c('cArw'), __noArrow());
      __shpClass = c('Ln  ');
    }

    var __ss = new ActionDescriptor();
    __ss.putInteger(s('strokeStyleVersion'), 2);
    __ss.putBoolean(s('strokeEnabled'), __strokeW > 0);
    __ss.putBoolean(s('fillEnabled'), true);
    __ss.putUnitDouble(s('strokeStyleLineWidth'), c('#Pxl'), __strokeW > 0 ? __strokeW : 1);
    __ss.putUnitDouble(s('strokeStyleLineDashOffset'), c('#Pnt'), 0);
    __ss.putDouble(s('strokeStyleMiterLimit'), 100);
    __ss.putEnumerated(s('strokeStyleLineCapType'), s('strokeStyleLineCapType'), s('strokeStyleButtCap'));
    __ss.putEnumerated(s('strokeStyleLineJoinType'), s('strokeStyleLineJoinType'), s('strokeStyleMiterJoin'));
    __ss.putEnumerated(s('strokeStyleLineAlignment'), s('strokeStyleLineAlignment'), s('strokeStyleAlignCenter'));
    __ss.putBoolean(s('strokeStyleScaleLock'), false);
    __ss.putBoolean(s('strokeStyleStrokeAdjust'), false);
    __ss.putList(s('strokeStyleLineDashSet'), new ActionList());
    __ss.putEnumerated(s('strokeStyleBlendMode'), c('BlnM'), c('Nrml'));
    __ss.putUnitDouble(s('strokeStyleOpacity'), c('#Prc'), 100);
    var __ssContent = new ActionDescriptor();
    __ssContent.putObject(c('Clr '), c('RGBC'), __rgb(__sr, __sg, __sb));
    __ss.putObject(s('strokeStyleContent'), s('solidColorLayer'), __ssContent);
    __ss.putDouble(s('strokeStyleResolution'), 72);

    var __using = new ActionDescriptor();
    var __typeDesc = new ActionDescriptor();
    __typeDesc.putObject(c('Clr '), c('RGBC'), __rgb(__fr, __fg, __fb));
    __using.putObject(c('Type'), s('solidColorLayer'), __typeDesc);
    __using.putObject(c('Shp '), __shpClass, __shp);
    __using.putObject(s('strokeStyle'), s('strokeStyle'), __ss);

    var __mk = new ActionDescriptor();
    var __ref = new ActionReference();
    __ref.putClass(s('contentLayer'));
    __mk.putReference(c('null'), __ref);
    __mk.putObject(c('Usng'), s('contentLayer'), __using);
    app.executeAction(c('Mk  '), __mk, DialogModes.NO);

    var __layer = doc.activeLayer;
    var __intoActiveGroup = %s;
    var __hoisted = __hoistFromActiveGroupIfNeeded(doc, __preMkActive, __layer, __intoActiveGroup);
    return {
      shape_created: true,
      shape_type: __type,
      layer_name: __layer.name,
      stroked: __strokeW > 0,
      hoisted: __hoisted,
      parent_path: __parentPathOf(doc, __layer),
      context: getContextInfo()
    };
  `,
	})
}
