package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// createPathFromSelection — DOM makeWorkPath. Slots: 1=getPathInfo,
		// 2=tolerance(call), 3=tolerance(result). NOTE: makeWorkPath clears the
		// active selection (it becomes the path).
		vault.PathCreate: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var __selRef = new ActionReference();
    __selRef.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('fsel'));
    __selRef.putEnumerated(app.charIDToTypeID('Dcmn'), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
    if (!app.executeActionGet(__selRef).hasKey(app.charIDToTypeID('fsel'))) {
      throw new Error('No active selection. Make a selection first — it becomes the work path.');
    }

    doc.selection.makeWorkPath(%s);

    return {
      created: true,
      tolerance: %s,
      selection_consumed: true,
      path_info: getPathInfo()
    };
  `,

		// savePath — AM make-named-path-from-work-path. Slots: 1=getPathInfo, 2=name.
		// Verified live 2026-06-24 (PS 27.2.0): the work path converts to a named saved
		// path (list afterwards shows it as kind 'normal').
		vault.PathSave: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var __hasWork = false;
    for (var __wi = 0; __wi < doc.pathItems.length; __wi++) {
      if (doc.pathItems[__wi].kind == PathKind.WORKPATH) { __hasWork = true; break; }
    }
    if (!__hasWork) {
      throw new Error('No work path to save. Create one with op=create_from_selection first.');
    }

    var __pname = %s;

    var __mkDesc = new ActionDescriptor();
    var __mkRef = new ActionReference();
    __mkRef.putClass(app.stringIDToTypeID('path'));
    __mkDesc.putReference(app.charIDToTypeID('null'), __mkRef);
    var __fromRef = new ActionReference();
    __fromRef.putProperty(app.stringIDToTypeID('path'), app.stringIDToTypeID('workPath'));
    __mkDesc.putReference(app.charIDToTypeID('From'), __fromRef);
    __mkDesc.putString(app.charIDToTypeID('Nm  '), __pname);
    app.executeAction(app.charIDToTypeID('Mk  '), __mkDesc, DialogModes.NO);

    return { saved: true, name: __pname, path_info: getPathInfo() };
  `,

		// listPaths — DOM pathItems iteration. Slot: 1=getPathInfo. Read-only.
		vault.PathList: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    return getPathInfo();
  `,

		// deletePath — DOM pathItem.remove. Slots: 1=getPathInfo, 2=name(jsLit|null).
		vault.PathDelete: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var __dname = %s;
    var __removed = null;
    if (__dname === null) {
      for (var __di = doc.pathItems.length - 1; __di >= 0; __di--) {
        if (doc.pathItems[__di].kind == PathKind.WORKPATH) {
          __removed = doc.pathItems[__di].name;
          doc.pathItems[__di].remove();
          break;
        }
      }
      if (__removed === null) {
        throw new Error('No work path to delete. Pass a name to delete a saved path.');
      }
    } else {
      for (var __dj = doc.pathItems.length - 1; __dj >= 0; __dj--) {
        if (doc.pathItems[__dj].name === __dname) {
          doc.pathItems[__dj].remove();
          __removed = __dname;
          break;
        }
      }
      if (__removed === null) {
        throw new Error('No path named "' + __dname + '".');
      }
    }

    return { deleted: true, name: __removed, path_info: getPathInfo() };
  `,

		// loadPathAsSelection — DOM PathItem.makeSelection. Slots: 1=getSelectionInfo,
		// 2=name(jsLit|null), 3=operation, 4=feather, 5=antiAlias.
		vault.PathLoadSel: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    if (doc.pathItems.length === 0) {
      throw new Error('No paths to load. Create one with op=create_from_selection or op=save first.');
    }

    var __lname = %s;
    var __lpath = null;
    if (__lname === null) {
      for (var __li = 0; __li < doc.pathItems.length; __li++) {
        if (doc.pathItems[__li].kind == PathKind.WORKPATH) { __lpath = doc.pathItems[__li]; break; }
      }
      if (__lpath === null) { __lpath = doc.pathItems[doc.pathItems.length - 1]; }
    } else {
      for (var __lj = 0; __lj < doc.pathItems.length; __lj++) {
        if (doc.pathItems[__lj].name === __lname) { __lpath = doc.pathItems[__lj]; break; }
      }
    }
    if (__lpath === null) {
      throw new Error('No path named "' + __lname + '".');
    }

    var __lop = %s;
    var __lselType;
    if (__lop === 'add') { __lselType = SelectionType.EXTEND; }
    else if (__lop === 'subtract') { __lselType = SelectionType.DIMINISH; }
    else if (__lop === 'intersect') { __lselType = SelectionType.INTERSECT; }
    else { __lselType = SelectionType.REPLACE; }

    __lpath.makeSelection(%s, %s, __lselType);

    return {
      loaded: true,
      path_name: __lpath.name,
      operation: __lop,
      selection_info: getSelectionInfo()
    };
  `,

		// strokePath — DOM PathItem.strokePath(ToolType); auto-duplicate-first.
		// Slots: 1=getMinimalContextInfo, 2=name(jsLit|null), 3=duplicateForOp,
		// 4=toolConst(call), 5=tool(result), 6=toolConst(result).
		vault.PathStroke: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    if (doc.pathItems.length === 0) {
      throw new Error('No paths to stroke. Create one with op=create_from_selection or op=save first.');
    }

    var __sname = %s;
    var __spath = null;
    if (__sname === null) {
      for (var __si = 0; __si < doc.pathItems.length; __si++) {
        if (doc.pathItems[__si].kind == PathKind.WORKPATH) { __spath = doc.pathItems[__si]; break; }
      }
      if (__spath === null) { __spath = doc.pathItems[doc.pathItems.length - 1]; }
    } else {
      for (var __sj = 0; __sj < doc.pathItems.length; __sj++) {
        if (doc.pathItems[__sj].name === __sname) { __spath = doc.pathItems[__sj]; break; }
      }
    }
    if (__spath === null) {
      throw new Error('No path named "' + __sname + '".');
    }

    %s

    var layer = doc.activeLayer;
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Can only stroke a path onto a normal (raster) layer. Layer kind: ' + layer.kind);
    }

    __spath.strokePath(ToolType.%s);

    return {
      stroked: true,
      path_name: __spath.name,
      tool: %s,
      tool_type: 'ToolType.%s',
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// fillPath — DOM PathItem.fillPath; auto-duplicate-first. Slots:
		// 1=getMinimalContextInfo, 2=name(jsLit|null), 3=duplicateForOp, 4=red,
		// 5=green, 6=blue, 7=mode, 8=opacity, 9=feather, 10=antiAlias.
		vault.PathFill: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    if (doc.pathItems.length === 0) {
      throw new Error('No paths to fill. Create one with op=create_from_selection or op=save first.');
    }

    var __fname = %s;
    var __fpath = null;
    if (__fname === null) {
      for (var __fi = 0; __fi < doc.pathItems.length; __fi++) {
        if (doc.pathItems[__fi].kind == PathKind.WORKPATH) { __fpath = doc.pathItems[__fi]; break; }
      }
      if (__fpath === null) { __fpath = doc.pathItems[doc.pathItems.length - 1]; }
    } else {
      for (var __fj = 0; __fj < doc.pathItems.length; __fj++) {
        if (doc.pathItems[__fj].name === __fname) { __fpath = doc.pathItems[__fj]; break; }
      }
    }
    if (__fpath === null) {
      throw new Error('No path named "' + __fname + '".');
    }

    %s

    var layer = doc.activeLayer;
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Can only fill a path on a normal (raster) layer. Layer kind: ' + layer.kind);
    }

    var __fpColor = new SolidColor();
    __fpColor.rgb.red = %s;
    __fpColor.rgb.green = %s;
    __fpColor.rgb.blue = %s;

    var __fpMode = %s;
    var __fpModeConst;
    switch (__fpMode) {
      case 'multiply': __fpModeConst = ColorBlendMode.MULTIPLY; break;
      case 'screen':   __fpModeConst = ColorBlendMode.SCREEN; break;
      case 'overlay':  __fpModeConst = ColorBlendMode.OVERLAY; break;
      case 'darken':   __fpModeConst = ColorBlendMode.DARKEN; break;
      case 'lighten':  __fpModeConst = ColorBlendMode.LIGHTEN; break;
      default:         __fpModeConst = ColorBlendMode.NORMAL;
    }

    __fpath.fillPath(__fpColor, __fpModeConst, %s, false, %s, true, %s);

    return {
      filled: true,
      path_name: __fpath.name,
      mode: __fpMode,
      target_was_copy: __opTargetIsCopy,
      target_layer_name: layer.name,
      original_layer_name: __opOriginalName,
      context: getMinimalContextInfo()
    };
  `,

		// setClippingPath — DOM PathItem.makeClippingPath. Slots: 1=getPathInfo,
		// 2=name, 3=flatness(number or empty → no-arg call). Requires a SAVED path.
		vault.PathClip: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var __cname = %s;
    var __cpath = null;
    for (var __ci = 0; __ci < doc.pathItems.length; __ci++) {
      if (doc.pathItems[__ci].name === __cname) { __cpath = doc.pathItems[__ci]; break; }
    }
    if (__cpath === null) {
      throw new Error('set_clipping needs a SAVED path name (use op=save first). No path named "' + __cname + '".');
    }

    __cpath.makeClippingPath(%s);

    return { clipping_path_set: true, name: __cname, path_info: getPathInfo() };
  `,

		// createPathFromPoints (pa9) — the grounded pen: build a NAMED editable vector
		// path directly from a resolved polyline curve (ps_path create_from_placement).
		// Reuses the live-verified PathPointInfo → SubPathInfo → doc.pathItems.add(name,
		// [sub]) idiom applyBrushStroke uses for its temp stroke path, but SAVED under a
		// name. Each point is a corner point (the resolved curve is a polyline; no bezier
		// handles). Slots: 1=getPathInfo, 2=pointConstructions (__bw_pN), 3=sub.closed,
		// 4=entireSubPath array, 5=name, 6=anchors(result), 7=closed(result).
		vault.PathFromPts: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    %s

    var __cp_sub = new SubPathInfo();
    __cp_sub.closed = %s;
    __cp_sub.operation = ShapeOperation.SHAPEADD;
    __cp_sub.entireSubPath = [%s];

    var __cp_name = %s;
    var __cp_path = doc.pathItems.add(__cp_name, [__cp_sub]);

    return {
      created: true,
      path_name: __cp_name,
      name: __cp_name,
      anchors: %s,
      closed: %s,
      path_info: getPathInfo()
    };
  `,
	})
}
