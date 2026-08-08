package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// retouch family — content-aware fill / patch / content-aware move.
		// Community-tier (previously Pro, in
		// fragments_pro.go). Slot orders documented at each emitter in
		// go-core/retouch.go.
		vault.RtCAF: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // Selection check FIRST — before we duplicate. If no selection,
    // Content-Aware Fill would fill the entire layer (destructive silent
    // surprise). Use ActionReference probe (DOM doc.selection.bounds
    // throws uncatchable error 1302 on no-selection in PS 2024+).
    var __selRef = new ActionReference();
    __selRef.putProperty(cTID('Prpr'), cTID('fsel'));
    __selRef.putEnumerated(cTID('Dcmn'), cTID('Ordn'), cTID('Trgt'));
    if (!executeActionGet(__selRef).hasKey(cTID('fsel'))) {
      throw new Error('Content-Aware Fill requires an active selection. Make a selection first.');
    }

    %s

    var layer = doc.activeLayer;

    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Content-Aware Fill requires a pixel layer (kind=' + layer.kind + ').');
    }

    // Map the snake_case blend_mode name to PS's charID. Only the
    // common photographic blend modes are mapped; unknown values fall
    // back to Normal. Add more here as needed.
    var __bmName = %s;
    var __bmCharID;
    switch (__bmName) {
      case 'multiply':     __bmCharID = cTID('Mltp'); break;
      case 'screen':       __bmCharID = cTID('Scrn'); break;
      case 'overlay':      __bmCharID = cTID('Ovrl'); break;
      case 'soft_light':   __bmCharID = cTID('SftL'); break;
      case 'hard_light':   __bmCharID = cTID('HrdL'); break;
      case 'darken':       __bmCharID = cTID('Drkn'); break;
      case 'lighten':      __bmCharID = cTID('Lghn'); break;
      case 'difference':   __bmCharID = cTID('Dfrn'); break;
      case 'color_burn':   __bmCharID = cTID('CBrn'); break;
      case 'color_dodge':  __bmCharID = cTID('CDdg'); break;
      case 'linear_burn':  __bmCharID = sTID('linearBurn'); break;
      case 'linear_dodge': __bmCharID = sTID('linearDodge'); break;
      case 'normal':
      default:             __bmCharID = cTID('Nrml'); break;
    }

    var fillDesc = new ActionDescriptor();
    fillDesc.putEnumerated(cTID('Usng'), cTID('FlCn'), sTID('contentAware'));
    fillDesc.putBoolean(sTID('contentAwareColorAdaptationFill'), %s);
    fillDesc.putBoolean(sTID('contentAwareRotateFill'), %s);
    fillDesc.putBoolean(sTID('contentAwareScaleFill'), %s);
    fillDesc.putBoolean(sTID('contentAwareMirrorFill'), %s);
    fillDesc.putUnitDouble(cTID('Opct'), cTID('#Prc'), %s);
    fillDesc.putEnumerated(cTID('Md  '), cTID('BlnM'), __bmCharID);

    executeAction(cTID('Fl  '), fillDesc, DialogModes.NO);

    return {
      retouch: 'Content-Aware Fill',
      color_adaptation: %s,
      rotate: %s,
      scale: %s,
      mirror: %s,
      opacity: %s,
      blend_mode: __bmName,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		vault.RtPatch: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // Selection check — Patch targets the current selection.
    var __selRef = new ActionReference();
    __selRef.putProperty(cTID('Prpr'), cTID('fsel'));
    __selRef.putEnumerated(cTID('Dcmn'), cTID('Ordn'), cTID('Trgt'));
    if (!executeActionGet(__selRef).hasKey(cTID('fsel'))) {
      throw new Error('Patch requires an active selection. Make a selection around the blemish first.');
    }

    %s

    var layer = doc.activeLayer;

    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Patch requires a pixel layer (kind=' + layer.kind + ').');
    }

    var patchDesc = new ActionDescriptor();

    // Target: current selection via Chnl/fsel property reference.
    var __ref = new ActionReference();
    __ref.putProperty(cTID('Chnl'), cTID('fsel'));
    patchDesc.putReference(cTID('null'), __ref);

    // From → Ofst sub-object with Hrzn/Vrtc.
    var offDesc = new ActionDescriptor();
    offDesc.putUnitDouble(cTID('Hrzn'), cTID('#Pxl'), %s);
    offDesc.putUnitDouble(cTID('Vrtc'), cTID('#Pxl'), %s);
    patchDesc.putObject(cTID('From'), cTID('Ofst'), offDesc);

    patchDesc.putBoolean(cTID('Trns'), %s);
    patchDesc.putEnumerated(sTID('patchMode'), sTID('patchModeType'), sTID('patchContentAware'));
    patchDesc.putBoolean(sTID('reshuffle'), false);
    patchDesc.putBoolean(sTID('sampleAllLayers'), %s);
    patchDesc.putInteger(sTID('patchStructureAdapt'), %s);
    patchDesc.putInteger(sTID('patchColorAdaptation'), %s);
    patchDesc.putInteger(sTID('healSmoothFactor'), %s);
    patchDesc.putBoolean(sTID('useSource'), %s);

    executeAction(sTID('patchSelection'), patchDesc, DialogModes.NO);

    return {
      retouch: 'Patch (Content-Aware)',
      offset_x: %s,
      offset_y: %s,
      patch_structure: %s,
      patch_color: %s,
      heal_smooth_factor: %s,
      sample_all_layers: %s,
      transparent: %s,
      use_source: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		vault.RtCAM: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // Selection check — CAM targets the current selection.
    var __selRef = new ActionReference();
    __selRef.putProperty(cTID('Prpr'), cTID('fsel'));
    __selRef.putEnumerated(cTID('Dcmn'), cTID('Ordn'), cTID('Trgt'));
    if (!executeActionGet(__selRef).hasKey(cTID('fsel'))) {
      throw new Error('Content-Aware Move requires an active selection. Make a selection around the content to move first.');
    }

    %s

    var layer = doc.activeLayer;

    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Content-Aware Move requires a pixel layer (kind=' + layer.kind + ').');
    }

    var camDesc = new ActionDescriptor();

    // Target: current selection.
    var __ref = new ActionReference();
    __ref.putProperty(cTID('Chnl'), cTID('fsel'));
    camDesc.putReference(cTID('null'), __ref);

    // T (THREE trailing spaces — NOT 'From' like Patch) → Ofst sub-object.
    var offDesc = new ActionDescriptor();
    offDesc.putUnitDouble(cTID('Hrzn'), cTID('#Pxl'), %s);
    offDesc.putUnitDouble(cTID('Vrtc'), cTID('#Pxl'), %s);
    camDesc.putObject(cTID('T   '), cTID('Ofst'), offDesc);

    camDesc.putBoolean(cTID('Trns'), %s);
    camDesc.putEnumerated(sTID('patchMode'), sTID('patchModeType'), sTID('patchContentAware'));
    camDesc.putEnumerated(sTID('remixMode'), sTID('remixModeType'), sTID('remixMove'));
    camDesc.putBoolean(sTID('reshuffle'), %s);
    camDesc.putBoolean(sTID('clone'), false);
    camDesc.putBoolean(sTID('sampleAllLayers'), %s);
    camDesc.putBoolean(sTID('transformOnDrop'), false);
    camDesc.putInteger(sTID('patchStructureAdapt'), %s);
    camDesc.putInteger(sTID('patchColorAdaptation'), %s);
    camDesc.putInteger(sTID('healSmoothFactor'), %s);
    camDesc.putBoolean(sTID('useSource'), false);

    executeAction(sTID('recomposeSelection'), camDesc, DialogModes.NO);

    return {
      retouch: 'Content-Aware Move',
      offset_x: %s,
      offset_y: %s,
      mode: 'move',
      patch_structure: %s,
      patch_color: %s,
      heal_smooth_factor: %s,
      sample_all_layers: %s,
      transparent: %s,
      reshuffle: %s,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,
	})
}
