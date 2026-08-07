package main

import "editmamei-core/internal/vault"

// Gradient family (2026-08 gradient build).
//
// Ground truth for the gradientLayer Mk descriptor + the Grdn gradient
// payload (Nm/GrdF/Intr + Clrs list of Clrt stops + Trns list of TrnS stops,
// Lctn 0..4096, Mdpn) confirmed via ScriptListener capture (PS 27.x Windows,
// menu capture, both linear and radial gradients).
//
// The classic Grdn DRAW event (maskGradient below) has no menu capture — the
// modern gradient tool records only the non-scriptable owl widget — so its
// From/To/Type wrapper is practitioner lore around the capture-proven Grad
// payload.
func init() {
	addFragments(map[string]string{
		// addGradientFillLayer — Mk contentLayer / gradientLayer with custom
		// stops, then a follow-up setd. The Mk descriptor is CAPTURE-SHAPE
		// (STEP-13 desc835: no Angl, no Rvrs — PS omits both at create time);
		// the angle and reverse land via the setd (STEP-13 desc846/847, which
		// carries the full gradientLayer descriptor including Angl). Keeping
		// unverified keys off the Mk avoids the Windows-lenient/macOS-strict
		// descriptor asymmetry. noisePreSeed (a dither seed present in the
		// capture) is deliberately omitted — inert for customStops gradients,
		// live-verified without it.
		// Creates a new layer → full getContextInfo. Same placement behavior
		// as addFillLayer (hoist-out-of-active-group by default).
		// Slots: 1=parentPathHelper, 2=hoistFromActiveGroupHelper,
		// 3=getContextInfo, 4=angle(jsNum), 5=colorStopLines,
		// 6=opacityStopLines, 7=dither(jsBool), 8=typeCharID(jsLit),
		// 9=reverseLine(''|GradRevLine), 10=scale(jsNum), 11=offsetX(jsNum),
		// 12=offsetY(jsNum), 13=into_active_group(jsBool),
		// 14=gradientTypeName(jsLit), 15=scale(jsNum), 16=reverse(jsBool),
		// 17=stopCount(int).
		vault.AddGradFill: `
    %s
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var __preMkActive = doc.activeLayer;

    function makeColorStop(loc, midpoint, r, g, b) {
      var stop = new ActionDescriptor();
      var color = new ActionDescriptor();
      color.putDouble(charIDToTypeID('Rd  '), r);
      color.putDouble(charIDToTypeID('Grn '), g);
      color.putDouble(charIDToTypeID('Bl  '), b);
      stop.putObject(charIDToTypeID('Clr '), charIDToTypeID('RGBC'), color);
      stop.putEnumerated(charIDToTypeID('Type'), charIDToTypeID('Clry'), charIDToTypeID('UsrS'));
      stop.putInteger(charIDToTypeID('Lctn'), loc);
      stop.putInteger(charIDToTypeID('Mdpn'), midpoint);
      return stop;
    }
    function makeOpacityStop(loc, midpoint, opacity) {
      var stop = new ActionDescriptor();
      stop.putUnitDouble(charIDToTypeID('Opct'), charIDToTypeID('#Prc'), opacity);
      stop.putInteger(charIDToTypeID('Lctn'), loc);
      stop.putInteger(charIDToTypeID('Mdpn'), midpoint);
      return stop;
    }

    var __angle = %s;

    function __buildGradObj() {
      var grdDesc = new ActionDescriptor();
      grdDesc.putString(charIDToTypeID('Nm  '), 'Editmamei Gradient');
      grdDesc.putEnumerated(charIDToTypeID('GrdF'), charIDToTypeID('GrdF'), charIDToTypeID('CstS'));
      grdDesc.putDouble(charIDToTypeID('Intr'), 4096);
      var colorStops = new ActionList();
%s
      grdDesc.putList(charIDToTypeID('Clrs'), colorStops);
      var opacityStops = new ActionList();
%s
      grdDesc.putList(charIDToTypeID('Trns'), opacityStops);
      return grdDesc;
    }

    function __buildGradType(includeAngle) {
      var typeDesc = new ActionDescriptor();
      typeDesc.putBoolean(charIDToTypeID('Dthr'), %s);
      typeDesc.putEnumerated(stringIDToTypeID('gradientsInterpolationMethod'), stringIDToTypeID('gradientInterpolationMethodType'), charIDToTypeID('Smoo'));
      if (includeAngle) {
        typeDesc.putUnitDouble(charIDToTypeID('Angl'), charIDToTypeID('#Ang'), __angle);
      }
      typeDesc.putEnumerated(charIDToTypeID('Type'), charIDToTypeID('GrdT'), charIDToTypeID(%s));
      if (includeAngle) {
        %s
      }
      typeDesc.putBoolean(charIDToTypeID('Algn'), false);
      typeDesc.putUnitDouble(charIDToTypeID('Scl '), charIDToTypeID('#Prc'), %s);
      var ofstDesc = new ActionDescriptor();
      ofstDesc.putUnitDouble(charIDToTypeID('Hrzn'), charIDToTypeID('#Prc'), %s);
      ofstDesc.putUnitDouble(charIDToTypeID('Vrtc'), charIDToTypeID('#Prc'), %s);
      typeDesc.putObject(charIDToTypeID('Ofst'), charIDToTypeID('Pnt '), ofstDesc);
      typeDesc.putObject(charIDToTypeID('Grad'), charIDToTypeID('Grdn'), __buildGradObj());
      return typeDesc;
    }

    var usingDesc = new ActionDescriptor();
    usingDesc.putObject(charIDToTypeID('Type'), stringIDToTypeID('gradientLayer'), __buildGradType(false));
    var mkDesc = new ActionDescriptor();
    var mkRef = new ActionReference();
    mkRef.putClass(stringIDToTypeID('contentLayer'));
    mkDesc.putReference(charIDToTypeID('null'), mkRef);
    mkDesc.putObject(charIDToTypeID('Usng'), stringIDToTypeID('contentLayer'), usingDesc);
    executeAction(charIDToTypeID('Mk  '), mkDesc, DialogModes.NO);

    var setDesc = new ActionDescriptor();
    var setRef = new ActionReference();
    setRef.putEnumerated(stringIDToTypeID('contentLayer'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    setDesc.putReference(charIDToTypeID('null'), setRef);
    setDesc.putObject(charIDToTypeID('T   '), stringIDToTypeID('gradientLayer'), __buildGradType(true));
    executeAction(charIDToTypeID('setd'), setDesc, DialogModes.NO);

    var __newLayer = doc.activeLayer;
    var __intoActiveGroup = %s;
    var __hoisted = __hoistFromActiveGroupIfNeeded(doc, __preMkActive, __newLayer, __intoActiveGroup);

    // Post-condition, not a hardcoded success flag: the Mk left a GRADIENTFILL
    // layer active. false = the event dispatched but did not create what we
    // asked for — surface it instead of claiming success.
    var __isGradientFill = false;
    try { __isGradientFill = (__newLayer.kind === LayerKind.GRADIENTFILL); } catch (eKind) {}

    return {
      created: __isGradientFill,
      layer_kind: String(__newLayer.kind),
      fill_type: 'gradient',
      gradient_type: %s,
      angle: __angle,
      scale: %s,
      reverse: %s,
      stop_count: %s,
      layer_name: __newLayer.name,
      hoisted: __hoisted,
      parent_path: __parentPathOf(doc, __newLayer),
      context: getContextInfo()
    };
  `,

		// One color-stop line for a stop-block slot. Callers guarantee the
		// host fragment defines makeColorStop(loc, midpoint, r, g, b) and a
		// colorStops ActionList in scope. Slots: loc, midpoint, r, g, b.
		vault.GradStopLine: `    colorStops.putObject(charIDToTypeID('Clrt'), makeColorStop(%s, %s, %s, %s, %s));`,

		// One opacity-stop line. Host defines makeOpacityStop(loc, midpoint,
		// opacity) + an opacityStops ActionList. Slots: loc, midpoint, opacity.
		vault.GradOpacStopLine: `    opacityStops.putObject(charIDToTypeID('TrnS'), makeOpacityStop(%s, %s, %s));`,

		// maskGradient — linear fade drawn INTO the active layer's mask
		// channel. Ensures a mask exists (reveal-all; stringID descriptor
		// verbatim from the macOS-strict-verified createLayerMask capture),
		// deselects, targets the mask channel, computes From/To in doc pixels
		// from fade_to/start/end over the layer-or-canvas extent, then fires
		// the classic Grdn draw event with a white→black two-stop Grad payload
		// (payload shape capture-proven; the Grdn wrapper is the lore part —
		// see the file-top note). REPLACES existing mask content. Restores the
		// composite channel afterwards.
		// Slots: 1=helperFunctions, 2=restoreCompositeChannel,
		// 3=getContextInfo, 4=fadeTo(jsLit), 5=start(jsNum), 6=end(jsNum),
		// 7=extent(jsLit), 8=startGray(jsNum), 9=endGray(jsNum).
		vault.MaskGrad: `
    %s
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    if (layer.isBackgroundLayer) {
      throw new Error('Cannot add a mask gradient to the background layer. Duplicate or convert it first.');
    }

    var __fadeTo = %s;
    var __start = %s;
    var __end = %s;
    var __extent = %s;
    var __g0 = %s;
    var __g1 = %s;

    var __hasMask = false;
    try {
      var __mRef = new ActionReference();
      __mRef.putProperty(cTID('Prpr'), sTID('hasUserMask'));
      __mRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      __hasMask = executeActionGet(__mRef).getBoolean(sTID('hasUserMask'));
    } catch (eProbe) {
      __hasMask = false;
    }
    var __createdMask = false;
    if (!__hasMask) {
      var mkDesc = new ActionDescriptor();
      mkDesc.putClass(sTID('new'), sTID('channel'));
      var atRef = new ActionReference();
      atRef.putEnumerated(sTID('channel'), sTID('channel'), sTID('mask'));
      mkDesc.putReference(sTID('at'), atRef);
      mkDesc.putEnumerated(sTID('using'), sTID('userMaskEnabled'), sTID('revealAll'));
      try {
        executeAction(sTID('make'), mkDesc, DialogModes.NO);
        __createdMask = true;
      } catch (eMk) {
        // The probe said no mask but make failed — most likely the probe
        // misread and a mask already exists. Proceed: the mask-channel slct
        // below throws a clear error if there is genuinely no mask.
      }
    }

    try { doc.selection.deselect(); } catch (eDe) {}

    var slDesc = new ActionDescriptor();
    var slRef = new ActionReference();
    slRef.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
    slDesc.putReference(cTID('null'), slRef);
    executeAction(cTID('slct'), slDesc, DialogModes.NO);

    var __mgB = null;
    if (__extent === 'layer') {
      try {
        __mgB = [layer.bounds[0].as('px'), layer.bounds[1].as('px'), layer.bounds[2].as('px'), layer.bounds[3].as('px')];
      } catch (eB) {
        __mgB = null;
      }
    }
    if (!__mgB || (__mgB[2] - __mgB[0]) < 1 || (__mgB[3] - __mgB[1]) < 1) {
      __mgB = [0, 0, doc.width.as('px'), doc.height.as('px')];
      __extent = 'canvas';
    }

    var cx = (__mgB[0] + __mgB[2]) / 2;
    var cy = (__mgB[1] + __mgB[3]) / 2;
    var fx, fy, tx, ty;
    if (__fadeTo === 'bottom') {
      var hB = __mgB[3] - __mgB[1];
      fx = cx; tx = cx;
      fy = __mgB[1] + __start * hB;
      ty = __mgB[1] + __end * hB;
    } else if (__fadeTo === 'top') {
      var hT = __mgB[3] - __mgB[1];
      fx = cx; tx = cx;
      fy = __mgB[3] - __start * hT;
      ty = __mgB[3] - __end * hT;
    } else if (__fadeTo === 'right') {
      var wR = __mgB[2] - __mgB[0];
      fy = cy; ty = cy;
      fx = __mgB[0] + __start * wR;
      tx = __mgB[0] + __end * wR;
    } else if (__fadeTo === 'left') {
      var wL = __mgB[2] - __mgB[0];
      fy = cy; ty = cy;
      fx = __mgB[2] - __start * wL;
      tx = __mgB[2] - __end * wL;
    } else {
      throw new Error('Unknown fade_to: ' + __fadeTo);
    }
    if (Math.abs(tx - fx) < 0.5 && Math.abs(ty - fy) < 0.5) {
      throw new Error('Degenerate mask gradient: start and end resolve to the same point.');
    }

    function makeColorStop(loc, midpoint, r, g, b) {
      var stop = new ActionDescriptor();
      var color = new ActionDescriptor();
      color.putDouble(cTID('Rd  '), r);
      color.putDouble(cTID('Grn '), g);
      color.putDouble(cTID('Bl  '), b);
      stop.putObject(cTID('Clr '), cTID('RGBC'), color);
      stop.putEnumerated(cTID('Type'), cTID('Clry'), cTID('UsrS'));
      stop.putInteger(cTID('Lctn'), loc);
      stop.putInteger(cTID('Mdpn'), midpoint);
      return stop;
    }
    function makeOpacityStop(loc, midpoint, opacity) {
      var stop = new ActionDescriptor();
      stop.putUnitDouble(cTID('Opct'), cTID('#Prc'), opacity);
      stop.putInteger(cTID('Lctn'), loc);
      stop.putInteger(cTID('Mdpn'), midpoint);
      return stop;
    }

    var grdDesc = new ActionDescriptor();
    grdDesc.putString(cTID('Nm  '), 'Editmamei Mask Fade');
    grdDesc.putEnumerated(cTID('GrdF'), cTID('GrdF'), cTID('CstS'));
    grdDesc.putDouble(cTID('Intr'), 4096);
    var colorStops = new ActionList();
    colorStops.putObject(cTID('Clrt'), makeColorStop(0, 50, __g0, __g0, __g0));
    colorStops.putObject(cTID('Clrt'), makeColorStop(4096, 50, __g1, __g1, __g1));
    grdDesc.putList(cTID('Clrs'), colorStops);
    var opacityStops = new ActionList();
    opacityStops.putObject(cTID('TrnS'), makeOpacityStop(0, 50, 100));
    opacityStops.putObject(cTID('TrnS'), makeOpacityStop(4096, 50, 100));
    grdDesc.putList(cTID('Trns'), opacityStops);

    var fromDesc = new ActionDescriptor();
    fromDesc.putUnitDouble(cTID('Hrzn'), cTID('#Pxl'), fx);
    fromDesc.putUnitDouble(cTID('Vrtc'), cTID('#Pxl'), fy);
    var toDesc = new ActionDescriptor();
    toDesc.putUnitDouble(cTID('Hrzn'), cTID('#Pxl'), tx);
    toDesc.putUnitDouble(cTID('Vrtc'), cTID('#Pxl'), ty);

    var gDesc = new ActionDescriptor();
    gDesc.putObject(cTID('From'), cTID('Pnt '), fromDesc);
    gDesc.putObject(cTID('T   '), cTID('Pnt '), toDesc);
    gDesc.putEnumerated(cTID('Type'), cTID('GrdT'), cTID('Lnr '));
    gDesc.putBoolean(cTID('Dthr'), true);
    // UsMs=false is a deliberate divergence from the classic capture lore
    // (which records true): we deselect above, so there is no selection-mask
    // to honor, and false keeps the draw unconditional.
    gDesc.putBoolean(cTID('UsMs'), false);
    // Pin blend mode + opacity explicitly so the draw cannot inherit a
    // mis-set Gradient TOOL state (e.g. Multiply at half opacity) and
    // silently corrupt the fade.
    gDesc.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Nrml'));
    gDesc.putUnitDouble(cTID('Opct'), cTID('#Prc'), 100);
    gDesc.putObject(cTID('Grad'), cTID('Grdn'), grdDesc);
    executeAction(cTID('Grdn'), gDesc, DialogModes.NO);

    restoreCompositeChannel(doc);

    return {
      mask_gradient: true,
      created_mask: __createdMask,
      fade_to: __fadeTo,
      from: { x: Math.round(fx), y: Math.round(fy) },
      to: { x: Math.round(tx), y: Math.round(ty) },
      extent: __extent,
      bounds_used: { left: Math.round(__mgB[0]), top: Math.round(__mgB[1]), right: Math.round(__mgB[2]), bottom: Math.round(__mgB[3]) },
      layer_name: layer.name,
      context: getContextInfo()
    };
  `,

		// Conditional reverse line for addGradientFillLayer (interpolated into
		// slot 9 only when reverse=true — PS omits Rvrs at its false default,
		// so we mirror the capture shape and omit it too). No slots.
		vault.GradRevLine: `typeDesc.putBoolean(charIDToTypeID('Rvrs'), true);`,
	})
}
