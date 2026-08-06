package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// createLayerMask. Slots: 1=helperFunctions, 2=getContextInfo,
		// 3=restoreCompositeChannel. No param slots.
		vault.CreateMask: `
    %s
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var activeLayer = doc.activeLayer;

    // Adjustment layers always own a pixel-mask slot — Mk Chnl At=Msk on
    // an adjustment layer fails because the slot is already occupied. If
    // the active layer is an adjustment layer that already has a mask,
    // treat the call as "load selection into existing mask" instead of
    // "create new mask." If there's no selection, this is a no-op.
    var ADJ_LAYER_KINDS = [
      LayerKind.HUESATURATION,
      LayerKind.LEVELS,
      LayerKind.CURVES,
      LayerKind.BRIGHTNESSCONTRAST,
      LayerKind.COLORBALANCE,
      LayerKind.SELECTIVECOLOR,
      LayerKind.PHOTOFILTER,
      LayerKind.SOLIDFILL,
      LayerKind.GRADIENTMAP,
      LayerKind.GRADIENTFILL,
      LayerKind.PATTERNFILL,
      LayerKind.INVERSION,
      LayerKind.POSTERIZE,
      LayerKind.THRESHOLD,
      LayerKind.BLACKANDWHITE,
      LayerKind.CHANNELMIXER,
      LayerKind.VIBRANCE,
      LayerKind.EXPOSURE
    ];
    var isAdjustmentLayer = false;
    for (var i = 0; i < ADJ_LAYER_KINDS.length; i++) {
      if (activeLayer.kind === ADJ_LAYER_KINDS[i]) { isAdjustmentLayer = true; break; }
    }

    // Probe for an existing selection (use ActionReference / fsel — DOM
    // doc.selection.bounds throws an uncatchable error 1302 in PS 2024+
    // when there's no selection).
    var hasSelection = (function () {
      var probeRef = new ActionReference();
      probeRef.putProperty(cTID('Prpr'), cTID('fsel'));
      probeRef.putEnumerated(cTID('Dcmn'), cTID('Ordn'), cTID('Trgt'));
      return executeActionGet(probeRef).hasKey(cTID('fsel'));
    })();

    var modifiedExistingMask = false;
    var maskCreated = false;

    if (isAdjustmentLayer) {
      // Don't try to create a new mask channel — adjustment layer already
      // has one. If the caller had a selection active, load it into the
      // existing mask. If not, no-op (the existing reveal-all mask stays.)
      //
      // Strategy: target the mask channel, save the user's selection so we
      // can restore it, then (1) deselect + fill black globally on the mask
      // to wipe it, (2) reload the saved selection and fill white. This is
      // order-of-ops safe and doesn't rely on invert succeeding — an earlier
      // version used try-around-invert which silently produced wrong masks
      // when invert failed. Now the only soft path is the channel-restore
      // at the end (cosmetic).
      if (hasSelection) {
        // Save the user's selection to a temporary alpha channel so we can
        // reload it after we wipe the mask. AM Mk Chnl From=fsel
        // atomically creates the channel AND populates it from the
        // current selection in one call — no DOM doc.channels.add()
        // needed first. An earlier version of this snippet did both: the
        // DOM add() created an empty channel, then the AM Mk created
        // ANOTHER channel, and the savedChannel reference got
        // reassigned to the AM-created one. The DOM-created empty
        // channel was orphaned in the document (never removed by
        // savedChannel.remove() because that ref now pointed at the
        // AM one), leaking one alpha channel per adjustment-layer call.
        var savedChannel = null;
        try {
          var saveSelDesc = new ActionDescriptor();
          var saveSelRef = new ActionReference();
          saveSelRef.putClass(cTID('Chnl'));
          saveSelDesc.putReference(cTID('null'), saveSelRef);
          var fromRef = new ActionReference();
          fromRef.putProperty(cTID('Chnl'), cTID('fsel'));
          saveSelDesc.putReference(cTID('From'), fromRef);
          executeAction(cTID('Mk  '), saveSelDesc, DialogModes.NO);
          // Mk created AND selected the new alpha channel — grab a
          // DOM handle so we can delete + reload later. Newly-created
          // channel is the last one.
          savedChannel = doc.channels[doc.channels.length - 1];
        } catch (eSave) {
          throw new Error(
            'create_layer_mask: failed to save selection for adjustment-layer mask update: ' + eSave.message
          );
        }

        try {
          // Select the layer mask channel for painting.
          var slMaskDesc = new ActionDescriptor();
          var slMaskRef = new ActionReference();
          slMaskRef.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
          slMaskDesc.putReference(cTID('null'), slMaskRef);
          executeAction(cTID('slct'), slMaskDesc, DialogModes.NO);

          // Deselect, then fill the entire mask with black (hide everything).
          try { doc.selection.deselect(); } catch (eDe) {}
          var fillBlackDesc = new ActionDescriptor();
          fillBlackDesc.putEnumerated(cTID('Usng'), cTID('FlCn'), cTID('Blck'));
          fillBlackDesc.putInteger(cTID('Opct'), 100);
          fillBlackDesc.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Nrml'));
          executeAction(cTID('Fl  '), fillBlackDesc, DialogModes.NO);

          // Reload the saved selection into the mask channel.
          doc.selection.load(savedChannel);

          // Fill the selection with white (reveal the selected area).
          var fillWhiteDesc = new ActionDescriptor();
          fillWhiteDesc.putEnumerated(cTID('Usng'), cTID('FlCn'), cTID('Wht '));
          fillWhiteDesc.putInteger(cTID('Opct'), 100);
          fillWhiteDesc.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Nrml'));
          executeAction(cTID('Fl  '), fillWhiteDesc, DialogModes.NO);
        } finally {
          // Always clean up the temp channel and restore the composite.
          // Composite restoration is shared with getSelectionPreview's
          // cleanup via the restoreCompositeChannel helper at the top of
          // this file.
          try { savedChannel.remove(); } catch (eCleanup) {}
          restoreCompositeChannel(doc);
        }
        modifiedExistingMask = true;
      }
      // else: no selection + adjustment layer = nothing to do; existing
      // reveal-all mask stays.
    } else {
      // Normal/pixel/group/shape/text layer — create a fresh mask channel.
      //
      // Canonical AM descriptor — matches Adobe ScriptListener output
      // verified on macOS PS 27.7 (2026-06-08, captures A/B/D from
      // Layer > Layer Mask > Reveal All / Reveal Selection / Hide All):
      //
      //   make(new=class<channel>,
      //        at=ref<enum<channel, channel, mask>>,
      //        using=enum<userMaskEnabled, revealSelection|revealAll|hideAll>)
      //
      // Notes on the captured shape:
      //   - The class is declared as a putClass directly on the
      //     descriptor under the "new" key — NOT as a putReference of a
      //     class-only ActionReference under the "null" key. Earlier
      //     forum-derived snippets used the null/putReference shape;
      //     macOS PS 27.7 strict-mode rejects it with "command Make is
      //     not currently available."
      //   - Every key/value uses stringIDToTypeID. charID/stringID
      //     equivalence holds in most contexts on most PS versions but
      //     NOT here on macOS — the captures are stringID, so we mirror
      //     them verbatim. (See feedback memory: pin against
      //     ScriptListener capture before shipping.)
      //   - The "At" slot is still a reference containing an enumerated
      //     chain (channel/channel/mask), matching the v0.5.7 fix to
      //     that slot. v0.5.7 fixed At but kept the wrong class-slot
      //     shape; v0.5.8 fixes the class slot.
      //
      // Bug history:
      //   - Pre-v0.5.7: At was a bare putEnumerated call on the outer
      //     descriptor instead of an ActionReference. Windows accepted
      //     leniently, macOS rejected.
      //   - v0.5.7: At fixed to ActionReference, but class slot kept as
      //     null/putReference(class). macOS still rejected.
      //   - v0.5.8 (this): class slot fixed to putClass on "new",
      //     entire descriptor switched to stringIDs to match capture.
      //
      // Pick revealSelection only when a selection is live —
      // revealSelection with no selection throws on PS 27.x.
      var desc = new ActionDescriptor();
      desc.putClass(sTID('new'), sTID('channel'));
      // At slot — ActionReference wrapping enumerated channel chain.
      var atRef = new ActionReference();
      atRef.putEnumerated(sTID('channel'), sTID('channel'), sTID('mask'));
      desc.putReference(sTID('at'), atRef);
      desc.putEnumerated(sTID('using'), sTID('userMaskEnabled'), hasSelection ? sTID('revealSelection') : sTID('revealAll'));
      executeAction(sTID('make'), desc, DialogModes.NO);
      maskCreated = true;
    }

    return {
      maskCreated: maskCreated,
      modifiedExistingMask: modifiedExistingMask,
      activeLayerKind: String(activeLayer.kind),
      hadSelection: hasSelection,
      context: getContextInfo()
    };
  `,

		// deleteLayerMask. Slots: 1=helperFunctions, 2=getContextInfo.
		vault.DeleteMask: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }

    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
    desc.putReference(cTID('null'), ref);
    executeAction(cTID('Dlt '), desc, DialogModes.NO);

    return {
      maskDeleted: true,
      context: getContextInfo()
    };
  `,

		// applyLayerMask. Slots: 1=helperFunctions, 2=getContextInfo.
		vault.ApplyMask: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }

    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    // Keep the explicit Chnl/Chnl/Msk reference (safer for LLM callers
    // than the capture's Chnl/Ordn/Trgt — the explicit form works even
    // when the mask channel isn't pre-selected as the active channel).
    ref.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
    desc.putReference(cTID('null'), ref);
    desc.putBoolean(cTID('Aply'), true);
    executeAction(cTID('Dlt '), desc, DialogModes.NO);

    return {
      maskApplied: true,
      context: getContextInfo()
    };
  `,

		// addVectorMask — AM make vector mask from the active path. Slots:
		// 1=getMinimalContextInfo, 2=source. Verified live 2026-06-24 (PS 27.2.0):
		// the from_current_path descriptor works. The reveal_all / hide_all empty-mask
		// variants (putClass(Usng, path)) FAILED live with a General PS error and were
		// dropped pending a real ScriptListener capture — only from_current_path ships.
		vault.VMAdd: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    if (doc.activeLayer.isBackgroundLayer) {
      throw new Error('Cannot add a vector mask to the background layer. Convert it to a normal layer first.');
    }
    if (doc.pathItems.length === 0) {
      throw new Error('No path to convert to a vector mask. Create or select one first (ps_path op=create_from_selection / save).');
    }

    var __vmSource = %s;

    var __vmDesc = new ActionDescriptor();
    var __vmRef = new ActionReference();
    __vmRef.putClass(app.stringIDToTypeID('path'));
    __vmDesc.putReference(app.charIDToTypeID('null'), __vmRef);
    var __vmAt = new ActionReference();
    __vmAt.putEnumerated(app.stringIDToTypeID('path'), app.stringIDToTypeID('path'), app.stringIDToTypeID('vectorMask'));
    __vmDesc.putReference(app.charIDToTypeID('At  '), __vmAt);
    var __vmUsing = new ActionReference();
    __vmUsing.putEnumerated(app.stringIDToTypeID('path'), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
    __vmDesc.putReference(app.charIDToTypeID('Usng'), __vmUsing);
    app.executeAction(app.charIDToTypeID('Mk  '), __vmDesc, DialogModes.NO);

    return {
      vector_mask_added: true,
      source: __vmSource,
      layer_name: doc.activeLayer.name,
      context: getMinimalContextInfo()
    };
  `,

		// addVectorMaskFill — reveal_all / hide_all empty vector masks (m4a STEP-23/24).
		// Unlike VMAdd these need NO existing path: Usng is an ENUM (vectorMaskEnabled
		// RvlA/HdAl), not a path reference. Slots: 1=getMinimalContextInfo,
		// 2=source(jsLit), 3=RvlA|HdAl charID.
		vault.VMFill: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    if (doc.activeLayer.isBackgroundLayer) {
      throw new Error('Cannot add a vector mask to the background layer. Convert it to a normal layer first.');
    }

    var __vmSource = %s;

    var __vmDesc = new ActionDescriptor();
    var __vmRef = new ActionReference();
    __vmRef.putClass(app.stringIDToTypeID('path'));
    __vmDesc.putReference(app.charIDToTypeID('null'), __vmRef);
    var __vmAt = new ActionReference();
    __vmAt.putEnumerated(app.stringIDToTypeID('path'), app.stringIDToTypeID('path'), app.stringIDToTypeID('vectorMask'));
    __vmDesc.putReference(app.charIDToTypeID('At  '), __vmAt);
    __vmDesc.putEnumerated(app.charIDToTypeID('Usng'), app.stringIDToTypeID('vectorMaskEnabled'), app.charIDToTypeID('%s'));
    app.executeAction(app.charIDToTypeID('Mk  '), __vmDesc, DialogModes.NO);

    return {
      vector_mask_added: true,
      source: __vmSource,
      layer_name: doc.activeLayer.name,
      context: getMinimalContextInfo()
    };
  `,

		// deleteVectorMask — AM delete on the vectorMask channel. Slot:
		// 1=getMinimalContextInfo. Verified live 2026-06-24 (PS 27.2.0).
		vault.VMDel: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var __dvDesc = new ActionDescriptor();
    var __dvRef = new ActionReference();
    __dvRef.putEnumerated(app.stringIDToTypeID('path'), app.stringIDToTypeID('path'), app.stringIDToTypeID('vectorMask'));
    __dvDesc.putReference(app.charIDToTypeID('null'), __dvRef);
    app.executeAction(app.charIDToTypeID('Dlt '), __dvDesc, DialogModes.NO);

    return { vector_mask_deleted: true, layer_name: doc.activeLayer.name, context: getMinimalContextInfo() };
  `,

		// setVectorMaskLink — AM set vectorMaskLinked. Slots: 1=getMinimalContextInfo,
		// 2=linked(bool). Verified live 2026-06-24 (PS 27.2.0): link + unlink both work
		// on a layer that has a vector mask.
		vault.VMLink: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var __vmLinked = %s;

    var __lkDesc = new ActionDescriptor();
    var __lkRef = new ActionReference();
    __lkRef.putEnumerated(app.charIDToTypeID('Lyr '), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
    __lkDesc.putReference(app.charIDToTypeID('null'), __lkRef);
    var __lkVal = new ActionDescriptor();
    __lkVal.putBoolean(app.stringIDToTypeID('vectorMaskLinked'), __vmLinked);
    __lkDesc.putObject(app.charIDToTypeID('T   '), app.charIDToTypeID('Lyr '), __lkVal);
    app.executeAction(app.charIDToTypeID('setd'), __lkDesc, DialogModes.NO);

    return { vector_mask_linked: __vmLinked, layer_name: doc.activeLayer.name, context: getMinimalContextInfo() };
  `,

		// setVectorMaskEnabled — AM set vectorMaskEnabled. Slots: 1=getMinimalContextInfo,
		// 2=enabled(bool). Ground truth: m4a STEP-28 (PS 27.x Windows) — disable (false)
		// and enable (true) both verified on a layer that has a vector mask. Exact parallel
		// to setVectorMaskLink, swapping vectorMaskLinked → vectorMaskEnabled.
		vault.VMEnable: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var __vmEnabled = %s;

    var __enDesc = new ActionDescriptor();
    var __enRef = new ActionReference();
    __enRef.putEnumerated(app.charIDToTypeID('Lyr '), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
    __enDesc.putReference(app.charIDToTypeID('null'), __enRef);
    var __enVal = new ActionDescriptor();
    __enVal.putBoolean(app.stringIDToTypeID('vectorMaskEnabled'), __vmEnabled);
    __enDesc.putObject(app.charIDToTypeID('T   '), app.charIDToTypeID('Lyr '), __enVal);
    app.executeAction(app.charIDToTypeID('setd'), __enDesc, DialogModes.NO);

    return { vector_mask_enabled: __vmEnabled, layer_name: doc.activeLayer.name, context: getMinimalContextInfo() };
  `,
	})
}
