package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// moveLayerToPosition. Slots: 1=getContextInfo, 2=position(jsLit),
		// 3=normNameHelper, 4=notFoundMessageHelper, 5=layerToMove block,
		// 6=targetLayer block (ABOVE/BELOW), 7=relativeTo value. Blocks 5-7 are
		// built by the emitter per the optional names.
		vault.MoveToPos: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var position = %s;

    // Recursive search so we can find layers nested in groups by name.
    // Depth cap is defense-in-depth (see selectLayer's identical comment).
    // Em-dash / en-dash tolerant comparison (Bug I) via normName — the LLM
    // routinely swaps these silently; raw equality would miss. This fn is
    // reused for both the layer-to-move and target-layer lookups (like
    // moveLayerToGroup's layer/group pair), so the wanted name is passed
    // in pre-normalized by the caller rather than baked into a closure.
    %s
    %s
    function findLayerByName(layers, wantedNorm, depth) {
      if (depth === undefined) depth = 0;
      if (depth > 32) return null;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (normName(l.name) === wantedNorm) return l;
        var isGroup = false;
        try { isGroup = (l instanceof LayerSet); } catch (e) {}
        if (isGroup) {
          try {
            var found = findLayerByName(l.layers, wantedNorm, depth + 1);
            if (found) return found;
          } catch (e) {}
        }
      }
      return null;
    }

    // Which layer is being MOVED? If layerToMoveName is given, look it up
    // by name; otherwise default to the active layer (legacy behaviour).
    var layerToMove = null;
    %s

    // For TOP / BOTTOM we don't need a target layer reference — move uses
    // the document's top-level container directly. ABOVE / BELOW require
    // a target_layer_name.
    if (position === "TOP" || position === "BOTTOM") {
      if (doc.layers.length === 0) {
        throw new Error('Document has no layers');
      }
      var anchor = (position === "TOP") ? doc.layers[0] : doc.layers[doc.layers.length - 1];
      var placement = (position === "TOP")
        ? ElementPlacement.PLACEBEFORE
        : ElementPlacement.PLACEAFTER;
      // If the layer-to-move IS the anchor, nothing to do.
      if (layerToMove !== anchor) {
        layerToMove.move(anchor, placement);
      }
      return {
        moved: true,
        layerName: layerToMove.name,
        position: position,
        context: getContextInfo()
      };
    }

    // ABOVE / BELOW path — needs an explicit target.
    if (position !== "ABOVE" && position !== "BELOW") {
      throw new Error('Invalid position. Use: ABOVE, BELOW, TOP, or BOTTOM');
    }
    %s
    var placement = (position === "ABOVE")
      ? ElementPlacement.PLACEBEFORE
      : ElementPlacement.PLACEAFTER;
    layerToMove.move(targetLayer, placement);

    return {
      moved: true,
      layerName: layerToMove.name,
      position: position,
      relativeTo: %s,
      context: getContextInfo()
    };
  `,

		// layer-transform family (move/rotate/scale/fit). Community tier
		// (previously Pro, in fragments_pro.go). Slot orders
		// documented at each emitter in go-core/layer_transform.go.
		vault.LtFit: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    if (layer.isBackgroundLayer) {
      throw new Error('Cannot transform background layer');
    }

    // Get canvas dimensions
    var canvasWidth = doc.width.as('px');
    var canvasHeight = doc.height.as('px');

    // Get layer bounds
    var bounds = layer.bounds;
    var layerWidth = bounds[2].as('px') - bounds[0].as('px');
    var layerHeight = bounds[3].as('px') - bounds[1].as('px');

    // Calculate scale ratios
    var widthRatio = canvasWidth / layerWidth;
    var heightRatio = canvasHeight / layerHeight;

    // Choose scale factor based on fill or fit mode
    var scaleFactor;
    if (%s) {
      // Fill: scale to cover entire canvas (may crop)
      scaleFactor = Math.max(widthRatio, heightRatio);
    } else {
      // Fit: scale to fit within canvas (may have margins)
      scaleFactor = Math.min(widthRatio, heightRatio);
    }

    // Apply scale
    var scalePercent = scaleFactor * 100;
    layer.resize(scalePercent, scalePercent, AnchorPosition.MIDDLECENTER);

    // Center the layer
    layer.translate(
      canvasWidth / 2 - (bounds[0].as('px') + layerWidth / 2),
      canvasHeight / 2 - (bounds[1].as('px') + layerHeight / 2)
    );

    var result = {
      fitted: true,
      mode: %s ? 'fill' : 'fit',
      originalSize: { width: layerWidth, height: layerHeight },
      newSize: {
        width: layerWidth * scaleFactor,
        height: layerHeight * scaleFactor
      },
      scaleFactor: scaleFactor,
      scalePercent: scalePercent,
      context: getContextInfo()
    };
    return result;
  `,

		vault.LtScale: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    // Auto-promote background instead of throwing. Returned
    // as background_promoted so the caller sees the side-effect.
    var __backgroundPromoted = false;
    if (layer.isBackgroundLayer) {
      try {
        layer.isBackgroundLayer = false;
        __backgroundPromoted = true;
      } catch (eBg) {
        throw new Error('Could not promote background layer: ' + eBg.message);
      }
    }

    var anchor = %s;
    layer.resize(%s, %s, anchor);

    return {
      scaled: true,
      percent: %s,
      background_promoted: __backgroundPromoted
    };
  `,

		// scaleLayerXY — non-uniform scale. Mirrors LtScale but takes independent
		// x/y percentages. Slots: 1=anchor, 2=scaleX, 3=scaleY, 4=scaleX, 5=scaleY.
		vault.LtScaleXY: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    var __backgroundPromoted = false;
    if (layer.isBackgroundLayer) {
      try {
        layer.isBackgroundLayer = false;
        __backgroundPromoted = true;
      } catch (eBg) {
        throw new Error('Could not promote background layer: ' + eBg.message);
      }
    }

    var anchor = %s;
    layer.resize(%s, %s, anchor);

    return {
      scaled: true,
      scale_x_percent: %s,
      scale_y_percent: %s,
      background_promoted: __backgroundPromoted
    };
  `,

		// flipLayer — AM Flip on the target layer. Auto-promotes background.
		// Slots: 1=axis charID (Hrzn/Vrtc), 2=axis(jsLit).
		// Ground truth confirmed via ScriptListener capture.
		vault.LtFlip: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    var __backgroundPromoted = false;
    if (layer.isBackgroundLayer) {
      try {
        layer.isBackgroundLayer = false;
        __backgroundPromoted = true;
      } catch (eBg) {
        throw new Error('Could not promote background layer: ' + eBg.message);
      }
    }

    var flipDesc = new ActionDescriptor();
    var flipRef = new ActionReference();
    flipRef.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    flipDesc.putReference(charIDToTypeID('null'), flipRef);
    flipDesc.putEnumerated(charIDToTypeID('Axis'), charIDToTypeID('Ornt'), charIDToTypeID('%s'));
    executeAction(charIDToTypeID('Flip'), flipDesc, DialogModes.NO);

    return {
      flipped: true,
      axis: %s,
      background_promoted: __backgroundPromoted
    };
  `,

		// transformLayerMatrix — AM Trnf on the active layer (Lyr/Ordn/Trgt). Skew
		// (mode=skew, conditional Skew Pnt obj) and free-numeric (mode=free) differ
		// only by that sub-object. Auto-promotes the background.
		// Slots: 1=Ofst Hrzn, 2=Ofst Vrtc, 3=Wdth #Prc, 4=Hght #Prc, 5=skew block,
		// 6=Angl #Ang, 7=mode(jsLit), 8=scaleX, 9=scaleY, 10=rotate, 11=skewH, 12=skewV.
		vault.LtMatrix: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    var __backgroundPromoted = false;
    if (layer.isBackgroundLayer) {
      try {
        layer.isBackgroundLayer = false;
        __backgroundPromoted = true;
      } catch (eBg) {
        throw new Error('Could not promote background layer: ' + eBg.message);
      }
    }

    var trnfDesc = new ActionDescriptor();
    var trnfRef = new ActionReference();
    trnfRef.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    trnfDesc.putReference(charIDToTypeID('null'), trnfRef);
    trnfDesc.putEnumerated(charIDToTypeID('FTcs'), charIDToTypeID('QCSt'), charIDToTypeID('Qcsa'));
    var mOfst = new ActionDescriptor();
    mOfst.putUnitDouble(charIDToTypeID('Hrzn'), charIDToTypeID('#Pxl'), %s);
    mOfst.putUnitDouble(charIDToTypeID('Vrtc'), charIDToTypeID('#Pxl'), %s);
    trnfDesc.putObject(charIDToTypeID('Ofst'), charIDToTypeID('Ofst'), mOfst);
    trnfDesc.putUnitDouble(charIDToTypeID('Wdth'), charIDToTypeID('#Prc'), %s);
    trnfDesc.putUnitDouble(charIDToTypeID('Hght'), charIDToTypeID('#Prc'), %s);
    %s
    trnfDesc.putUnitDouble(charIDToTypeID('Angl'), charIDToTypeID('#Ang'), %s);
    trnfDesc.putEnumerated(charIDToTypeID('Intr'), charIDToTypeID('Intp'), charIDToTypeID('Bcbc'));
    executeAction(charIDToTypeID('Trnf'), trnfDesc, DialogModes.NO);

    return {
      transformed: true,
      mode: %s,
      scale_x_percent: %s,
      scale_y_percent: %s,
      rotate_degrees: %s,
      skew_h_degrees: %s,
      skew_v_degrees: %s,
      background_promoted: __backgroundPromoted
    };
  `,

		// warpLayer — AM Trnf carrying a nested warp obj (preset envelope warp).
		// bounds is COMPUTED from the live layer.bounds (the warp envelope rect);
		// uOrder=4/vOrder=2 are constants emitted verbatim. Auto-promotes the
		// background. Slots: 1=warpStyle, 2=warpValue(bend),
		// 3=warpPerspective(hDistort), 4=warpPerspectiveOther(vDistort),
		// 5=warpRotate orientation charID, 6=style(jsLit), 7=bend, 8=hDistort,
		// 9=vDistort, 10=orientation(jsLit).
		vault.WarpPreset: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    var __backgroundPromoted = false;
    if (layer.isBackgroundLayer) {
      try {
        layer.isBackgroundLayer = false;
        __backgroundPromoted = true;
      } catch (eBg) {
        throw new Error('Could not promote background layer: ' + eBg.message);
      }
    }

    var wb = layer.bounds;
    var wL = wb[0].as('px'), wT = wb[1].as('px'), wR = wb[2].as('px'), wB = wb[3].as('px');

    var trnfDesc = new ActionDescriptor();
    var trnfRef = new ActionReference();
    trnfRef.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    trnfDesc.putReference(charIDToTypeID('null'), trnfRef);
    trnfDesc.putEnumerated(charIDToTypeID('FTcs'), charIDToTypeID('QCSt'), charIDToTypeID('Qcsa'));
    var wOfst = new ActionDescriptor();
    wOfst.putUnitDouble(charIDToTypeID('Hrzn'), charIDToTypeID('#Pxl'), 0);
    wOfst.putUnitDouble(charIDToTypeID('Vrtc'), charIDToTypeID('#Pxl'), 0);
    trnfDesc.putObject(charIDToTypeID('Ofst'), charIDToTypeID('Ofst'), wOfst);
    trnfDesc.putBoolean(charIDToTypeID('Lnkd'), true);
    var warpDesc = new ActionDescriptor();
    warpDesc.putEnumerated(stringIDToTypeID('warpStyle'), stringIDToTypeID('warpStyle'), stringIDToTypeID('%s'));
    warpDesc.putDouble(stringIDToTypeID('warpValue'), %s);
    warpDesc.putDouble(stringIDToTypeID('warpPerspective'), %s);
    warpDesc.putDouble(stringIDToTypeID('warpPerspectiveOther'), %s);
    warpDesc.putEnumerated(stringIDToTypeID('warpRotate'), charIDToTypeID('Ornt'), charIDToTypeID('%s'));
    var wBounds = new ActionDescriptor();
    wBounds.putDouble(charIDToTypeID('Top '), wT);
    wBounds.putDouble(charIDToTypeID('Left'), wL);
    wBounds.putDouble(charIDToTypeID('Btom'), wB);
    wBounds.putDouble(charIDToTypeID('Rght'), wR);
    warpDesc.putObject(stringIDToTypeID('bounds'), stringIDToTypeID('classFloatRect'), wBounds);
    warpDesc.putInteger(stringIDToTypeID('uOrder'), 4);
    warpDesc.putInteger(stringIDToTypeID('vOrder'), 2);
    trnfDesc.putObject(stringIDToTypeID('warp'), stringIDToTypeID('warp'), warpDesc);
    trnfDesc.putEnumerated(charIDToTypeID('Intr'), charIDToTypeID('Intp'), charIDToTypeID('Bcbc'));
    executeAction(charIDToTypeID('Trnf'), trnfDesc, DialogModes.NO);

    return {
      warped: true,
      warp_style: %s,
      bend: %s,
      h_distort: %s,
      v_distort: %s,
      orientation: %s,
      background_promoted: __backgroundPromoted
    };
  `,

		// warpMesh — AM Trnf carrying a quiltWarp custom mesh (a grid of Bezier
		// control points in document pixels). Unlike the preset envelope warp, a
		// custom mesh can PIN one edge (hold its control column/row at the home grid)
		// while deforming the rest — so the warp is welded to that edge by
		// construction (verified by reading back layer.bounds). Ground truth:
		// Ground truth: ScriptListener capture (quilt structure: deformNumCols =
		// 3*cells+1, evenly-spaced home grid, slices at cell boundaries, meshPoints
		// row-major). Two drive modes, both feeding ONE control grid into the same
		// quilt descriptor: high-level (compute the grid from pin_edge + lift +
		// bend_at + sharpness + taper) or raw (mesh_points supplied verbatim).
		// Slots: 1=pin_edge(jsLit), 2=NCX(cells), 3=NCY(cells), 4=lift, 5=bend_at,
		// 6=sharpness, 7=taper, 8=raw grid literal ([[x,y],...] row-major) or 'null'.
		vault.WarpMesh: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    var __backgroundPromoted = false;
    if (layer.isBackgroundLayer) {
      try {
        layer.isBackgroundLayer = false;
        __backgroundPromoted = true;
      } catch (eBg) {
        throw new Error('Could not promote background layer: ' + eBg.message);
      }
    }

    var mb = layer.bounds;
    var L = mb[0].as('px'), T = mb[1].as('px'), R = mb[2].as('px'), B = mb[3].as('px');

    var PIN = %s;
    var NCX = %s, NCY = %s;
    var NCOLS = 3 * NCX + 1, NROWS = 3 * NCY + 1;
    var LIFT = %s, BEND_AT = %s, SHARP = %s, TAPER = %s;
    var RAW = %s;

    function lerp(a, z, t) { return a + (z - a) * t; }
    function clamp01(t) { return t < 0 ? 0 : (t > 1 ? 1 : t); }

    var horiz = (PIN === 'left' || PIN === 'right');

    var GRID = [];
    if (RAW) {
      if (RAW.length !== NCOLS * NROWS) {
        throw new Error('warpMesh: mesh_points length ' + RAW.length + ' != cols*rows ' + (NCOLS * NROWS));
      }
      GRID = RAW;
    } else {
      var alongNear, alongFar, crossMin, crossMax;
      if (PIN === 'left') { alongNear = L; alongFar = R; crossMin = T; crossMax = B; }
      else if (PIN === 'right') { alongNear = R; alongFar = L; crossMin = T; crossMax = B; }
      else if (PIN === 'top') { alongNear = T; alongFar = B; crossMin = L; crossMax = R; }
      else { alongNear = B; alongFar = T; crossMin = L; crossMax = R; }
      var crossC = (crossMin + crossMax) / 2;
      var alongAtBend = lerp(alongNear, alongFar, BEND_AT);
      var p = 1 + SHARP * 3;
      for (var rj = 0; rj < NROWS; rj++) {
        for (var ci = 0; ci < NCOLS; ci++) {
          var a = ci / (NCOLS - 1);
          var c = rj / (NROWS - 1);
          var ar = clamp01((a - BEND_AT) / (1 - BEND_AT));
          var rise = LIFT * Math.pow(ar, p);
          var along = (a <= BEND_AT) ? lerp(alongNear, alongFar, a)
                                     : lerp(alongAtBend, lerp(alongNear, alongFar, a), 1 - SHARP);
          var tap = 1 - (1 - TAPER) * ar;
          var crossPos = crossC + (lerp(crossMin, crossMax, c) - crossC) * tap + rise;
          if (horiz) { GRID.push([along, crossPos]); }
          else { GRID.push([crossPos, along]); }
        }
      }
    }

    var meshList = new ActionList();
    for (var k = 0; k < GRID.length; k++) {
      var mp = new ActionDescriptor();
      mp.putUnitDouble(charIDToTypeID('Hrzn'), charIDToTypeID('#Pxl'), GRID[k][0]);
      mp.putUnitDouble(charIDToTypeID('Vrtc'), charIDToTypeID('#Pxl'), GRID[k][1]);
      meshList.putObject(stringIDToTypeID('rationalPoint'), mp);
    }
    var sxList = new ActionList();
    for (var si = 0; si <= NCX; si++) {
      var sxd = new ActionDescriptor();
      sxd.putUnitDouble(stringIDToTypeID('quiltSliceX'), charIDToTypeID('#Pxl'), lerp(L, R, (si * 3) / (NCOLS - 1)));
      sxList.putObject(charIDToTypeID('UntF'), sxd);
    }
    var syList = new ActionList();
    for (var sj = 0; sj <= NCY; sj++) {
      var syd = new ActionDescriptor();
      syd.putUnitDouble(stringIDToTypeID('quiltSliceY'), charIDToTypeID('#Pxl'), lerp(T, B, (sj * 3) / (NROWS - 1)));
      syList.putObject(charIDToTypeID('UntF'), syd);
    }
    var envD = new ActionDescriptor();
    envD.putList(stringIDToTypeID('quiltSliceX'), sxList);
    envD.putList(stringIDToTypeID('quiltSliceY'), syList);
    envD.putList(stringIDToTypeID('meshPoints'), meshList);

    function frD() {
      var d = new ActionDescriptor();
      d.putDouble(charIDToTypeID('Top '), T);
      d.putDouble(charIDToTypeID('Left'), L);
      d.putDouble(charIDToTypeID('Btom'), B);
      d.putDouble(charIDToTypeID('Rght'), R);
      return d;
    }

    var quiltD = new ActionDescriptor();
    quiltD.putEnumerated(stringIDToTypeID('warpStyle'), stringIDToTypeID('warpStyle'), stringIDToTypeID('warpCustom'));
    quiltD.putDouble(stringIDToTypeID('warpValue'), 0);
    quiltD.putDouble(stringIDToTypeID('warpPerspective'), 0);
    quiltD.putDouble(stringIDToTypeID('warpPerspectiveOther'), 0);
    quiltD.putEnumerated(stringIDToTypeID('warpRotate'), charIDToTypeID('Ornt'), charIDToTypeID('Hrzn'));
    quiltD.putObject(stringIDToTypeID('bounds'), stringIDToTypeID('classFloatRect'), frD());
    quiltD.putInteger(stringIDToTypeID('uOrder'), 4);
    quiltD.putInteger(stringIDToTypeID('vOrder'), 4);
    quiltD.putInteger(stringIDToTypeID('deformNumRows'), NROWS);
    quiltD.putInteger(stringIDToTypeID('deformNumCols'), NCOLS);
    quiltD.putObject(stringIDToTypeID('customEnvelopeWarp'), stringIDToTypeID('customEnvelopeWarp'), envD);

    var wnD = new ActionDescriptor();
    wnD.putEnumerated(stringIDToTypeID('warpStyle'), stringIDToTypeID('warpStyle'), stringIDToTypeID('warpNone'));
    wnD.putDouble(stringIDToTypeID('warpValue'), 0);
    wnD.putDouble(stringIDToTypeID('warpPerspective'), 0);
    wnD.putDouble(stringIDToTypeID('warpPerspectiveOther'), 0);
    wnD.putEnumerated(stringIDToTypeID('warpRotate'), charIDToTypeID('Ornt'), charIDToTypeID('Hrzn'));
    wnD.putObject(stringIDToTypeID('bounds'), stringIDToTypeID('classFloatRect'), frD());
    wnD.putInteger(stringIDToTypeID('uOrder'), 4);
    wnD.putInteger(stringIDToTypeID('vOrder'), 4);

    var tDesc = new ActionDescriptor();
    var tRef = new ActionReference();
    tRef.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    tDesc.putReference(charIDToTypeID('null'), tRef);
    tDesc.putEnumerated(charIDToTypeID('FTcs'), charIDToTypeID('QCSt'), charIDToTypeID('Qcsa'));
    var oD = new ActionDescriptor();
    oD.putUnitDouble(charIDToTypeID('Hrzn'), charIDToTypeID('#Pxl'), 0);
    oD.putUnitDouble(charIDToTypeID('Vrtc'), charIDToTypeID('#Pxl'), 0);
    tDesc.putObject(charIDToTypeID('Ofst'), charIDToTypeID('Ofst'), oD);
    tDesc.putBoolean(charIDToTypeID('Lnkd'), true);
    tDesc.putObject(stringIDToTypeID('quiltWarp'), stringIDToTypeID('quiltWarp'), quiltD);
    tDesc.putObject(stringIDToTypeID('warp'), stringIDToTypeID('warp'), wnD);
    tDesc.putEnumerated(charIDToTypeID('Intr'), charIDToTypeID('Intp'), charIDToTypeID('Bcbc'));
    executeAction(charIDToTypeID('Trnf'), tDesc, DialogModes.NO);

    var nb = layer.bounds;
    var heldVal, expectVal;
    if (PIN === 'left') { heldVal = nb[0].as('px'); expectVal = L; }
    else if (PIN === 'right') { heldVal = nb[2].as('px'); expectVal = R; }
    else if (PIN === 'top') { heldVal = nb[1].as('px'); expectVal = T; }
    else { heldVal = nb[3].as('px'); expectVal = B; }

    return {
      warped: true,
      mode: RAW ? 'raw' : 'params',
      pin_edge: PIN,
      cols: NCOLS,
      rows: NROWS,
      points: GRID.length,
      pinned_edge_held: (Math.abs(heldVal - expectVal) < 2),
      bounds: { left: nb[0].as('px'), top: nb[1].as('px'), right: nb[2].as('px'), bottom: nb[3].as('px') },
      background_promoted: __backgroundPromoted
    };
  `,

		vault.LtRot: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    var __backgroundPromoted = false;
    if (layer.isBackgroundLayer) {
      try {
        layer.isBackgroundLayer = false;
        __backgroundPromoted = true;
      } catch (eBg) {
        throw new Error('Could not promote background layer: ' + eBg.message);
      }
    }

    layer.rotate(%s, AnchorPosition.MIDDLECENTER);

    return {
      rotated: true,
      degrees: %s,
      background_promoted: __backgroundPromoted
    };
  `,

		vault.LtMove: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    var __backgroundPromoted = false;
    if (layer.isBackgroundLayer) {
      try {
        layer.isBackgroundLayer = false;
        __backgroundPromoted = true;
      } catch (eBg) {
        throw new Error('Could not promote background layer: ' + eBg.message);
      }
    }
    %s

    layer.translate(tx, ty);

    var nb = layer.boundsNoEffects !== undefined ? layer.boundsNoEffects : layer.bounds;
    return {
      moved: true,
      mode: %s,
      applied_delta_x: tx,
      applied_delta_y: ty,
      requested_delta_x: %s,
      requested_delta_y: %s,
      requested_absolute_x: %s,
      requested_absolute_y: %s,
      requested_center_x: %s,
      requested_center_y: %s,
      new_bounds: {
        left: nb[0].as('px'), top: nb[1].as('px'),
        right: nb[2].as('px'), bottom: nb[3].as('px')
      },
      background_promoted: __backgroundPromoted
    };
  `,
	})
}
