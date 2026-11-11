package main

import "editmamei-core/internal/vault"

// relight: Photoshop 28's Relight layer (AM 'lightshop'). Rendered in Adobe's
// cloud and charged to the user's Adobe Firefly generative credits; the TS tool
// asks the person before a render ever runs.
//
// Descriptor axes (verified against the panel's sliders, 2026-11-11):
// X = left/right, Y = close/far (depth, NOT height), z = low/high. 'ambient' is
// the panel's single Original lighting value, so every light carries the same
// one. 'seed' and 'steps' are omitted (the replay worked without them).
//
// Targets (ScriptListener, 2026-11-11): null = the DOCUMENT makes a new Relight
// layer above the active layer and hides the source; null = the LAYER, with an
// existing Relight layer selected, re-renders that layer in place ("Edit Relight
// Layer") and costs the same credits. A Relight layer is a smart object whose
// smartObjectMore carries LightshopVersion.
//
// Modes:
//
//	probe            read the target (is it a Relight layer, will it be edited)
//	                 without rendering; runs before the approval prompt.
//	render           DialogModes.NO: the paid render.
//	preview_prepare  fit the photo on screen and hide visible layers above the
//	                 target so the panel's preview can be seen.
//	preview_open     DialogModes.ALL: opens the Relight panel preloaded with the
//	                 lights and blocks until it closes. Closing it does NOT throw,
//	                 so layer count and history tell whether Done rendered.
//	preview_restore  show the layers preview_prepare hid.
//
// Slot order (10): getContextInfo, normNameHelper, notFoundMessageHelper,
// layerName, lights, ambient, mode, newLayer, hiddenIds, layerName (for the
// not-found message). lights is a JS array of [x, y, z, r, g, b, intensity,
// radius] rows.
func init() {
	fragments[vault.Relight] = `
    %s
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var psMajor = parseInt(String(app.version).split('.')[0], 10);
    if (!(psMajor >= 28)) {
      throw new Error(
        'Relight needs Photoshop 2027 (version 28) or later, and this Photoshop is ' + app.version +
        '. Update Photoshop in the Creative Cloud app.'
      );
    }
    var doc = app.activeDocument;
    var wanted = %s;
    var lights = %s;
    var ambient = %s;
    var mode = %s;
    var newLayer = %s;
    var hiddenIds = %s;

    function __collectIds(layers, into) {
      for (var i = 0; i < layers.length; i++) {
        into[layers[i].id] = true;
        if (layers[i].typename === 'LayerSet') __collectIds(layers[i].layers, into);
      }
      return into;
    }
    function __countIds(map) {
      var n = 0;
      for (var k in map) if (map.hasOwnProperty(k)) n++;
      return n;
    }
    function __layerCount() {
      return __countIds(__collectIds(doc.layers, {}));
    }
    function __setShown(ids, show) {
      var done = [];
      for (var i = 0; i < ids.length; i++) {
        try {
          var lst = new ActionList();
          var r = new ActionReference();
          r.putIdentifier(charIDToTypeID('Lyr '), ids[i]);
          lst.putReference(r);
          var d = new ActionDescriptor();
          d.putList(charIDToTypeID('null'), lst);
          executeAction(charIDToTypeID(show ? 'Shw ' : 'Hd  '), d, DialogModes.NO);
          done.push(ids[i]);
        } catch (eShow) {}
      }
      return done;
    }

    if (mode === 'preview_restore') {
      var shown = __setShown(hiddenIds, true);
      return {
        restored: shown.length,
        layer_count: __layerCount(),
        context: getContextInfo()
      };
    }

    function __findArtLayer(layers, depth) {
      if (depth > 32) return null;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (l.typename === 'LayerSet') {
          var nested = __findArtLayer(l.layers, depth + 1);
          if (nested) return nested;
        } else if (normName(l.name) === normName(wanted)) {
          return l;
        }
      }
      return null;
    }
    var target;
    if (wanted !== '') {
      target = __findArtLayer(doc.layers, 0);
      if (!target) throw new Error(__notFoundMessage('Layer', %s, false));
      doc.activeLayer = target;
    } else {
      target = doc.activeLayer;
    }
    if (target.typename === 'LayerSet') {
      throw new Error(
        'Relight works on a single layer, not a group (' + target.name + '). ' +
        'Pass layer with the name of a pixel or smart object layer.'
      );
    }
    var sourceName = target.name;
    var sourceId = target.id;

    function __isRelightLayer(id) {
      try {
        var r = new ActionReference();
        r.putIdentifier(charIDToTypeID('Lyr '), id);
        var d = executeActionGet(r);
        var k = stringIDToTypeID('smartObjectMore');
        if (!d.hasKey(k)) return false;
        return d.getObjectValue(k).hasKey(stringIDToTypeID('LightshopVersion'));
      } catch (eKind) {
        return false;
      }
    }
    var isRelight = __isRelightLayer(sourceId);
    var edit = isRelight && !newLayer;

    // Visible layers that draw over the target, top to bottom. Layers inside a
    // hidden group don't draw, so they're left alone.
    function __visibleAbove(layers, acc, state, groupVisible) {
      for (var i = 0; i < layers.length && !state.done; i++) {
        var l = layers[i];
        if (l.id === sourceId) { state.done = true; return acc; }
        if (l.typename === 'LayerSet') {
          __visibleAbove(l.layers, acc, state, groupVisible && l.visible);
        } else if (groupVisible && l.visible) {
          acc.push(l.id);
        }
      }
      return acc;
    }

    if (mode === 'probe') {
      return {
        probe: true,
        target_layer: sourceName,
        is_relight_layer: isRelight,
        edit: edit,
        layer_count: __layerCount(),
        context: getContextInfo()
      };
    }

    if (mode === 'preview_prepare') {
      try { runMenuItem(charIDToTypeID('FtOn')); } catch (eFit) {}
      var hid = __setShown(__visibleAbove(doc.layers, [], { done: false }, true), false);
      return {
        prepared: true,
        target_layer: sourceName,
        is_relight_layer: isRelight,
        edit: edit,
        hidden_ids: hid,
        layer_count: __layerCount(),
        context: getContextInfo()
      };
    }

    function __findNew(layers, known) {
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (!known[l.id]) return l;
        if (l.typename === 'LayerSet') {
          var nested = __findNew(l.layers, known);
          if (nested) return nested;
        }
      }
      return null;
    }
    function __findById(layers, id) {
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (l.id === id) return l;
        if (l.typename === 'LayerSet') {
          var nested = __findById(l.layers, id);
          if (nested) return nested;
        }
      }
      return null;
    }
    var before = __collectIds(doc.layers, {});
    var countBefore = __countIds(before);
    var histBefore = doc.historyStates.length;
    var histNameBefore = doc.activeHistoryState.name;
    function __historyChanged() {
      return doc.historyStates.length !== histBefore || doc.activeHistoryState.name !== histNameBefore;
    }

    var desc = new ActionDescriptor();
    var list = new ActionList();
    for (var li = 0; li < lights.length; li++) {
      var row = lights[li];
      var ld = new ActionDescriptor();
      ld.putDouble(charIDToTypeID('X   '), row[0]);
      ld.putDouble(charIDToTypeID('Y   '), row[1]);
      ld.putDouble(stringIDToTypeID('z'), row[2]);
      ld.putDouble(charIDToTypeID('Rd  '), row[3]);
      ld.putDouble(charIDToTypeID('Grn '), row[4]);
      ld.putDouble(charIDToTypeID('Bl  '), row[5]);
      ld.putDouble(charIDToTypeID('Intn'), row[6]);
      ld.putDouble(charIDToTypeID('Rds '), row[7]);
      ld.putDouble(stringIDToTypeID('ambient'), ambient);
      ld.putDouble(stringIDToTypeID('transition'), 1.0);
      ld.putBoolean(charIDToTypeID('Vsbl'), true);
      list.putObject(stringIDToTypeID('lightshop_light'), ld);
    }
    desc.putList(stringIDToTypeID('lights_list'), list);
    var targetRef = new ActionReference();
    if (edit) {
      targetRef.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    } else {
      targetRef.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    }
    desc.putReference(charIDToTypeID('null'), targetRef);

    if (mode === 'preview_open') {
      var openError = '';
      try {
        executeAction(stringIDToTypeID('lightshop'), desc, DialogModes.ALL);
      } catch (ePanel) {
        openError = String(ePanel.message || ePanel);
      }
      var countAfter = __layerCount();
      var histChanged = __historyChanged();
      var made0 = countAfter > countBefore ? __findNew(doc.layers, before) : null;
      return {
        panel_closed: true,
        rendered: countAfter > countBefore || histChanged,
        edit: edit,
        layers_before: countBefore,
        layers_after: countAfter,
        layer_name: made0 ? made0.name : (histChanged && edit ? sourceName : ''),
        open_error: openError,
        context: getContextInfo()
      };
    }

    try {
      executeAction(stringIDToTypeID('lightshop'), desc, DialogModes.NO);
    } catch (eAm) {
      throw new Error(
        'Relight did not render: ' + String(eAm.message || eAm) + '\n' +
        'Relight runs in Adobe\'s cloud: Photoshop must be online and signed in to an Adobe ' +
        'account with Adobe Firefly generative credits left. Check Photoshop for a sign-in or ' +
        'credits message before trying again.'
      );
    }

    if (edit) {
      var editedLayer = __findById(doc.layers, sourceId);
      return {
        relit: true,
        edited: true,
        strategy_used: 'executeAction:lightshop:edit',
        layer_name: editedLayer ? editedLayer.name : sourceName,
        source_layer: sourceName,
        history_changed: __historyChanged(),
        light_count: lights.length,
        original_lighting: ambient,
        context: getContextInfo()
      };
    }

    var made = __findNew(doc.layers, before);
    if (!made) {
      throw new Error(
        'Relight reported success but no new layer appeared. Check the layer stack ' +
        '(ps_inspect what=layer_tree) before retrying: each retry is another render.'
      );
    }
    var source = __findById(doc.layers, sourceId);

    return {
      relit: true,
      edited: false,
      strategy_used: 'executeAction:lightshop',
      layer_name: made.name,
      source_layer: sourceName,
      source_hidden: source ? !source.visible : false,
      source_found: !!source,
      light_count: lights.length,
      original_lighting: ambient,
      context: getContextInfo()
    };
  `
}
