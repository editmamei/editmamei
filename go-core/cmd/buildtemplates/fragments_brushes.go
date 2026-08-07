package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// BrushOuter (br0) — main scaffold.
		// Slots (19 total):
		//   1  = getContextInfo body
		//   2  = duplicateForOp body
		//   3  = dynSaveBlock (BrushDynSave or "")
		//   4  = fgColorBlock (BrushFgColor or "")
		//   5  = presetBlock (BrushPreset or "var __bw_presetApplied = null;")
		//   6  = brush_size number
		//   7  = cloneBlock (BrushClone or "")
		//   8  = dynMutateBlock (BrushDynWrite or "")
		//   9  = pointConstructions (assembled from BrushPoint per anchor)
		//   10 = closed ("true"/"false")
		//   11 = pointArrayLiteral
		//   12 = TOOL_CONST (for strokePath)
		//   13 = jsLit(tool)
		//   14 = TOOL_CONST (for tool_type string)
		//   15 = jsNum(brush_size) (for return)
		//   16 = jsBool(isSourceTool && hasSource)
		//   17 = jsNum(numAnchors)
		//   18 = jsBool(closed)
		//   19 = dynRestoreBlock (BrushDynRst or "")
		vault.BrushOuter: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;

    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error(
        'brush-stroke: active layer must be a pixel layer (kind=' +
        String(layer.kind) + '). Rasterize, select a pixel layer, or stamp visible first.'
      );
    }
    if (layer.allLocked || layer.pixelsLocked) {
      throw new Error('brush-stroke: active layer is locked. Unlock before stroking.');
    }

    var __bw_backgroundPromoted = false;
    if (layer.isBackgroundLayer) {
      try {
        layer.isBackgroundLayer = false;
        __bw_backgroundPromoted = true;
      } catch (eBg) {
        throw new Error('brush-stroke: could not promote background layer: ' + eBg.message);
      }
    }

    %s

    var __bw_savedFg = app.foregroundColor;
    var __bw_savedToolOptions = null;
    var __bw_savedTool = null;

    %s

    try {
      %s

      %s

      // A brush-family tool must be the ACTIVE tool for the Brsh.Trgt
      // "current brush" target to accept a setd — otherwise PS throws
      // "command Set is not currently available" (the active tool after a
      // fresh doc/layer is usually Move). The brush tip diameter is a shared
      // resource across all brush tools, so activating paintbrushTool here is
      // enough to size the shared tip before strokePath() applies the caller's
      // actual ToolType. Restored in finally.
      try { __bw_savedTool = app.currentTool; app.currentTool = 'paintbrushTool'; } catch (eTa) {}

      // Brush SIZE via Brsh.Trgt masterDiameter — which only takes once a brush
      // PRESET is the current brush. The preset block above now ALWAYS selects one
      // (a default 'Soft Round' when none was named), so this sizes correctly.
      // History (PS 2026): with NO active preset this set produced a 1px tip
      // (apply_brush_stroke "stroked" but invisible); the currentToolOptions.brush
      // .diameter route — the obvious "live brush" path — is REJECTED on PS 2026
      // ("not available in this version"). The preset + masterDiameter route is the
      // one that works: live-verified 2026-06-26, size 15 → ~24px band, 120 → ~193px
      // (soft falloff widens the bounds past the nominal diameter, but width tracks
      // the request). Non-fatal: stroke at the current size beats aborting.
      var __bw_sizeApplied = false;
      try {
        var __bw_sd = new ActionDescriptor();
        var __bw_sr = new ActionReference();
        __bw_sr.putEnumerated(
          app.charIDToTypeID('Brsh'),
          app.charIDToTypeID('Ordn'),
          app.charIDToTypeID('Trgt')
        );
        __bw_sd.putReference(app.charIDToTypeID('null'), __bw_sr);
        var __bw_sinner = new ActionDescriptor();
        __bw_sinner.putUnitDouble(app.stringIDToTypeID('masterDiameter'), app.charIDToTypeID('#Pxl'), %s);
        __bw_sd.putObject(app.charIDToTypeID('T   '), app.charIDToTypeID('Brsh'), __bw_sinner);
        executeAction(app.charIDToTypeID('setd'), __bw_sd, DialogModes.NO);
        __bw_sizeApplied = true;
      } catch (eSz) {
        __bw_sizeApplied = false;
      }

      %s

      var __bw_hardnessApplied = false;
      var __bw_opacityApplied = false;
      var __bw_flowApplied = false;

      %s

      %s
      var __bw_sub = new SubPathInfo();
      __bw_sub.closed = %s;
      __bw_sub.operation = ShapeOperation.SHAPEXOR;
      __bw_sub.entireSubPath = [%s];

      var __bw_pathName = '__bw_stroke_' + new Date().getTime();
      var __bw_path = doc.pathItems.add(__bw_pathName, [__bw_sub]);

      // Stroke the path via the ActionManager 'Strk' command, NOT
      // PathItem.strokePath(): the DOM method is the long-standing Adobe no-op —
      // it "succeeds" but deposits a 1px hairline regardless of the brush (verified
      // live 2026-06-26: DOM band = 1px vs AM band = 147px). The AM 'Strk' strokes
      // the active path with the tool named in 'Usng'; the tool is addressed by its
      // app.currentTool NAME via stringIDToTypeID (also live-verified —
      // Usng=sTID('paintbrushTool') deposits the full-width stroke). We set the
      // tool active first so its per-tool options (opacity/flow/mode) apply; the
      // brush tip diameter was sized above through the shared paintbrush brush.
      var __bw_toolNm = '%s';
      try { app.currentTool = __bw_toolNm; } catch (eTtl) {}
      try {
        var __bw_strkDesc = new ActionDescriptor();
        var __bw_strkRef = new ActionReference();
        __bw_strkRef.putEnumerated(
          app.charIDToTypeID('Path'),
          app.charIDToTypeID('Ordn'),
          app.charIDToTypeID('Trgt')
        );
        __bw_strkDesc.putReference(app.charIDToTypeID('null'), __bw_strkRef);
        __bw_strkDesc.putClass(app.charIDToTypeID('Usng'), app.stringIDToTypeID(__bw_toolNm));
        executeAction(app.charIDToTypeID('Strk'), __bw_strkDesc, DialogModes.NO);
      } catch (eSk) {
        try { __bw_path.remove(); } catch (eR) {}
        throw new Error('brush-stroke: stroke-path (Strk) failed: ' + eSk.message);
      }

      var __bw_pathRemoved = false;
      try {
        __bw_path.remove();
        __bw_pathRemoved = true;
      } catch (eR) {}

      return {
        stroked: true,
        tool: %s,
        tool_type: 'ToolType.%s',
        brush_size: %s,
        preset_applied: __bw_presetApplied,
        size_applied: __bw_sizeApplied,
        hardness_applied: __bw_hardnessApplied,
        opacity_applied: __bw_opacityApplied,
        flow_applied: __bw_flowApplied,
        clone_source_set: %s,
        anchors: %s,
        closed: %s,
        path_removed: __bw_pathRemoved,
        background_promoted: __bw_backgroundPromoted,
        target_was_copy: __opTargetIsCopy,
        target_layer_name: doc.activeLayer.name,
        original_layer_name: __opOriginalName,
        context: getContextInfo()
      };
    } finally {
      try { app.foregroundColor = __bw_savedFg; } catch (eFg) {}
      if (__bw_savedTool !== null) { try { app.currentTool = __bw_savedTool; } catch (eTr) {} }
      %s
    }
  `,

		// BrushFgColor (br1) — foreground color setup. Slots: r, g, b.
		vault.BrushFgColor: `
      var __bw_fg = new SolidColor();
      __bw_fg.rgb.red = %s;
      __bw_fg.rgb.green = %s;
      __bw_fg.rgb.blue = %s;
      app.foregroundColor = __bw_fg;
  `,

		// BrushPreset (br2) — preset selection with Soft/Hard Round fallback. Slot: jsLit(preset).
		vault.BrushPreset: `
      var __bw_presetFallbacks = [%s, 'Soft Round', 'Hard Round'];
      var __bw_presetApplied = null;
      for (var __bw_pi = 0; __bw_pi < __bw_presetFallbacks.length; __bw_pi++) {
        try {
          var __bw_pd = new ActionDescriptor();
          var __bw_pr = new ActionReference();
          __bw_pr.putName(app.charIDToTypeID('Brsh'), __bw_presetFallbacks[__bw_pi]);
          __bw_pd.putReference(app.charIDToTypeID('null'), __bw_pr);
          executeAction(app.charIDToTypeID('slct'), __bw_pd, DialogModes.NO);
          __bw_presetApplied = __bw_presetFallbacks[__bw_pi];
          break;
        } catch (ePre) {}
      }
  `,

		// BrushClone (br4) — clone/healing source descriptor. Slots: sourceLayerNameExpr, x, y.
		vault.BrushClone: `
      var __bw_sourceLayerName = %s;
      try {
        var __bw_cd = new ActionDescriptor();
        var __bw_cr = new ActionReference();
        __bw_cr.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('ClnS'));
        __bw_cr.putEnumerated(
          app.charIDToTypeID('capp'),
          app.charIDToTypeID('Ordn'),
          app.charIDToTypeID('Trgt')
        );
        __bw_cd.putReference(app.charIDToTypeID('null'), __bw_cr);
        var __bw_ct = new ActionDescriptor();
        var __bw_csrc = new ActionReference();
        __bw_csrc.putName(app.charIDToTypeID('Lyr '), __bw_sourceLayerName);
        __bw_ct.putReference(app.charIDToTypeID('Srce'), __bw_csrc);
        var __bw_cpos = new ActionDescriptor();
        __bw_cpos.putUnitDouble(app.charIDToTypeID('Hrzn'), app.charIDToTypeID('#Pxl'), %s);
        __bw_cpos.putUnitDouble(app.charIDToTypeID('Vrtc'), app.charIDToTypeID('#Pxl'), %s);
        __bw_ct.putObject(app.charIDToTypeID('Pstn'), app.charIDToTypeID('Pnt '), __bw_cpos);
        __bw_cd.putObject(app.charIDToTypeID('T   '), app.charIDToTypeID('ImgP'), __bw_ct);
        executeAction(app.charIDToTypeID('setd'), __bw_cd, DialogModes.NO);
      } catch (eCs) {
        throw new Error('brush-stroke: failed to set clone source: ' + eCs.message);
      }
  `,

		// BrushDynSave (br5) — save current tool options for dynamics restore. No slots.
		vault.BrushDynSave: `
      try {
        var __bw_saveRef = new ActionReference();
        __bw_saveRef.putEnumerated(
          app.charIDToTypeID('capp'),
          app.charIDToTypeID('Ordn'),
          app.charIDToTypeID('Trgt')
        );
        __bw_savedToolOptions = executeActionGet(__bw_saveRef).getObjectValue(
          app.stringIDToTypeID('currentToolOptions')
        );
      } catch (eSaveTo) {}
  `,

		// BrushDynWrite (br6) — get + mutate + write-back full tool options descriptor.
		// Slots: opBlock, flBlock, hdBlock (each either a mutation fragment or "").
		vault.BrushDynWrite: `
      try {
        var __bw_dynRef = new ActionReference();
        __bw_dynRef.putEnumerated(
          app.charIDToTypeID('capp'),
          app.charIDToTypeID('Ordn'),
          app.charIDToTypeID('Trgt')
        );
        var __bw_toolDesc = executeActionGet(__bw_dynRef).getObjectValue(
          app.stringIDToTypeID('currentToolOptions')
        );
        %s
        %s
        %s
        var __bw_setDynDesc = new ActionDescriptor();
        var __bw_setDynRef = new ActionReference();
        __bw_setDynRef.putProperty(
          app.charIDToTypeID('Prpr'),
          app.stringIDToTypeID('currentToolOptions')
        );
        __bw_setDynRef.putEnumerated(
          app.charIDToTypeID('capp'),
          app.charIDToTypeID('Ordn'),
          app.charIDToTypeID('Trgt')
        );
        __bw_setDynDesc.putReference(app.charIDToTypeID('null'), __bw_setDynRef);
        __bw_setDynDesc.putObject(
          app.charIDToTypeID('T   '),
          app.stringIDToTypeID('currentToolOptions'),
          __bw_toolDesc
        );
        executeAction(app.charIDToTypeID('setd'), __bw_setDynDesc, DialogModes.NO);
      } catch (eDyn) {}
  `,

		// BrushDynOp (br7) — opacity mutation inside get-mutate-write block. Slot: opacity value.
		vault.BrushDynOp: `
        try {
          __bw_toolDesc.putInteger(app.stringIDToTypeID('opacity'), %s);
          __bw_opacityApplied = true;
        } catch (eOp) {}
  `,

		// BrushDynFl (br8) — flow mutation. Slot: flow value.
		vault.BrushDynFl: `
        try {
          __bw_toolDesc.putInteger(app.stringIDToTypeID('flow'), %s);
          __bw_flowApplied = true;
        } catch (eFlw) {}
  `,

		// BrushDynHd (br9) — hardness mutation inside the brush sub-descriptor. Slot: hardness value.
		vault.BrushDynHd: `
        try {
          if (__bw_toolDesc.hasKey(app.stringIDToTypeID('brush'))) {
            var __bw_brushDesc = __bw_toolDesc.getObjectValue(app.stringIDToTypeID('brush'));
            __bw_brushDesc.putUnitDouble(
              app.stringIDToTypeID('hardness'),
              app.charIDToTypeID('#Prc'),
              %s
            );
            __bw_toolDesc.putObject(
              app.stringIDToTypeID('brush'),
              app.stringIDToTypeID('brush'),
              __bw_brushDesc
            );
            __bw_hardnessApplied = true;
          }
        } catch (eHd) {}
  `,

		// BrushDynRst (br10) — restore saved tool options in finally. No slots.
		vault.BrushDynRst: `
      if (__bw_savedToolOptions !== null) {
        try {
          var __bw_restoreDesc = new ActionDescriptor();
          var __bw_restoreRef = new ActionReference();
          __bw_restoreRef.putProperty(
            app.charIDToTypeID('Prpr'),
            app.stringIDToTypeID('currentToolOptions')
          );
          __bw_restoreRef.putEnumerated(
            app.charIDToTypeID('capp'),
            app.charIDToTypeID('Ordn'),
            app.charIDToTypeID('Trgt')
          );
          __bw_restoreDesc.putReference(app.charIDToTypeID('null'), __bw_restoreRef);
          __bw_restoreDesc.putObject(
            app.charIDToTypeID('T   '),
            app.stringIDToTypeID('currentToolOptions'),
            __bw_savedToolOptions
          );
          executeAction(app.charIDToTypeID('setd'), __bw_restoreDesc, DialogModes.NO);
        } catch (eRestore) {}
      }
  `,

		// BrushPoint (br11) — one PathPointInfo construction. Slots (11): i×5, kind, ax, ay, lx, ly, rx, ry.
		// Inverted handle mapping: leftDirection = out-handle, rightDirection = in-handle (Adobe doc bug).
		vault.BrushPoint: `
      var __bw_p%s = new PathPointInfo();
      __bw_p%s.kind = PointKind.%s;
      __bw_p%s.anchor = [%s, %s];
      __bw_p%s.leftDirection = [%s, %s];
      __bw_p%s.rightDirection = [%s, %s];
  `,
	})
}
