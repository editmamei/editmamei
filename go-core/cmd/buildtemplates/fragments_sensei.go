package main

import "editmamei-core/internal/vault"

// Sensei selection fragments (selectSubject / selectSky), community tier.
// Moved VERBATIM from
// fragments_pro.go so the community generator's templates.enc carries them and
// the CE binary emits them. No build tag — compiled into every edition; added
// via init() (mirrors fragments_pro.go's merge) after the fragments map var
// initializes. Slot order per body: selectionTypeHelpers, getSelectionInfo,
// selType, sampleAll.
func init() {
	fragments[vault.SelSubject] = `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var selType = %s;
    var sampleAll = %s;

    // Save existing selection (if any) so we can combine after detection.
    var savedCh = (selType === 'replace') ? null : saveSelectionToTempChannel(doc);

    // PS 2026 "active layer only" workaround: temporarily target the
    // bottom layer (typically the source photo) so AI detection sees
    // photographic pixels even when the active layer is processed.
    var origActive = doc.activeLayer;
    var changedActive = false;
    if (sampleAll && doc.layers.length > 1) {
      try {
        doc.activeLayer = doc.layers[doc.layers.length - 1];
        changedActive = true;
      } catch (eAct) {}
    }

    try {
      try {
        var subjDesc = new ActionDescriptor();
        subjDesc.putBoolean(stringIDToTypeID('sampleAllLayers'), sampleAll);
        executeAction(stringIDToTypeID('autoCutout'), subjDesc, DialogModes.NO);
      } catch (eAm) {
        if (savedCh) { try { savedCh.remove(); } catch (e) {} }
        // Early-exit contract — see selectionTypeHelpers docstring for why.
        restoreCompositeChannel(doc);
        var msg = String(eAm.message || eAm);
        // Recognize the ambiguous PS error pattern. The same string is
        // raised whether the AI model is unavailable OR ran fine but
        // found no subject — never claim one is the cause.
        if (msg.indexOf('not currently valid') !== -1 ||
            msg.indexOf('not currently available') !== -1 ||
            msg.indexOf('may not be available') !== -1) {
          throw new Error(
            'Select Subject returned no result. PS does not distinguish between (a) the AI model being unavailable and (b) the model running but finding no subject in this image, so either may be the cause:\n' +
            '  - If you have NOT successfully run Select Subject (menu or this tool) on any image in this Photoshop install recently, this is likely (a): open Photoshop > Preferences > Image Processing > Select Subject and Remove Background, switch from "Device" to "Cloud (Detailed Results)" (Adobe ID + internet, no hardware requirement), then retry. Alternative: run Select > Subject once from the menu to kick off the on-device model download.\n' +
            '  - If Select Subject worked on a different image recently, this is likely (b): the AI ran and found no clear subject (low-contrast composition, abstract scene, blank background). Try ps_select (mode=magic_wand) on a representative subject region, or accept that this image has no detectable subject.\n' +
            'Underlying PS error: ' + msg
          );
        }
        throw new Error('Select Subject failed: ' + msg);
      }
    } finally {
      if (changedActive) {
        try { doc.activeLayer = origActive; } catch (eRestore) {}
      }
    }

    // Detection can succeed silently with no selection — verify.
    var probeRef = new ActionReference();
    probeRef.putProperty(charIDToTypeID('Prpr'), charIDToTypeID('fsel'));
    probeRef.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    if (!executeActionGet(probeRef).hasKey(charIDToTypeID('fsel'))) {
      if (savedCh) { try { savedCh.remove(); } catch (e) {} }
      // Early-exit contract — see selectionTypeHelpers docstring.
      restoreCompositeChannel(doc);
      throw new Error(
        'Select Subject completed but found no subject in the image. ' +
        (sampleAll
          ? 'Already analyzed the full composite. The image may have no detectable subject; try ps_select (mode=magic_wand) on a representative subject region.'
          : 'Try again with sample_all_layers=true so the model considers the full composite, not just the active layer.')
      );
    }

    combineWithSavedSelection(doc, savedCh, selType);

    return {
      selected: true,
      method: 'subject',
      strategy_used: 'executeAction:autoCutout',
      sample_all_layers: sampleAll,
      active_layer_temporarily_changed: changedActive,
      selection_type: selType,
      selection_info: getSelectionInfo()
    };
  `
	fragments[vault.SelSky] = `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var selType = %s;
    var sampleAll = %s;

    var savedCh = (selType === 'replace') ? null : saveSelectionToTempChannel(doc);

    var origActive = doc.activeLayer;
    var changedActive = false;
    if (sampleAll && doc.layers.length > 1) {
      try {
        doc.activeLayer = doc.layers[doc.layers.length - 1];
        changedActive = true;
      } catch (eAct) {}
    }

    try {
      try {
        var skyDesc = new ActionDescriptor();
        skyDesc.putBoolean(stringIDToTypeID('sampleAllLayers'), sampleAll);
        executeAction(stringIDToTypeID('selectSky'), skyDesc, DialogModes.NO);
      } catch (eAm) {
        if (savedCh) { try { savedCh.remove(); } catch (e) {} }
        // Early-exit contract — see selectionTypeHelpers docstring.
        restoreCompositeChannel(doc);
        var msg = String(eAm.message || eAm);
        // PS raises the same ambiguous error string for both "model
        // unavailable" and "model ran but found no sky" — never claim
        // one is the cause.
        if (msg.indexOf('not currently valid') !== -1 ||
            msg.indexOf('not currently available') !== -1 ||
            msg.indexOf('may not be available') !== -1) {
          throw new Error(
            'Select Sky returned no result. PS does not distinguish between (a) the AI model being unavailable and (b) the model running but finding no sky region in this image, so either may be the cause:\n' +
            '  - If you have NOT successfully run Select Sky (menu or this tool) recently, this is likely (a): open Photoshop > Preferences > Image Processing > Select Subject and Remove Background, switch from "Device" to "Cloud (Detailed Results)", then retry. Alternative: run Select > Sky once from the menu to kick off the on-device model download.\n' +
            '  - If Select Sky worked on a different image recently, this is likely (b): the AI ran and found no sky region (indoor / closed composition, dense foreground, low contrast). Try ps_select (mode=magic_wand) on a representative sky pixel instead.\n' +
            'Underlying PS error: ' + msg
          );
        }
        throw new Error('Select Sky failed: ' + msg);
      }
    } finally {
      if (changedActive) {
        try { doc.activeLayer = origActive; } catch (eRestore) {}
      }
    }

    var probeRef = new ActionReference();
    probeRef.putProperty(charIDToTypeID('Prpr'), charIDToTypeID('fsel'));
    probeRef.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    if (!executeActionGet(probeRef).hasKey(charIDToTypeID('fsel'))) {
      if (savedCh) { try { savedCh.remove(); } catch (e) {} }
      // Early-exit contract — see selectionTypeHelpers docstring.
      restoreCompositeChannel(doc);
      throw new Error(
        'Select Sky completed but found no sky region in the image. ' +
        (sampleAll
          ? 'Already analyzed the full composite — no detectable sky pixels (indoor / closed composition?).'
          : 'Try again with sample_all_layers=true so the model considers the full composite.')
      );
    }

    combineWithSavedSelection(doc, savedCh, selType);

    return {
      selected: true,
      method: 'sky',
      strategy_used: 'executeAction:selectSky',
      sample_all_layers: sampleAll,
      active_layer_temporarily_changed: changedActive,
      selection_type: selType,
      selection_info: getSelectionInfo()
    };
  `

	// focusMask — depth-of-field selection. Selects what is IN FOCUS, so it is
	// orthogonal to the semantic selectors above: it answers "what did the lens
	// resolve sharply", not "what object is this". Takes no coordinates.
	// Slot order: selectionTypeHelpers, getSelectionInfo, selType,
	// inFocusRadius, softMask.
	fragments[vault.SelFocus] = `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var selType = %s;
    var inFocusRadius = %s;
    var softMask = %s;

    // Stashed UNCONDITIONALLY, including for selection_type='replace'. Replace
    // means the prior selection is expendable on SUCCESS; it does not mean the
    // caller should be left with nothing when Focus Area FAILS. Because this
    // fragment deselects below, a failed replace-mode call without a stash would
    // destroy a selection it never got to replace. combineWithSavedSelection
    // discards the channel unchanged in replace mode, so the success path is
    // unaffected — the cost is one alpha round-trip.
    var savedCh = saveSelectionToTempChannel(doc);

    // Clear any existing selection BEFORE calling focusMask. Confirmed live
    // 2026-08-16: on a layer with nothing to measure, focusMask succeeds and
    // produces NO selection at all — it does not clear what was already there.
    // Without this deselect the post-condition probe finds the caller's OLD
    // selection and reports it as the result, which is a confident wrong answer
    // rather than the honest "selected nothing" error. saveSelectionToTempChannel
    // has stashed it for the add/subtract/intersect paths, so every failure exit
    // below must RESTORE from that stash before discarding it — deselecting
    // makes this fragment responsible for putting the caller's selection back,
    // which the siblings are not. (The same probe hazard exists in
    // selectSubject/selectSky, which stash but do not deselect — deliberately
    // NOT changed here: they are shipped community tools and warrant their own
    // live verification.)
    // Gated on savedCh: Photoshop 2024+ raises an UNCATCHABLE error 1302 from
    // empty-selection selection access, and the catch below cannot stop it.
    // savedCh is exactly the "a selection existed" predicate
    // (saveSelectionToTempChannel returns null when there was none), so there
    // is nothing to deselect when it's null either way.
    if (savedCh) {
      try { doc.selection.deselect(); } catch (eDesel) {}
    }

    // Put the caller's selection back on a failure path, then drop the stash.
    // Without the load, a thrown Focus Area leaves the document with NO
    // selection at all — worse than the state it was called in.
    function __restoreAndDiscard(ch) {
      if (!ch) { return; }
      try { doc.selection.load(ch, SelectionType.REPLACE); } catch (eLoad) {}
      try { ch.remove(); } catch (eRm) {}
    }

    // focusMask analyses the ACTIVE LAYER and does NOT fail when that layer has
    // nothing to measure. What it does instead is not fully pinned, and the two
    // live observations must be read in order:
    //   2026-08-15, before this fragment deselected: a Curves adjustment layer
    //     and an empty raster layer each REPORTED 100%% of canvas where the
    //     Background reported the correct 51.4%%.
    //   2026-08-16, raw event, no prior selection: focusMask on a layer with
    //     nothing to measure produced NO selection at all.
    // Those disagree because the first set was measured with a prior selection
    // active, which focusMask leaves untouched — so "100%% of canvas" was very
    // likely a stale selection being misread, i.e. the exact bug the deselect
    // below fixes, not a measurement of this event. Treat the 08-15 numbers as
    // contaminated and do not cite them as behaviour.
    // What DOES justify the retarget is the post-fix run, 2026-08-16, taken
    // after the deselect below existed and so free of that contamination: with
    // a Curves adjustment layer active, this fragment returned the same 51.4%%
    // selection as the Background layer, reporting
    // active_layer_temporarily_changed = true. Without the retarget the same
    // call does not produce that. That is the measurement to trust here.
    // So: retarget the bottom layer, typically the source photo, whenever the
    // active layer is not an ordinary raster layer. Same shape as
    // selectSubject's PS-2026 workaround, but triggered by layer KIND rather
    // than a sampleAllLayers flag, because focusMask's descriptor has no such
    // field.
    // NOTE this retargets for ANY non-NORMAL kind, which is broader than
    // strictly necessary — a Smart Object does carry measurable pixels. The
    // wide net is deliberate until each kind is verified live; the tradeoff is
    // reported honestly via active_layer_temporarily_changed so a caller can
    // see the analysed layer was not the one it selected.
    // It is also NARROWER than it looks: an EMPTY raster layer is LayerKind
    // NORMAL and so is NOT rescued here. That case falls to the post-condition
    // instead, which surfaces it as either the "selected nothing" error or
    // whole_canvas_selected — do not claim which, for the same reason the AM
    // error branch refuses to.
    // The kind read is guarded: a LayerSet exposes no kind property, and a
    // throw here would escape every try below — after the deselect and after
    // the temp channel was created — leaving no selection and an orphan channel.
    var origActive = doc.activeLayer;
    var changedActive = false;
    var activeKind = null;
    try { activeKind = String(origActive.kind); } catch (eKind) {}
    if (doc.layers.length > 1 && activeKind !== null &&
        activeKind !== String(LayerKind.NORMAL)) {
      try {
        doc.activeLayer = doc.layers[doc.layers.length - 1];
        changedActive = true;
      } catch (eAct) {}
    }

    try {
      var fmDesc = new ActionDescriptor();
      fmDesc.putDouble(stringIDToTypeID('focusMaskInFocusRadius'), inFocusRadius);
      // Auto noise estimation + auto segmentation sigma mirror the Focus Area
      // dialog's "Auto" checkboxes; lambda/powerLaw are the captured defaults.
      fmDesc.putBoolean(stringIDToTypeID('focusMaskUseAutoImageNoiseLevel'), true);
      fmDesc.putDouble(stringIDToTypeID('focusMaskBinarySegLambda'), 500.0);
      fmDesc.putBoolean(stringIDToTypeID('focusMaskUseSoftMask'), softMask);
      fmDesc.putBoolean(stringIDToTypeID('focusMaskUseAutoBinarySegSigma'), true);
      fmDesc.putDouble(stringIDToTypeID('focusMaskPowerLaw'), 1.0);
      fmDesc.putEnumerated(
        stringIDToTypeID('focusMaskOutput'),
        stringIDToTypeID('focusMaskOutput'),
        stringIDToTypeID('selectionOutputToSelection')
      );
      executeAction(stringIDToTypeID('focusMask'), fmDesc, DialogModes.NO);
    } catch (eAm) {
      if (changedActive) { try { doc.activeLayer = origActive; } catch (eR) {} }
      __restoreAndDiscard(savedCh);
      // Early-exit contract — see selectionTypeHelpers docstring.
      restoreCompositeChannel(doc);
      var msg = String(eAm.message || eAm);
      // Photoshop raises one opaque string for several distinct causes here and
      // gives no way to tell them apart. List the possibilities; never claim
      // which one occurred.
      //
      // Deliberately does NOT repeat selectSubject/selectSky's "switch to Cloud
      // processing" advice: Focus Area is a blur-estimation algorithm that
      // predates Sensei (PS CC 2014) with no downloadable model, so that
      // preference does not govern it. Sending a user there would be invented
      // guidance.
      if (msg.indexOf('not currently valid') !== -1 ||
          msg.indexOf('not currently available') !== -1 ||
          msg.indexOf('may not be available') !== -1) {
        throw new Error(
          'Focus Area returned no result. Photoshop reports one opaque error for several causes and does not say which applied:\n' +
          '  - The active layer may not be an ordinary pixel layer. Focus Area analyses pixels; an adjustment, fill, or empty layer gives it nothing to measure. Target a pixel layer and retry.\n' +
          '  - The image may be uniformly sharp or uniformly soft, leaving no focus boundary to find. Try a different in_focus_radius.\n' +
          '  - The document may be in a colour mode or bit depth the operation refuses.\n' +
          'If none apply, ps_select (mode=magic_wand) on a representative region is the fallback.\n' +
          'Underlying PS error: ' + msg
        );
      }
      throw new Error('Focus Area selection failed: ' + msg);
    } finally {
      if (changedActive) {
        try { doc.activeLayer = origActive; } catch (eRestore) {}
      }
    }

    // The event can succeed with no resulting selection — verify rather than
    // trusting the call returning cleanly. Guarded: a throw from the probe
    // itself would otherwise skip cleanup, orphaning the temp alpha channel and
    // leaving a non-composite channel active, which makes the NEXT mask call
    // fail with "command Make not currently available".
    var hasSelection;
    try {
      var probeRef = new ActionReference();
      probeRef.putProperty(charIDToTypeID('Prpr'), charIDToTypeID('fsel'));
      probeRef.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
      hasSelection = executeActionGet(probeRef).hasKey(charIDToTypeID('fsel'));
    } catch (eProbe) {
      __restoreAndDiscard(savedCh);
      restoreCompositeChannel(doc);
      throw new Error('Focus Area completed but its result could not be read: ' + String(eProbe.message || eProbe));
    }
    if (!hasSelection) {
      __restoreAndDiscard(savedCh);
      restoreCompositeChannel(doc);
      throw new Error(
        'Focus Area completed but selected nothing. The image likely has no focus boundary — ' +
        'either everything is sharp or everything is soft. A larger in_focus_radius widens what ' +
        'counts as sharp; a smaller one narrows it.'
      );
    }

    // whole_canvas_selected/warning diagnose the DETECTION step (focusMask),
    // per the tool's schema and description — not the final, possibly-combined
    // selection. Measure it BEFORE combineWithSavedSelection: folding in
    // whatever the caller already had selected can turn a genuine detection
    // failure (raw result = whole canvas) into an apparent success once a
    // subtract collapses it toward empty, or turn a fine detection into an
    // apparent whole-canvas failure once a union with an already-large prior
    // selection pushes it over the threshold. In selection_type='replace'
    // there is nothing to combine, so this is identical to measuring after —
    // replace-mode behaviour is unchanged.
    // getSelectionInfo reads doc.selection.bounds outside its own try/finally
    // (see its definition), so a throw there would otherwise escape this
    // fragment uncaught. Guard it the same way the probe above it is: restore
    // the stash, then rethrow.
    var rawInfo;
    try {
      rawInfo = getSelectionInfo();
    } catch (eRawInfo) {
      __restoreAndDiscard(savedCh);
      restoreCompositeChannel(doc);
      throw new Error('Focus Area completed but its raw detection could not be measured: ' + String(eRawInfo.message || eRawInfo));
    }
    // A whole-canvas result is technically a selection but almost never a
    // useful one: it means either the radius was too high or the analysed layer
    // had no focus information. Surface it as an explicit flag rather than
    // leaving the caller to infer it from area_percent.
    var wholeCanvas = !!(rawInfo && rawInfo.area_percent >= 99.5);

    combineWithSavedSelection(doc, savedCh, selType);

    // combineWithSavedSelection is a no-op on the selection itself in replace
    // mode or when there was nothing saved (see its own early-return
    // condition, mirrored here), so rawInfo already IS the final selection in
    // that case — re-running getSelectionInfo would pay its channel-store and
    // histogram cost twice for an identical answer.
    //
    // It still removes the stash channel on that path, and a channel remove()
    // does not reliably leave the composite channel active (see
    // restoreCompositeChannel). getSelectionInfo restores it in its own
    // finally, so the branch that skips that call must restore it here or the
    // fragment can return with a non-composite channel active and break the
    // NEXT tool call.
    var finalInfo;
    if (selType === 'replace' || !savedCh) {
      restoreCompositeChannel(doc);
      finalInfo = rawInfo;
    } else {
      finalInfo = getSelectionInfo();
    }

    return {
      selected: true,
      method: 'focus_area',
      strategy_used: 'executeAction:focusMask',
      in_focus_radius: inFocusRadius,
      soft_mask: softMask,
      active_layer_temporarily_changed: changedActive,
      whole_canvas_selected: wholeCanvas,
      warning: wholeCanvas
        ? 'Focus Area\'s detection covered the ENTIRE canvas before any selection_type combine, which is usually a non-result. Lower in_focus_radius, or check that the layer being analysed actually contains photographic pixels.'
        : null,
      selection_type: selType,
      selection_info: finalInfo
    };
  `

	// skyReplacement — composite a new sky and harmonize the foreground to it.
	// NOT a selection: it emits a 'Sky Replacement Group' containing the sky
	// layer, an edge-lighting group, a foreground-lighting layer and a
	// foreground-color curves layer. Masks live as LAYER masks on those layers;
	// doc.channels is untouched (verified 2026-08-15).
	// Slot order (11): getContextInfo, skyPath, skyName, skyId, shiftEdge,
	// borderSmoothness, brightness, temperature, harmonizationOpacity,
	// foregroundLightingOpacity, edgeLightingOpacity. No lighting-mode slot —
	// see the hardcoded 'Scrn' below.
	fragments[vault.SkyRepl] = `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var skyPath = %s;
    var skyName = %s;
    var skyId = %s;

    var skyFile = new File(skyPath);
    if (!skyFile.exists) {
      throw new Error(
        'Sky image not found on disk: ' + skyPath + '\n' +
        'sky_file must be an absolute path to an image Photoshop can open. Built-in Photoshop ' +
        'skies live under the Sky_Presets folder in your Photoshop settings directory; any ' +
        'ordinary JPEG/PNG works too.'
      );
    }

    // Identify the created group by IDENTITY, not by index. doc.layerSets is
    // top-level only, so a pre-existing group can sit at [0] (misattribution)
    // and a group created INSIDE the active group would not change the
    // top-level count at all (false "produced nothing"). Record every existing
    // group's id at any depth, then diff.
    function __collectGroupIds(layers, into) {
      for (var gi = 0; gi < layers.length; gi++) {
        var L = layers[gi];
        if (L.typename === 'LayerSet') {
          into[L.id] = true;
          __collectGroupIds(L.layers, into);
        }
      }
      return into;
    }
    function __findNewGroup(layers, known) {
      for (var fi = 0; fi < layers.length; fi++) {
        var L = layers[fi];
        if (L.typename === 'LayerSet') {
          if (!known[L.id]) { return L; }
          var nested = __findNewGroup(L.layers, known);
          if (nested) { return nested; }
        }
      }
      return null;
    }
    var groupIdsBefore = __collectGroupIds(doc.layers, {});

    try {
      var skyDesc = new ActionDescriptor();
      skyDesc.putDouble(stringIDToTypeID('shiftEdge'), %s);
      skyDesc.putInteger(stringIDToTypeID('borderSmoothness'), %s);
      skyDesc.putInteger(charIDToTypeID('Brgh'), %s);
      skyDesc.putInteger(stringIDToTypeID('temperature'), %s);
      skyDesc.putInteger(stringIDToTypeID('harmonizationOpacity'), %s);
      skyDesc.putInteger(stringIDToTypeID('foregroundLightingOpacity'), %s);
      // lightingMode is sent because the captured, verified-working descriptor
      // carries it — but it is NOT exposed as a tool parameter, because
      // Photoshop ignores it. Proven live 2026-08-16: 'Scrn' and 'Mltp' with
      // every other value identical produced byte-identical renders, and the
      // resulting Foreground Lighting layer was SCREEN/32 in both. PS derives
      // that blend from the sky content itself (it chose MULTIPLY/60 at default
      // settings and SCREEN/32 at extremes, tracking neither request). Exposing
      // it would ship a control that silently does nothing.
      skyDesc.putEnumerated(
        stringIDToTypeID('lightingMode'),
        charIDToTypeID('BlnM'),
        charIDToTypeID('Scrn')
      );
      skyDesc.putInteger(stringIDToTypeID('edgeLightingOpacity'), %s);
      skyDesc.putEnumerated(
        stringIDToTypeID('skyReplacementOutput'),
        stringIDToTypeID('skyReplacementOutput'),
        stringIDToTypeID('skyReplacementOutputToNewSheets')
      );
      // Idnt/Nm identify a registered Photoshop preset. The File path is what
      // actually drives the composite — an arbitrary image works even when the
      // GUID matches no installed preset (verified live 2026-08-15), which is
      // what makes user-supplied skies possible.
      skyDesc.putString(charIDToTypeID('Idnt'), skyId);
      skyDesc.putString(charIDToTypeID('Nm  '), skyName);
      skyDesc.putPath(charIDToTypeID('File'), skyFile);
      executeAction(stringIDToTypeID('skyReplacement'), skyDesc, DialogModes.NO);
    } catch (eAm) {
      var msg = String(eAm.message || eAm);
      if (msg.indexOf('not currently valid') !== -1 ||
          msg.indexOf('not currently available') !== -1 ||
          msg.indexOf('may not be available') !== -1) {
        throw new Error(
          'Sky Replacement returned no result. PS does not distinguish between (a) the sky model being unavailable and (b) the model running but finding no sky to replace, so either may be the cause:\n' +
          '  - For (a), TRY RESTARTING PHOTOSHOP FIRST. The sky model can stop responding partway through a session while other AI features keep working, and a restart restores it (observed 2026-08-16). If a restart does not help, check Photoshop > Preferences > Image Processing > Select Subject and Remove Background and try switching "Device" to "Cloud (Detailed Results)".\n' +
          '  - Quick way to tell the two apart: run ps_select_sky on this same image. If that ALSO fails, the sky model is unavailable and no parameter change here will help. If it succeeds, the model is fine and the cause is (b).\n' +
          '  - For (b): the image may contain no detectable sky (indoor, closed composition, dense foreground).\n' +
          'Underlying PS error: ' + msg
        );
      }
      throw new Error('Sky Replacement failed: ' + msg);
    }

    // Verify the group actually materialized rather than trusting the call.
    var group = __findNewGroup(doc.layers, groupIdsBefore);
    if (!group) {
      throw new Error(
        'Sky Replacement reported success but produced no layer group. The image may contain ' +
        'no detectable sky region. NOTE: the document may still have been modified by the ' +
        'attempt — check the layer stack (ps_inspect what=layer_tree) before retrying, or this ' +
        'tool will stack a second sky group over the first.'
      );
    }

    var produced = [];
    for (var i = 0; i < group.layers.length; i++) {
      produced.push(group.layers[i].name);
    }

    return {
      replaced: true,
      strategy_used: 'executeAction:skyReplacement',
      group_name: group.name,
      group_layers: produced,
      sky_file: skyPath,
      sky_name: skyName,
      context: getContextInfo()
    };
  `
}
