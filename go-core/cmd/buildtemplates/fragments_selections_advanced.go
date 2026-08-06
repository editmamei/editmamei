package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// selectColorRange. Slots: 1=selectionTypeHelpers, 2=getSelectionInfo,
		// 3=selectionType(jsLit), 4..6=red/green/blue (rgbToLab), 7=fuzziness,
		// 8..10=red/green/blue (result), 11=fuzziness (result).
		vault.ColorRange: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var selType = %s;

    var savedCh = (selType === 'replace') ? null : saveSelectionToTempChannel(doc);
    try {
      // Convert input sRGB [0-255] → CIE Lab. Photoshop's working Lab
      // is D50 (its ICC profile chromaticity), so we go:
      //   sRGB (D65) → linear → XYZ_D65 → Bradford adapt → XYZ_D50 → Lab_D50
      // The pre-audit RGBC form did not round-trip and may have silently
      // no-op'd. Verified against ScriptListener UI ground truth —
      // 2026-06-03 AM Descriptor Audit STEP 38, spec at
      // src/spec/ps27/selection/color-range.ts.
      function _srgbToLin(c) {
        c = c / 255.0;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      }
      function _labF(t) {
        return t > 0.008856451679035631
          ? Math.pow(t, 1.0 / 3.0)
          : t * 7.787037037037037 + 0.13793103448275862;
      }
      function _rgbToLab(r, g, b) {
        var rl = _srgbToLin(r);
        var gl = _srgbToLin(g);
        var bl = _srgbToLin(b);
        // Linear sRGB → CIE XYZ (D65, BT.709/sRGB matrix).
        var X65 = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
        var Y65 = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
        var Z65 = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;
        // Bradford chromatic adaptation D65 → D50, matching Adobe's
        // ICC pipeline for sRGB → Lab working-space.
        var X50 = X65 *  1.0478112 + Y65 *  0.0228866 + Z65 * -0.0501270;
        var Y50 = X65 *  0.0295424 + Y65 *  0.9904844 + Z65 * -0.0170491;
        var Z50 = X65 * -0.0092345 + Y65 *  0.0150436 + Z65 *  0.7521316;
        // D50 white point (Xn=0.96422, Yn=1.0, Zn=0.82521).
        var fx = _labF(X50 / 0.96422);
        var fy = _labF(Y50 / 1.00000);
        var fz = _labF(Z50 / 0.82521);
        return {
          L: 116 * fy - 16,
          a: 500 * (fx - fy),
          b: 200 * (fy - fz)
        };
      }
      var __lab = _rgbToLab(%s, %s, %s);

      var clrRDesc = new ActionDescriptor();
      clrRDesc.putInteger(charIDToTypeID('Fzns'), %s);
      // colorModel = 0 selects the "sampled colors Lab" algorithm
      // (default UI behaviour). Pre-audit snippet omitted this key —
      // PS may have fallen back to a less-precise default.
      clrRDesc.putInteger(stringIDToTypeID('colorModel'), 0);

      function _mkLabDesc(L, a, b) {
        var d = new ActionDescriptor();
        d.putDouble(charIDToTypeID('Lmnc'), L);
        d.putDouble(charIDToTypeID('A   '), a);
        d.putDouble(charIDToTypeID('B   '), b);
        return d;
      }

      // For a single-target color range, Mnm and Mxm are the same Lab
      // color; Fzns defines the band around it.
      clrRDesc.putObject(charIDToTypeID('Mnm '), charIDToTypeID('LbCl'), _mkLabDesc(__lab.L, __lab.a, __lab.b));
      clrRDesc.putObject(charIDToTypeID('Mxm '), charIDToTypeID('LbCl'), _mkLabDesc(__lab.L, __lab.a, __lab.b));

      executeAction(charIDToTypeID('ClrR'), clrRDesc, DialogModes.NO);
    } catch (eRun) {
      if (savedCh) { try { savedCh.remove(); } catch (e) {} }
      // Early-exit contract — see selectionTypeHelpers docstring.
      restoreCompositeChannel(doc);
      throw new Error('Select Color Range failed: ' + eRun.message);
    }
    combineWithSavedSelection(doc, savedCh, selType);

    return {
      selected: true,
      method: 'color_range',
      target_color: { red: %s, green: %s, blue: %s },
      fuzziness: %s,
      selection_type: selType,
      selection_info: getSelectionInfo()
    };
  `,

		// selectColorPreset — AM ClrR Clrs-enum presets (skin_tones / out_of_gamut).
		// Mirrors selectColorRange's channel-stash selection-type pattern; the
		// preset-specific descriptor block (slot 4) is built by the emitter. Slots:
		// 1=selectionTypeHelpers, 2=getSelectionInfo, 3=selType(jsLit), 4=descriptor
		// block, 5=preset(jsLit, result). Ground truth: m1-selection STEP-35.
		vault.SelClrPre: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var selType = %s;

    var savedCh = (selType === 'replace') ? null : saveSelectionToTempChannel(doc);
    try {
      var clrRDesc = new ActionDescriptor();
      %s
      executeAction(charIDToTypeID('ClrR'), clrRDesc, DialogModes.NO);
    } catch (eRun) {
      if (savedCh) { try { savedCh.remove(); } catch (e) {} }
      restoreCompositeChannel(doc);
      throw new Error('Select Color Preset failed: ' + eRun.message);
    }
    combineWithSavedSelection(doc, savedCh, selType);

    return {
      selected: true,
      method: 'color_preset',
      preset: %s,
      selection_type: selType,
      selection_info: getSelectionInfo()
    };
  `,

		// selectLuminanceRange — AM ClrR luminance modes (Highlights/Shadows/
		// Midtones). Mirrors selectColorRange's channel-stash selection-type pattern;
		// the mode-specific descriptor puts + result fields are built by the emitter.
		// Slots: 1=selectionTypeHelpers, 2=getSelectionInfo, 3=selType(jsLit),
		// 4=descriptor block, 5=mode(jsLit), 6=result fields. Ground truth
		// confirmed via ScriptListener capture.
		vault.LumRange: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var selType = %s;

    var savedCh = (selType === 'replace') ? null : saveSelectionToTempChannel(doc);
    try {
      var clrRDesc = new ActionDescriptor();
      %s
      executeAction(charIDToTypeID('ClrR'), clrRDesc, DialogModes.NO);
    } catch (eRun) {
      if (savedCh) { try { savedCh.remove(); } catch (e) {} }
      restoreCompositeChannel(doc);
      throw new Error('Select Luminance Range failed: ' + eRun.message);
    }
    combineWithSavedSelection(doc, savedCh, selType);

    return {
      selected: true,
      method: 'luminance_range',
      luminance: %s,
      %s
      selection_type: selType,
      selection_info: getSelectionInfo()
    };
  `,

		// refineEdge — AM smartBrushWorkspace (Select-and-Mask sliders, output to
		// selection). Refines the CURRENT selection headlessly. Slots:
		// 1=getSelectionInfo, 2=helperFunctions, 3=radius, 4=smooth, 5=feather,
		// 6=contrast, 7=shiftEdge, 8=decontaminate(bool), then result: 9=radius,
		// 10=smooth, 11=feather, 12=contrast, 13=shiftEdge, 14=decontaminate.
		// Ground truth confirmed via ScriptListener capture.
		vault.RefineEdge: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var sbDesc = new ActionDescriptor();
    sbDesc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
    sbDesc.putInteger(sTID('smartBrushRadius'), %s);
    sbDesc.putInteger(sTID('smartBrushSmooth'), %s);
    sbDesc.putUnitDouble(sTID('smartBrushFeather'), cTID('#Pxl'), %s);
    sbDesc.putUnitDouble(sTID('smartBrushContrast'), cTID('#Prc'), %s);
    sbDesc.putUnitDouble(sTID('smartBrushShiftEdge'), cTID('#Prc'), %s);
    sbDesc.putBoolean(sTID('sampleAllLayers'), false);
    sbDesc.putBoolean(sTID('smartBrushUseSmartRadius'), false);
    sbDesc.putBoolean(sTID('smartBrushUseDeepMatte'), false);
    sbDesc.putBoolean(sTID('autoTrimap'), false);
    sbDesc.putBoolean(sTID('smartBrushDecontaminate'), %s);
    sbDesc.putUnitDouble(sTID('smartBrushDeconAmount'), cTID('#Prc'), 100.0);
    sbDesc.putEnumerated(sTID('refineEdgeOutput'), sTID('refineEdgeOutput'), sTID('selectionOutputToSelection'));
    try {
      executeAction(sTID('smartBrushWorkspace'), sbDesc, DialogModes.NO);
    } catch (eRun) {
      throw new Error('Refine Edge failed (requires an active selection): ' + eRun.message);
    }

    return {
      refined: true,
      radius: %s,
      smooth: %s,
      feather: %s,
      contrast: %s,
      shift_edge: %s,
      decontaminate: %s,
      output: 'selection',
      selection_info: getSelectionInfo()
    };
  `,

		// magicWand. Slots: 1=selectionTypeHelpers, 2=getSelectionInfo,
		// 3=selectionType(jsLit), 4=x, 5=y, 6=tolerance, 7=antiAlias(jsBool),
		// 8=contiguous(jsBool), 9=sampleAllLayers(jsBool), 10=x, 11=y,
		// 12=tolerance, 13=contiguous, 14=antiAlias, 15=sampleAllLayers (result).
		vault.MagicWand: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var selType = %s;

    var savedCh = (selType === 'replace') ? null : saveSelectionToTempChannel(doc);
    try {
      var setdDesc = new ActionDescriptor();

      var fselRef = new ActionReference();
      fselRef.putProperty(charIDToTypeID('Chnl'), charIDToTypeID('fsel'));
      setdDesc.putReference(charIDToTypeID('null'), fselRef);

      var pntDesc = new ActionDescriptor();
      pntDesc.putUnitDouble(charIDToTypeID('Hrzn'), charIDToTypeID('#Pxl'), %s);
      pntDesc.putUnitDouble(charIDToTypeID('Vrtc'), charIDToTypeID('#Pxl'), %s);
      setdDesc.putObject(charIDToTypeID('T   '), charIDToTypeID('Pnt '), pntDesc);

      setdDesc.putInteger(charIDToTypeID('Tlrn'), %s);
      setdDesc.putBoolean(charIDToTypeID('AntA'), %s);
      setdDesc.putBoolean(charIDToTypeID('Cntg'), %s);
      setdDesc.putBoolean(charIDToTypeID('Mrgd'), %s);

      executeAction(charIDToTypeID('setd'), setdDesc, DialogModes.NO);
    } catch (eRun) {
      if (savedCh) { try { savedCh.remove(); } catch (e) {} }
      // Early-exit contract — see selectionTypeHelpers docstring.
      restoreCompositeChannel(doc);
      throw new Error('Magic Wand failed: ' + eRun.message);
    }
    combineWithSavedSelection(doc, savedCh, selType);

    return {
      selected: true,
      method: 'magic_wand',
      sample_point: { x: %s, y: %s },
      tolerance: %s,
      contiguous: %s,
      anti_alias: %s,
      sample_all_layers: %s,
      selection_type: selType,
      selection_info: getSelectionInfo()
    };
  `,

		// getSelectionPreview. Slots: 1=getSelectionInfo, 2=restoreCompositeChannel,
		// 3=maxDim, 4=overlayPath(jsLit), 5=maskPath(jsLit), 6=overlayPath(jsLit),
		// 7=maskPath(jsLit).
		vault.SelPreview: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // No-selection case — still render the document so the agent can see
    // what the canvas looks like, and return has_selection: false.
    var probeRef = new ActionReference();
    probeRef.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('fsel'));
    probeRef.putEnumerated(app.charIDToTypeID('Dcmn'), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
    var hasSel = app.executeActionGet(probeRef).hasKey(app.charIDToTypeID('fsel'));
    if (!hasSel) {
      return {
        rendered: false,
        reason: 'no_active_selection',
        selection_info: getSelectionInfo()
      };
    }

    function downscale(d, maxD) {
      var w = d.width.as('px'), h = d.height.as('px');
      var longE = (w > h) ? w : h;
      if (longE > maxD) {
        var scale = maxD / longE;
        d.resizeImage(UnitValue(Math.round(w * scale), 'px'), UnitValue(Math.round(h * scale), 'px'), null, ResampleMethod.BICUBIC);
      }
    }
    function saveJpeg(d, p) {
      var opts = new JPEGSaveOptions();
      opts.quality = 7;
      opts.embedColorProfile = false;
      opts.formatOptions = FormatOptions.STANDARDBASELINE;
      d.saveAs(new File(p), opts, true, Extension.LOWERCASE);
    }

    // Stash selection to an alpha channel on the source. The channel name
    // is unique-ish per call so the duplicates can resolve it by name
    // instead of trusting that "last channel = ours" (which is fragile in
    // documents that already have user alpha channels added between ops).
    var maxD = %s;
    var overlayDup = null, maskDup = null;
    var srcCh = null;
    var srcChName = '__mcp_sel_preview_' + (new Date()).getTime() + '_' + Math.floor(Math.random() * 100000);

    function findChannelByName(d, name) {
      for (var i = 0; i < d.channels.length; i++) {
        if (String(d.channels[i].name) === name) return d.channels[i];
      }
      return null;
    }

    try {
      srcCh = doc.channels.add();
      srcCh.name = srcChName;
      doc.selection.store(srcCh, SelectionType.REPLACE);

      // ── OVERLAY: photo + red wash over selected area ──────────────────
      overlayDup = doc.duplicate(doc.name + ' __mcp_sel_overlay__');
      overlayDup.flatten();
      // Resolve channel by name (defensive — survives unrelated user channels)
      var oCh = findChannelByName(overlayDup, srcChName);
      if (!oCh) throw new Error('overlay duplicate lost the stash channel: ' + srcChName);
      overlayDup.selection.load(oCh, SelectionType.REPLACE);
      // Fill the selection on a new layer with a 50%% red wash (Quick Mask-style)
      overlayDup.artLayers.add();
      var redColor = new SolidColor();
      redColor.rgb.red = 255; redColor.rgb.green = 0; redColor.rgb.blue = 0;
      overlayDup.selection.fill(redColor, ColorBlendMode.NORMAL, 50, false);
      overlayDup.selection.deselect();
      overlayDup.flatten();
      downscale(overlayDup, maxD);
      saveJpeg(overlayDup, %s);
      overlayDup.close(SaveOptions.DONOTSAVECHANGES);
      overlayDup = null;

      // ── MASK: white canvas, black inside selection ────────────────────
      maskDup = doc.duplicate(doc.name + ' __mcp_sel_mask__');
      maskDup.flatten();
      var mCh = findChannelByName(maskDup, srcChName);
      if (!mCh) throw new Error('mask duplicate lost the stash channel: ' + srcChName);
      // White fill across the whole canvas first
      maskDup.selection.selectAll();
      var white = new SolidColor(); white.rgb.red = 255; white.rgb.green = 255; white.rgb.blue = 255;
      maskDup.selection.fill(white);
      // Load the channel as selection and fill black
      maskDup.selection.load(mCh, SelectionType.REPLACE);
      var black = new SolidColor(); black.rgb.red = 0; black.rgb.green = 0; black.rgb.blue = 0;
      maskDup.selection.fill(black);
      maskDup.selection.deselect();
      maskDup.flatten();
      downscale(maskDup, maxD);
      saveJpeg(maskDup, %s);
      maskDup.close(SaveOptions.DONOTSAVECHANGES);
      maskDup = null;
    } catch (eRender) {
      if (overlayDup) { try { overlayDup.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {} }
      if (maskDup) { try { maskDup.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {} }
      try { app.activeDocument = doc; } catch (e) {}
      if (srcCh) { try { srcCh.remove(); } catch (e) {} }
      // CRITICAL: restore composite channel even on the failure path.
      // doc.channels.add() left an alpha channel active; without this
      // restore a subsequent caller (e.g. ps_layer_mask)
      // fails with "command 'Make' is not currently available."
      // See restoreCompositeChannel docstring at top of extendscript.ts.
      restoreCompositeChannel(doc);
      throw new Error('Selection preview render failed: ' + eRender.message);
    }

    // Restore source active doc, delete the temp channel, AND restore the
    // composite channel as the active channel. The remove() above does
    // not reliably restore composite — PS leaves the doc in an
    // indeterminate channel state, and a subsequent create_layer_mask
    // call would then fail with "command 'Make' is not currently
    // available." See restoreCompositeChannel docstring above.
    try { app.activeDocument = doc; } catch (e) {}
    if (srcCh) { try { srcCh.remove(); } catch (e) {} }
    restoreCompositeChannel(doc);

    return {
      rendered: true,
      overlay_path: %s,
      mask_path: %s,
      max_dimension: maxD,
      selection_info: getSelectionInfo()
    };
  `,

		// saveSelectionToChannel. Slots: 1=getSelectionInfo, 2=channelName(jsLit).
		vault.SaveSelCh: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // Check for active selection via AM (raw bounds throws on PS 2024+).
    var ref = new ActionReference();
    ref.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('fsel'));
    ref.putEnumerated(app.charIDToTypeID('Dcmn'), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
    var hasSelection = app.executeActionGet(ref).hasKey(app.charIDToTypeID('fsel'));
    if (!hasSelection) {
      throw new Error('No active selection to save');
    }

    var chName = %s;

    // Find existing alpha channel with this name; skip component channels.
    var targetCh = null;
    var wasOverwritten = false;
    for (var i = 0; i < doc.channels.length; i++) {
      var ch = doc.channels[i];
      if (ch.kind !== ChannelType.COMPONENT && ch.name === chName) {
        targetCh = ch;
        wasOverwritten = true;
        break;
      }
    }
    if (!targetCh) {
      targetCh = doc.channels.add();
      targetCh.name = chName;
    }

    doc.selection.store(targetCh, SelectionType.REPLACE);

    return {
      saved: true,
      channel_name: chName,
      overwritten: wasOverwritten,
      channel_count: doc.channels.length,
      selection_info: getSelectionInfo()
    };
  `,

		// loadSelectionFromChannel. Slots: 1=getSelectionInfo, 2=channelName(jsLit),
		// 3=operation(jsLit).
		vault.LoadSelCh: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var chName = %s;
    var operation = %s;

    // Find the named alpha channel; skip component channels.
    var targetCh = null;
    for (var i = 0; i < doc.channels.length; i++) {
      var ch = doc.channels[i];
      if (ch.kind !== ChannelType.COMPONENT && ch.name === chName) {
        targetCh = ch;
        break;
      }
    }
    if (!targetCh) {
      throw new Error('No alpha channel named "' + chName + '" found. Use ps_selection_channel to create one first.');
    }

    // Map operation to SelectionType.
    var selType;
    if (operation === 'add') { selType = SelectionType.EXTEND; }
    else if (operation === 'subtract') { selType = SelectionType.DIMINISH; }
    else if (operation === 'intersect') { selType = SelectionType.INTERSECT; }
    else { selType = SelectionType.REPLACE; }

    doc.selection.load(targetCh, selType);

    return {
      loaded: true,
      channel_name: chName,
      operation: operation,
      selection_info: getSelectionInfo()
    };
  `,

		// duplicateChannel (s20) — DOM duplicate of a named alpha channel within the same
		// document. Skips component channels (RGB/CMYK/Lab) when matching the source name.
		// Optional new name; PS auto-names ("<src> copy") when omitted. Ground truth:
		// m4a STEP-12 (Dplc Chnl). DOM channel.duplicate() is the documented, reliable
		// path (preferred over AM ref-building per the convert_image_mode lesson). Slots:
		// 1=getMinimalContextInfo, 2=channelName(jsLit), 3=newName(jsLit or 'null'),
		// 4=hasNewName(bool).
		vault.ChanDup: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var chName = %s;
    var newName = %s;
    var hasNewName = %s;

    var srcCh = null;
    for (var i = 0; i < doc.channels.length; i++) {
      var ch = doc.channels[i];
      if (ch.kind !== ChannelType.COMPONENT && ch.name === chName) {
        srcCh = ch;
        break;
      }
    }
    if (!srcCh) {
      throw new Error('No alpha/spot channel named "' + chName + '" found to duplicate.');
    }

    var dupCh = srcCh.duplicate();
    if (hasNewName) {
      dupCh.name = newName;
    }

    return {
      duplicated: true,
      channel_name: chName,
      new_channel_name: dupCh.name,
      channel_count: doc.channels.length,
      context: getMinimalContextInfo()
    };
  `,

		// deleteChannel (s21) — DOM remove of a named channel. Alpha-only guard: refuses
		// to delete component (RGB/CMYK/Lab) channels, which would change the image mode /
		// corrupt the document. Ground truth: m4a STEP-13 (Dlt Chnl). Slots:
		// 1=getMinimalContextInfo, 2=channelName(jsLit).
		vault.ChanDel: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var chName = %s;

    var targetCh = null;
    for (var i = 0; i < doc.channels.length; i++) {
      var ch = doc.channels[i];
      if (ch.name === chName) {
        targetCh = ch;
        break;
      }
    }
    if (!targetCh) {
      throw new Error('No channel named "' + chName + '" found to delete.');
    }
    if (targetCh.kind === ChannelType.COMPONENT) {
      throw new Error('Refusing to delete component channel "' + chName + '" (would corrupt the image mode). Only alpha/spot channels can be deleted.');
    }

    targetCh.remove();

    return {
      deleted: true,
      channel_name: chName,
      channel_count: doc.channels.length,
      context: getMinimalContextInfo()
    };
  `,

		// applyImage (ci1) — AM AppI: composite a source (layer + channel) onto the
		// ACTIVE layer via a calculation blend mode. Destructive pixel bake, so the
		// emitter prepends duplicateForOp (auto-duplicate-first) — the op lands on a
		// copy by default. Ground truth: m4a STEP-09 (AppI → With:Clcl{ T:ref(Chnl,Lyr),
		// Clcl:Clcn enum }). __amSrcRef builds the channel+layer reference: channel by
		// enum charID (RGB/Rd/Grn/Bl) or by name (alpha); layer merged (Mrgd) or by name.
		// Slots: 1=getContextInfo, 2=duplicateForOp fragment, 3=chanCharID(jsLit),
		// 4=chanAlphaName(jsLit|null), 5=layerName(jsLit|null), 6=blendCharID(jsLit),
		// 7=opacity(jsNum).
		vault.ApplyImage: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    %s

    function __amSrcRef(chanCharID, chanAlphaName, layerName) {
      var r = new ActionReference();
      if (chanAlphaName) {
        r.putName(app.charIDToTypeID('Chnl'), chanAlphaName);
      } else {
        r.putEnumerated(app.charIDToTypeID('Chnl'), app.charIDToTypeID('Chnl'), app.charIDToTypeID(chanCharID));
      }
      if (layerName) {
        r.putName(app.charIDToTypeID('Lyr '), layerName);
      } else {
        r.putEnumerated(app.charIDToTypeID('Lyr '), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Mrgd'));
      }
      return r;
    }

    var __chanCharID = %s;
    var __chanAlphaName = %s;
    var __layerName = %s;
    var __blend = %s;
    var __opacity = %s;

    var __with = new ActionDescriptor();
    __with.putReference(app.charIDToTypeID('T   '), __amSrcRef(__chanCharID, __chanAlphaName, __layerName));
    __with.putEnumerated(app.charIDToTypeID('Clcl'), app.charIDToTypeID('Clcn'), app.charIDToTypeID(__blend));
    if (__opacity < 100) {
      __with.putInteger(app.charIDToTypeID('Opct'), __opacity);
    }

    var __desc = new ActionDescriptor();
    __desc.putObject(app.charIDToTypeID('With'), app.charIDToTypeID('Clcl'), __with);
    app.executeAction(app.charIDToTypeID('AppI'), __desc, DialogModes.NO);

    return {
      applied: true,
      source_channel: __chanAlphaName ? __chanAlphaName : __chanCharID,
      source_layer: __layerName ? __layerName : 'merged',
      blend: __blend,
      opacity: __opacity,
      target_was_copy: (typeof __opTargetIsCopy !== 'undefined') ? __opTargetIsCopy : false,
      target_layer_name: doc.activeLayer.name,
      context: getContextInfo()
    };
  `,

		// calculations (ci2) — AM Mk Chnl Using Clcl: blend TWO sources (each layer +
		// channel) into a NEW alpha channel. Ground truth: m4a STEP-10 (Mk{ Nw:class Chnl,
		// Usng:Clcl{ T:ref(src1), Clcl:Clcn enum, Src2:ref(src2) }}). Reuses the same
		// __amSrcRef builder as applyImage. Slots: 1=getContextInfo, 2=s1ChanCharID(jsLit),
		// 3=s1AlphaName(jsLit|null), 4=s1LayerName(jsLit|null), 5=s2ChanCharID(jsLit),
		// 6=s2AlphaName(jsLit|null), 7=s2LayerName(jsLit|null), 8=blendCharID(jsLit),
		// 9=opacity(jsNum).
		vault.Calculations: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    function __amSrcRef(chanCharID, chanAlphaName, layerName) {
      var r = new ActionReference();
      if (chanAlphaName) {
        r.putName(app.charIDToTypeID('Chnl'), chanAlphaName);
      } else {
        r.putEnumerated(app.charIDToTypeID('Chnl'), app.charIDToTypeID('Chnl'), app.charIDToTypeID(chanCharID));
      }
      if (layerName) {
        r.putName(app.charIDToTypeID('Lyr '), layerName);
      } else {
        r.putEnumerated(app.charIDToTypeID('Lyr '), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Mrgd'));
      }
      return r;
    }

    var __s1c = %s, __s1a = %s, __s1l = %s;
    var __s2c = %s, __s2a = %s, __s2l = %s;
    var __blend = %s, __opacity = %s;

    var __using = new ActionDescriptor();
    __using.putReference(app.charIDToTypeID('T   '), __amSrcRef(__s1c, __s1a, __s1l));
    __using.putEnumerated(app.charIDToTypeID('Clcl'), app.charIDToTypeID('Clcn'), app.charIDToTypeID(__blend));
    __using.putReference(app.charIDToTypeID('Src2'), __amSrcRef(__s2c, __s2a, __s2l));
    if (__opacity < 100) {
      __using.putInteger(app.charIDToTypeID('Opct'), __opacity);
    }

    var __mk = new ActionDescriptor();
    __mk.putClass(app.charIDToTypeID('Nw  '), app.charIDToTypeID('Chnl'));
    __mk.putObject(app.charIDToTypeID('Usng'), app.charIDToTypeID('Clcl'), __using);
    app.executeAction(app.charIDToTypeID('Mk  '), __mk, DialogModes.NO);

    var __newCh = doc.channels[doc.channels.length - 1];
    return {
      calculated: true,
      new_channel_name: __newCh.name,
      channel_count: doc.channels.length,
      blend: __blend,
      opacity: __opacity,
      context: getMinimalContextInfo()
    };
  `,
	})
}
