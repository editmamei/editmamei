package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// deleteGroup. Slots: 1=getContextInfo, 2=normNameHelper,
		// 3=notFoundMessageHelper, 4=name(jsLit), 5=name(jsLit).
		vault.DeleteGroup: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // Em-dash / en-dash tolerant comparison (Bug I) via normName — same
    // policy as deleteLayer / selectLayer / moveLayerToGroup.
    %s
    %s
    var targetNorm = normName(%s);
    function findGroupByName(layers, depth) {
      if (depth === undefined) depth = 0;
      if (depth > 32) return null;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        var isGroup = false;
        try { isGroup = (l instanceof LayerSet); } catch (e) {}
        if (isGroup) {
          if (normName(l.name) === targetNorm) return l;
          try {
            var found = findGroupByName(l.layers, depth + 1);
            if (found) return found;
          } catch (e) {}
        }
      }
      return null;
    }

    function countDescendants(group, depth) {
      if (depth === undefined) depth = 0;
      if (depth > 32) return 0;
      var n = 0;
      for (var i = 0; i < group.layers.length; i++) {
        n++;
        var child = group.layers[i];
        var isGroup = false;
        try { isGroup = (child instanceof LayerSet); } catch (e) {}
        if (isGroup) n += countDescendants(child, depth + 1);
      }
      return n;
    }

    var target = findGroupByName(doc.layers);
    if (!target) {
      throw new Error(__notFoundMessage('Group', %s, true));
    }
    var deletedName = target.name;
    var descendantCount = countDescendants(target);
    target.remove();

    return {
      deleted: true,
      groupName: deletedName,
      descendants_deleted: descendantCount,
      context: getContextInfo()
    };
  `,

		// createClippingMask. Slots: 1=helperFunctions, 2=getContextInfo.
		// The .grouped guard makes create idempotent, symmetric with release
		// below: dispatching groupEvent on an already-clipped layer does NOT
		// toggle — it throws `The command "Create Clipping Mask" is not
		// currently available` (PS disables the menu item; live-verified
		// PS 27.2.0). already_clipped distinguishes the no-op from a fresh
		// clip so callers can tell the states apart.
		vault.ClipMask: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var clippedName = doc.activeLayer.name;
    var alreadyClipped = false;
    try { alreadyClipped = doc.activeLayer.grouped === true; } catch (e) {}
    if (alreadyClipped) {
      return {
        clipped: true,
        already_clipped: true,
        layerName: clippedName,
        context: getContextInfo()
      };
    }
    var clipDesc = new ActionDescriptor();
    var clipRef = new ActionReference();
    clipRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    clipDesc.putReference(cTID('null'), clipRef);
    executeAction(sTID('groupEvent'), clipDesc, DialogModes.NO);

    return {
      clipped: true,
      layerName: clippedName,
      context: getContextInfo()
    };
  `,

		// releaseClippingMask. Slots: 1=helperFunctions, 2=getContextInfo.
		// The event is the 'Ungr' charID (stringID "ungroup"). There is no
		// 'ungroupEvent' stringID — the GrpL↔groupEvent alias pattern does not
		// extrapolate, and dispatching it fails with `The command "<unknown>"
		// is not currently available`. The .grouped guard keeps the documented
		// idempotent no-op: raw 'Ungr' on a non-clipped layer throws -25920
		// instead of no-oping. LayerSets read .grouped as null (PS cannot clip
		// a group), so they take the no-op path.
		vault.ReleaseClip: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var releasedName = doc.activeLayer.name;
    var wasClipped = false;
    try { wasClipped = doc.activeLayer.grouped === true; } catch (e) {}
    if (!wasClipped) {
      return {
        released: false,
        layerName: releasedName,
        context: getContextInfo()
      };
    }
    var releaseDesc = new ActionDescriptor();
    var releaseRef = new ActionReference();
    releaseRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    releaseDesc.putReference(cTID('null'), releaseRef);
    executeAction(cTID('Ungr'), releaseDesc, DialogModes.NO);

    return {
      released: true,
      layerName: releasedName,
      context: getContextInfo()
    };
  `,

		// createGroup. Slots: 1=parentPathHelper, 2=hoistFromActiveGroupHelper,
		// 3=getContextInfo, 4=normNameHelper, 5=name(jsLit), 6=into_active_group
		// (jsBool), 7=layerNames move-block (built by the emitter; empty when
		// none). Phase 4 (layer-placement bug): the Mk descriptor below carries
		// no target reference, so with a group active PS nests the new group
		// INSIDE it (native "relative to current target" rule) — contradicting
		// this tool's documented "above the active layer" placement.
		// __hoistFromActiveGroupIfNeeded moves it back out to a sibling of that
		// group by default; into_active_group:true keeps PS's native nesting.
		vault.CreateGroup: `
    %s
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // Bug I em-dash tolerance — the same normName policy used by
    // moveLayerToGroup / selectLayer / deleteLayer. The LLM frequently
    // hands back layer names from a prior render with hyphen-minus where
    // PS stored an em-dash (U+2014) or en-dash, and strict === silently
    // turns the move into a notFound entry the caller can't distinguish
    // from a real missing layer. See tests/tools/group-tools.test.ts.
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

    var __preMkActive = doc.activeLayer;

    // Mk LyrS — create a new group. PS has no target reference to attach
    // here, so it nests the new group inside the active layer's group when
    // one is active. __hoistFromActiveGroupIfNeeded below moves the new
    // group back out to sit ABOVE (a sibling of) that active group by
    // default, matching this tool's documented placement.
    var mkDesc = new ActionDescriptor();
    var mkRef = new ActionReference();
    mkRef.putClass(stringIDToTypeID('layerSection'));
    mkDesc.putReference(charIDToTypeID('null'), mkRef);
    var nameDesc = new ActionDescriptor();
    nameDesc.putString(charIDToTypeID('Nm  '), %s);
    mkDesc.putObject(charIDToTypeID('Usng'), stringIDToTypeID('layerSection'), nameDesc);
    executeAction(charIDToTypeID('Mk  '), mkDesc, DialogModes.NO);

    var newGroup = doc.activeLayer;
    var __intoActiveGroup = %s;
    var __hoisted = __hoistFromActiveGroupIfNeeded(doc, __preMkActive, newGroup, __intoActiveGroup);
    var movedCount = 0;
    var notFound = [];

    %s

    return {
      created: true,
      groupName: newGroup.name,
      moved_count: movedCount,
      not_found: notFound,
      hoisted: __hoisted,
      parent_path: __parentPathOf(doc, newGroup),
      context: getContextInfo()
    };
  `,

		// moveLayerToGroup. Slots: 1=getContextInfo, 2=normNameHelper,
		// 3=notFoundMessageHelper, 4=layerName(jsLit), 5=groupName(jsLit),
		// 6=layerName(jsLit), 7=groupName(jsLit).
		vault.MoveToGroup: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // normName (Bug I em-dash tolerance) — shared via normNameHelper so
    // selectLayer / deleteLayer / moveLayerToGroup all use the same policy.
    // Do NOT write the dollar-curly interpolation syntax inside any //
    // comment in this snippet body: the template literal evaluates it
    // regardless of comment context, the helper's leading newline
    // terminates the comment mid-line, and the trailing comment text
    // then parses as code. The "snippet bodies parse as valid JS" guard
    // in tests/unit/extendscript.test.ts is the regression pin.
    %s
    %s
    var wantedLayerNorm = normName(%s);
    var wantedGroupNorm = normName(%s);

    function findLayerByName(layers, depth) {
      if (depth === undefined) depth = 0;
      if (depth > 32) return null;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (normName(l.name) === wantedLayerNorm) return l;
        var isGroup = false;
        try { isGroup = (l instanceof LayerSet); } catch (e) {}
        if (isGroup) {
          try {
            var found = findLayerByName(l.layers, depth + 1);
            if (found) return found;
          } catch (e) {}
        }
      }
      return null;
    }

    function findGroupByName(layers, depth) {
      if (depth === undefined) depth = 0;
      if (depth > 32) return null;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        var isGroup = false;
        try { isGroup = (l instanceof LayerSet); } catch (e) {}
        if (isGroup) {
          if (normName(l.name) === wantedGroupNorm) return l;
          try {
            var found = findGroupByName(l.layers, depth + 1);
            if (found) return found;
          } catch (e) {}
        }
      }
      return null;
    }

    var layer = findLayerByName(doc.layers);
    if (!layer) throw new Error(__notFoundMessage('Layer', %s, false));
    var group = findGroupByName(doc.layers);
    if (!group) throw new Error(__notFoundMessage('Group', %s, true));
    if (layer === group) throw new Error('Cannot move a group into itself');

    layer.move(group, ElementPlacement.INSIDE);

    return {
      moved: true,
      layerName: layer.name,
      groupName: group.name,
      context: getContextInfo()
    };
  `,

		// setGroupBlendMode. Slots: 1=getContextInfo, 2=normNameHelper,
		// 3=notFoundMessageHelper, 4=groupName(jsLit), 5=groupName(jsLit),
		// 6=blendMode(jsLit).
		vault.SetGroupMode: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // Em-dash / en-dash tolerant comparison (Bug I) via normName.
    %s
    %s
    var targetNorm = normName(%s);
    function findGroupByName(layers, depth) {
      if (depth === undefined) depth = 0;
      if (depth > 32) return null;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        var isGroup = false;
        try { isGroup = (l instanceof LayerSet); } catch (e) {}
        if (isGroup) {
          if (normName(l.name) === targetNorm) return l;
          try {
            var found = findGroupByName(l.layers, depth + 1);
            if (found) return found;
          } catch (e) {}
        }
      }
      return null;
    }

    var group = findGroupByName(doc.layers);
    if (!group) throw new Error(__notFoundMessage('Group', %s, true));

    var modeStr = %s;
    var modeEnum = null;
    try { modeEnum = BlendMode[modeStr]; } catch (e) {}
    if (!modeEnum) {
      throw new Error('Unknown blend mode: ' + modeStr);
    }
    group.blendMode = modeEnum;

    return {
      set: true,
      groupName: group.name,
      blendMode: String(group.blendMode),
      context: getContextInfo()
    };
  `,

		// ungroup. Slots: 1=getContextInfo, 2=normNameHelper,
		// 3=notFoundMessageHelper, 4=groupName(jsLit), 5=groupName(jsLit).
		// The result's groupName now reads back the
		// RESOLVED group.name (captured before the dissolve, same pattern as
		// childNames below — the LayerSet object goes invalid after
		// ungroupLayersEvent) rather than echoing the REQUESTED name back —
		// lookups are dash/whitespace/case-tolerant via normName, so the two
		// can differ and echoing the request fed the LLM a wrong mental model
		// of which group actually got dissolved (QA finding). Sibling
		// setGroupBlendMode already returns group.name the same way.
		vault.Ungroup: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // Em-dash / en-dash tolerant comparison (Bug I) via normName.
    %s
    %s
    var targetNorm = normName(%s);
    function findGroupByName(layers, depth) {
      if (depth === undefined) depth = 0;
      if (depth > 32) return null;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        var isGroup = false;
        try { isGroup = (l instanceof LayerSet); } catch (e) {}
        if (isGroup) {
          if (normName(l.name) === targetNorm) return l;
          try {
            var found = findGroupByName(l.layers, depth + 1);
            if (found) return found;
          } catch (e) {}
        }
      }
      return null;
    }

    var group = findGroupByName(doc.layers);
    if (!group) throw new Error(__notFoundMessage('Group', %s, true));

    // Capture the RESOLVED name and the children's names BEFORE dissolving
    // (the LayerSet object becomes invalid afterwards).
    var resolvedGroupName = group.name;
    var childNames = [];
    for (var i = 0; i < group.layers.length; i++) {
      childNames.push(group.layers[i].name);
    }

    doc.activeLayer = group;
    var ungroupDesc = new ActionDescriptor();
    var ungroupRef = new ActionReference();
    ungroupRef.putEnumerated(
      charIDToTypeID('Lyr '),
      charIDToTypeID('Ordn'),
      charIDToTypeID('Trgt')
    );
    ungroupDesc.putReference(charIDToTypeID('null'), ungroupRef);
    executeAction(stringIDToTypeID('ungroupLayersEvent'), ungroupDesc, DialogModes.NO);

    return {
      ungrouped: true,
      groupName: resolvedGroupName,
      children_promoted: childNames.length,
      child_names: childNames,
      context: getContextInfo()
    };
  `,
	})
}
