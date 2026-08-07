package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// applyShadowsHighlights. Slots: 1=getMinimalContextInfo, 2=helperFunctions,
		// 3=duplicateForOp, 4=shadowAmount, 5=shadowWidth, 6=shadowRadius,
		// 7=highlightAmount, 8=highlightWidth, 9=highlightRadius, 10=blackClip,
		// 11=whiteClip, 12=midtoneContrast, 13=colorCorrection, then result:
		// 14=shadowAmount, 15=shadowWidth, 16=shadowRadius, 17=highlightAmount,
		// 18=highlightWidth, 19=highlightRadius, 20=colorCorrection,
		// 21=midtoneContrast.
		vault.ShadowsHL: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    %s

    var layer = doc.activeLayer;

    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Shadows/Highlights requires a pixel layer (kind=' + layer.kind + ').');
    }

    var shDesc = new ActionDescriptor();

    // Verified against ScriptListener capture of Image >
    // Adjustments > Shadows/Highlights on PS 2026 Windows
    // (Windows_All_Adj/ScriptingListenerJS.log lines 11985-12017).
    // Multiple silent drifts in the previous emission — operation
    // succeeded but ran with PS defaults instead of caller params:
    //   - sub-object key shadowMode (sTID) -> sdwM (cTID)
    //   - sub-object key highlightMode (sTID) -> hglM (cTID)
    //   - amount/width/radius keys: sTID strings -> cTID Amnt/Wdth/Rds
    //   - percent unit class: sTID('percentUnit') -> cTID('#Prc')
    //   - root blackClip/whiteClip/center/colorCorrection keys:
    //     sTID strings -> cTID BlcC/WhtC/Cntr/ClrC
    // The event ID (sTID 'adaptCorrect') and the sub-object class
    // (sTID 'adaptCorrectTones') match PS's UI emission as-is — those
    // were already correct.

    // Shadow tab — adaptCorrectTones sub-descriptor.
    var shadowMode = new ActionDescriptor();
    shadowMode.putUnitDouble(cTID('Amnt'), cTID('#Prc'), %s);
    shadowMode.putUnitDouble(cTID('Wdth'), cTID('#Prc'), %s);
    shadowMode.putInteger(cTID('Rds '), %s);
    shDesc.putObject(cTID('sdwM'), sTID('adaptCorrectTones'), shadowMode);

    // Highlight tab — same sub-descriptor shape.
    var highlightMode = new ActionDescriptor();
    highlightMode.putUnitDouble(cTID('Amnt'), cTID('#Prc'), %s);
    highlightMode.putUnitDouble(cTID('Wdth'), cTID('#Prc'), %s);
    highlightMode.putInteger(cTID('Rds '), %s);
    shDesc.putObject(cTID('hglM'), sTID('adaptCorrectTones'), highlightMode);

    // Root-level keys (all charIDs per the UI capture). BlcC/WhtC are
    // black/white clip percentages — caller-controlled as of Bundle 6
    // (2026-06-04). Cntr is the midtone-contrast slider; ClrC is
    // color-correction.
    shDesc.putDouble(cTID('BlcC'), %s);
    shDesc.putDouble(cTID('WhtC'), %s);
    shDesc.putInteger(cTID('Cntr'), %s);
    shDesc.putInteger(cTID('ClrC'), %s);

    executeAction(sTID('adaptCorrect'), shDesc, DialogModes.NO);

    return {
      filter: 'Shadows/Highlights',
      shadow_amount: %s,
      shadow_width: %s,
      shadow_radius: %s,
      highlight_amount: %s,
      highlight_width: %s,
      highlight_radius: %s,
      color_correction: %s,
      midtone_contrast: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// applyColorLookup. Slots: 1=getContextInfo, 2=helperFunctions,
		// 3=duplicateForOp, 4=lutName(jsLit).
		vault.ColorLookup: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    %s

    var layer = doc.activeLayer;
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Color Lookup bake requires a pixel layer (kind=' + layer.kind + ').');
    }

    // Path resolution — same logic as the AdjL form's typeDesc branch.
    var requestedLut = %s;
    var resolvedLutPath = null;
    var isAbsolute = (requestedLut.length > 1 && requestedLut.charAt(1) === ':') || requestedLut.charAt(0) === '/';
    if (isAbsolute) {
      resolvedLutPath = requestedLut;
    } else {
      var psPresetDir = new Folder(String(app.path) + '/Presets/3DLUTs');
      if (psPresetDir.exists) {
        var entries = psPresetDir.getFiles();
        var requestedBase = requestedLut.replace(/\.(cube|3dl|look|icc)$/i, '').toLowerCase();
        for (var li = 0; li < entries.length; li++) {
          var entry = entries[li];
          if (entry instanceof File) {
            // ExtendScript Folder.getFiles() returns URI-encoded names
            // (URI-encoded: spaces and parens become escapes); decodeURI restores the human
            // form so a literal leaf with spaces/parens matches.
            var entryName = decodeURI(entry.name);
            if (entryName === requestedLut) { resolvedLutPath = entry.fsName; break; }
            var entryBase = entryName.replace(/\.(cube|3dl|look|icc)$/i, '').toLowerCase();
            if (entryBase === requestedBase) { resolvedLutPath = entry.fsName; break; }
          }
        }
      }
    }
    if (resolvedLutPath === null) {
      throw new Error('Color Lookup: LUT not found: ' + requestedLut + '. Pass an absolute path, or a leaf name matching a file in ' + String(app.path) + '/Presets/3DLUTs/');
    }

    // Read raw file bytes.
    var lutFile = new File(resolvedLutPath);
    lutFile.encoding = 'BINARY';
    if (!lutFile.open('r')) {
      throw new Error('Color Lookup: could not open LUT file: ' + resolvedLutPath);
    }
    var lutBytes = lutFile.read();
    lutFile.close();

    // LUTFormat enum from extension.
    var lutFormatEnum = null;
    var pathLower = resolvedLutPath.toLowerCase();
    if (pathLower.indexOf('.3dl') === pathLower.length - 4) {
      lutFormatEnum = 'LUTFormat3DL';
    } else if (pathLower.indexOf('.look') === pathLower.length - 5) {
      lutFormatEnum = 'LUTFormatLOOK';
    } else if (pathLower.indexOf('.cube') === pathLower.length - 5) {
      lutFormatEnum = 'LUTFormatCUBE';
    } else {
      throw new Error('Color Lookup: unsupported file extension. Expected .3DL / .look / .cube — got: ' + resolvedLutPath);
    }

    // BAKE descriptor — same shape as AdjL setd's inner type-descriptor,
    // but dispatched via the colorLookup event ID (not setd). PS's bake
    // handler MAY be more lenient about a missing 'profile' parsed blob.
    // Live test will confirm; if not, see the limitation doc.
    var clDesc = new ActionDescriptor();
    clDesc.putEnumerated(sTID('lookupType'), sTID('colorLookupType'), sTID('3DLUT'));
    clDesc.putString(cTID('Nm  '), resolvedLutPath);
    clDesc.putEnumerated(sTID('LUTFormat'), sTID('LUTFormatType'), sTID(lutFormatEnum));
    clDesc.putData(sTID('LUT3DFileData'), lutBytes);
    clDesc.putString(sTID('LUT3DFileName'), resolvedLutPath);
    executeAction(sTID('colorLookup'), clDesc, DialogModes.NO);

    return {
      filter: 'Color Lookup',
      lut_path: resolvedLutPath,
      lut_format: lutFormatEnum,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getContextInfo()
    };
  `,

		// applyEqualize. Slots: 1=getContextInfo, 2=helperFunctions,
		// 3=duplicateForOp.
		vault.Equalize: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    %s

    var layer = doc.activeLayer;
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Equalize requires a pixel layer (kind=' + layer.kind + ').');
    }

    executeAction(cTID('Eqlz'), new ActionDescriptor(), DialogModes.NO);

    return {
      filter: 'Equalize',
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getContextInfo()
    };
  `,

		// -----------------------------------------------------------------------
		// addAdjustmentLayer — outer shell.
		// Slots (17 total):
		//   1  = parentPathHelper body
		//   2  = hoistFromActiveGroupHelper body
		//   3  = helperFunctions body
		//   4  = getContextInfo body
		//   5  = jsLit(adjType)
		//   6  = wantCustom ("true"/"false")
		//   7  = maskFromSelection ("true"/"false")
		//   8  = maskInvertedRequested ("true"/"false")
		//   9  = into_active_group ("true"/"false")
		//   10 = typeDesc building block (adjType-specific fragment)
		//   11 = using.put* line (putClass for color_lookup/invert, putObject otherwise)
		//   12 = layerName assignment line or ""
		//   13 = color_lookup note or ""
		//   14 = levels post-Mk setd or ""
		//   15 = curves post-Mk setd or ""
		//   16 = clipToBelow condition ("true"/"false")
		//   17 = clipToBelow in return ("true"/"false")
		//
		// Phase 4 (layer-placement bug): the Mk descriptor below carries no
		// target reference, so with a group active PS nests the new adjustment
		// layer INSIDE it — contradicting this tool's documented "above the
		// active layer" placement. __hoistFromActiveGroupIfNeeded (run right
		// after the Mk, before any of the post-Mk setd/clip/mask blocks so they
		// all act on the layer's final position) moves it back out to a sibling
		// of that group by default; into_active_group:true keeps PS's native
		// nesting.
		// -----------------------------------------------------------------------
		vault.AdjLOuter: `
    %s
    %s
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var __preMkActive = doc.activeLayer;

    function mark(step) { try { $.__mcp__ = { step: step }; } catch (e) {} }

    var adjType = %s;
    var wantCustom = %s;
    var maskFromSelection = %s;
    var maskInvertedRequested = %s;
    var __intoActiveGroup = %s;

    var typeCharID = null;
    if (adjType === 'curves') typeCharID = cTID('Crvs');
    else if (adjType === 'levels') typeCharID = cTID('Lvls');
    else if (adjType === 'hue_saturation') typeCharID = cTID('HStr');
    else if (adjType === 'brightness_contrast') typeCharID = cTID('BrgC');
    else if (adjType === 'black_and_white') typeCharID = sTID('blackAndWhite');
    else if (adjType === 'color_balance') typeCharID = cTID('ClrB');
    else if (adjType === 'photo_filter') typeCharID = sTID('photoFilter');
    else if (adjType === 'vibrance') typeCharID = sTID('vibrance');
    else if (adjType === 'channel_mixer') typeCharID = sTID('channelMixer');
    else if (adjType === 'selective_color') typeCharID = sTID('selectiveColor');
    else if (adjType === 'gradient_map') typeCharID = cTID('GdMp');
    else if (adjType === 'exposure') typeCharID = sTID('exposure');
    else if (adjType === 'color_lookup') typeCharID = sTID('colorLookup');
    else if (adjType === 'invert') typeCharID = cTID('Invr');
    else if (adjType === 'posterize') typeCharID = cTID('Pstr');
    else if (adjType === 'threshold') typeCharID = cTID('Thrs');
    else throw new Error('Unknown adjustment type: ' + adjType);

    // Selection state probe via ActionReference / fsel. Accessing the DOM
    // selection bounds throws an UNCATCHABLE error 1302 in PS 2024+ when
    // there is no selection, so we MUST use the ActionReference pattern.
    var hadSelection = (function () {
      var ref = new ActionReference();
      ref.putProperty(cTID('Prpr'), cTID('fsel'));
      ref.putEnumerated(cTID('Dcmn'), cTID('Ordn'), cTID('Trgt'));
      return executeActionGet(ref).hasKey(cTID('fsel'));
    })();

    // If the caller wants to IGNORE an existing selection (maskFromSelection=false),
    // deselect before Mk so PS doesn't auto-mask the new layer.
    if (hadSelection && !maskFromSelection) {
      try { doc.selection.deselect(); } catch (e) {}
    }
    var willHaveMask = (hadSelection && maskFromSelection);

    mark('build_type_descriptor');

    var typeDesc = new ActionDescriptor();

    if (!wantCustom) {
      typeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindDefault'));
    } else {
      %s
    }

    mark('build_mk_descriptor');

    var d = new ActionDescriptor();
    var r = new ActionReference();
    r.putClass(cTID('AdjL'));
    d.putReference(cTID('null'), r);
    var using = new ActionDescriptor();
    %s
    d.putObject(cTID('Usng'), cTID('AdjL'), using);

    mark('execute_mk');
    executeAction(cTID('Mk  '), d, DialogModes.NO);

    mark('post_mk');
    var newLayer = doc.activeLayer;
    var __hoisted = __hoistFromActiveGroupIfNeeded(doc, __preMkActive, newLayer, __intoActiveGroup);
    %s

    %s

    %s

    %s

    var verifiedKind = String(newLayer.kind);
    var expectedKind = null;
    if (adjType === 'hue_saturation') expectedKind = 'LayerKind.HUESATURATION';
    else if (adjType === 'brightness_contrast') expectedKind = 'LayerKind.BRIGHTNESSCONTRAST';
    else if (adjType === 'curves') expectedKind = 'LayerKind.CURVES';
    else if (adjType === 'levels') expectedKind = 'LayerKind.LEVELS';
    else if (adjType === 'black_and_white') expectedKind = 'LayerKind.BLACKANDWHITE';
    else if (adjType === 'color_balance') expectedKind = 'LayerKind.COLORBALANCE';
    else if (adjType === 'photo_filter') expectedKind = 'LayerKind.PHOTOFILTER';
    else if (adjType === 'vibrance') expectedKind = 'LayerKind.VIBRANCE';
    else if (adjType === 'channel_mixer') expectedKind = 'LayerKind.CHANNELMIXER';
    else if (adjType === 'selective_color') expectedKind = 'LayerKind.SELECTIVECOLOR';
    else if (adjType === 'gradient_map') expectedKind = 'LayerKind.GRADIENTMAP';
    else if (adjType === 'exposure') expectedKind = 'LayerKind.EXPOSURE';
    else if (adjType === 'color_lookup') expectedKind = 'LayerKind.COLORLOOKUP';
    else if (adjType === 'invert') expectedKind = 'LayerKind.INVERSION';
    else if (adjType === 'posterize') expectedKind = 'LayerKind.POSTERIZE';
    else if (adjType === 'threshold') expectedKind = 'LayerKind.THRESHOLD';
    var kindMatches = (verifiedKind === expectedKind);

    var maskInvertedApplied = false;
    var maskInversionError = null;
    if (willHaveMask && maskInvertedRequested) {
      mark('invert_mask');
      try {
        var selMaskDesc = new ActionDescriptor();
        var selMaskRef = new ActionReference();
        selMaskRef.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
        selMaskDesc.putReference(cTID('null'), selMaskRef);
        executeAction(cTID('slct'), selMaskDesc, DialogModes.NO);
        executeAction(cTID('Invr'), new ActionDescriptor(), DialogModes.NO);
        try {
          var compositeEnum = cTID('RGB ');
          var docMode = String(doc.mode);
          if (docMode === 'DocumentMode.CMYK') compositeEnum = cTID('CMYK');
          else if (docMode === 'DocumentMode.GRAYSCALE') compositeEnum = cTID('Gry ');
          else if (docMode === 'DocumentMode.LAB') compositeEnum = cTID('Lab ');
          var restoreDesc = new ActionDescriptor();
          var restoreRef = new ActionReference();
          restoreRef.putEnumerated(cTID('Chnl'), cTID('Chnl'), compositeEnum);
          restoreDesc.putReference(cTID('null'), restoreRef);
          executeAction(cTID('slct'), restoreDesc, DialogModes.NO);
        } catch (eRestore) {}
        maskInvertedApplied = true;
      } catch (eInvert) {
        maskInversionError = eInvert.message;
      }
    }

    if (%s) {
      mark('apply_clipping');
      try {
        var clipDesc = new ActionDescriptor();
        var clipRef = new ActionReference();
        clipRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
        clipDesc.putReference(cTID('null'), clipRef);
        executeAction(sTID('groupEvent'), clipDesc, DialogModes.NO);
      } catch (e) {
        mark('clipping_failed:' + e.message);
        return {
          created: true,
          type: adjType,
          layerName: newLayer.name,
          layerKind: verifiedKind,
          kindMatches: kindMatches,
          clipped: false,
          clipError: e.message,
          customValuesApplied: wantCustom,
          had_selection: hadSelection,
          mask_applied: willHaveMask,
          mask_inverted: maskInvertedApplied,
          mask_inversion_error: maskInversionError,
          hoisted: __hoisted,
          parent_path: __parentPathOf(doc, newLayer),
          context: getContextInfo()
        };
      }
    }

    mark('done');
    return {
      created: true,
      type: adjType,
      layerName: newLayer.name,
      layerKind: verifiedKind,
      kindMatches: kindMatches,
      clipped: %s,
      customValuesApplied: wantCustom,
      had_selection: hadSelection,
      mask_applied: willHaveMask,
      mask_inverted: maskInvertedApplied,
      mask_inversion_error: maskInversionError,
      hoisted: __hoisted,
      parent_path: __parentPathOf(doc, newLayer),
      context: getContextInfo()
    };
  `,

		// using.putClass — color_lookup and invert (no inner typeDesc embedded in Mk).
		vault.AdjUsingClass: `    using.putClass(cTID('Type'), typeCharID);`,

		// using.putObject — all other adjustment types (typeDesc embedded in Mk).
		vault.AdjUsingObject: `    using.putObject(cTID('Type'), typeCharID, typeDesc);`,

		// color_lookup post-Mk note (no slots — static comment only).
		vault.AdjCLNote: `
    // color_lookup AdjL via DoJavaScript scripting is
    // BLOCKED at the Photoshop level. The empty Color Lookup adjustment
    // layer IS created (Mk uses putClass per the AdjL ground-truth shape).
    // The artist can hand-pick a LUT in Properties, or record a Photoshop
    // Action and invoke it via ps_play_action.`,

		// levels post-Mk setd (PS 27.x Bug A workaround).
		// Slots: blackPoint, whitePoint, gamma (3 numeric).
		vault.AdjLvlPM: `
    // PS 27.x workaround for levels: Mk-with-values regressed (Bug A).
    // Apply values via setd T=Lvls against the just-created adjustment layer.
    mark('apply_levels_setd');
    var lvlSetd = new ActionDescriptor();
    var lvlSetdRef = new ActionReference();
    lvlSetdRef.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
    lvlSetd.putReference(cTID('null'), lvlSetdRef);
    var lvlsTypeDesc = new ActionDescriptor();
    lvlsTypeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
    var lvlsAdjList = new ActionList();
    var lvlsEntry = new ActionDescriptor();
    var lvlChnlRef = new ActionReference();
    lvlChnlRef.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
    lvlsEntry.putReference(cTID('Chnl'), lvlChnlRef);
    var lvlInptList = new ActionList();
    lvlInptList.putInteger(%s);
    lvlInptList.putInteger(%s);
    lvlsEntry.putList(cTID('Inpt'), lvlInptList);
    lvlsEntry.putDouble(cTID('Gmm '), %s);
    lvlsAdjList.putObject(cTID('LvlA'), lvlsEntry);
    lvlsTypeDesc.putList(cTID('Adjs'), lvlsAdjList);
    lvlSetd.putObject(cTID('T   '), cTID('Lvls'), lvlsTypeDesc);
    executeAction(cTID('setd'), lvlSetd, DialogModes.NO);`,

		// curves post-Mk setd (PS 27.x Bug B workaround).
		// Slot: curvePointsJs (the JS array literal of {h,v} objects).
		vault.AdjCrvPM: `
    // PS 27.x workaround for curves: Mk-with-values regressed (Bug B).
    // Apply values via setd T=Crv  against the just-created adjustment layer.
    mark('apply_curves_setd');
    var crvSetd = new ActionDescriptor();
    var crvSetdRef = new ActionReference();
    crvSetdRef.putEnumerated(cTID('AdjL'), cTID('Ordn'), cTID('Trgt'));
    crvSetd.putReference(cTID('null'), crvSetdRef);
    var crvTypeDesc = new ActionDescriptor();
    crvTypeDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
    var crvAdjList = new ActionList();
    var crvEntry = new ActionDescriptor();
    var crvChnlRef = new ActionReference();
    crvChnlRef.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
    crvEntry.putReference(cTID('Chnl'), crvChnlRef);
    var pointList = new ActionList();
    var pts = [%s];
    for (var i = 0; i < pts.length; i++) {
      var pd = new ActionDescriptor();
      pd.putDouble(cTID('Hrzn'), pts[i].h);
      pd.putDouble(cTID('Vrtc'), pts[i].v);
      pointList.putObject(cTID('CrPt'), pd);
    }
    crvEntry.putList(cTID('Crv '), pointList);
    crvAdjList.putObject(cTID('CrvA'), crvEntry);
    crvTypeDesc.putList(cTID('Adjs'), crvAdjList);
    crvSetd.putObject(cTID('T   '), cTID('Crvs'), crvTypeDesc);
    executeAction(cTID('setd'), crvSetd, DialogModes.NO);`,
	})
}
