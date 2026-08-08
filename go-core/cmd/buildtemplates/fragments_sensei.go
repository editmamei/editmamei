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
}
