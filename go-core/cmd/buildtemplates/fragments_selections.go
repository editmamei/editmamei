package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// selectRectangle. Slots: 1=selectionTypeHelpers, 2=getSelectionInfo,
		// 3=selectionType(jsLit), 4-11=bounds nums (L,T,R,T,R,B,L,B),
		// 12=featherPx, 13=selectionType(jsLit), 14-17=L,T,R,B (result).
		vault.SelRect: `
    %s
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    var selType = mapSelType(%s);

    var bounds = [[%s, %s], [%s, %s], [%s, %s], [%s, %s]];
    // DOM Selection.select takes (region, type, feather, antiAlias) — pass type
    // directly. Feather is applied as a separate step after so we can keep the
    // value in the return for the agent.
    doc.selection.select(bounds, selType);

    var feather = %s;
    if (feather > 0) {
      doc.selection.feather(feather);
    }

    return {
      selection: 'rectangle',
      method: 'rectangle',
      selection_type: %s,
      requested_bounds: [%s, %s, %s, %s],
      feather_px: feather,
      selection_info: getSelectionInfo()
    };
  `,

		// featherSelection. Slots: 1=getSelectionInfo, 2=radiusPx.
		vault.Feather: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // Check via ActionManager — raw bounds access throws uncatchable
    // PS 2024+ error 1302 with no active selection. ActionManager returns
    // false cleanly.
    var ref = new ActionReference();
    ref.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('fsel'));
    ref.putEnumerated(app.charIDToTypeID('Dcmn'), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
    var hasSelection = app.executeActionGet(ref).hasKey(app.charIDToTypeID('fsel'));
    if (!hasSelection) {
      throw new Error('No active selection to feather');
    }

    var radius = %s;
    if (radius <= 0) {
      throw new Error('Feather radius must be > 0; got ' + radius);
    }
    doc.selection.feather(radius);

    return {
      feathered: true,
      radius_px: radius,
      selection_info: getSelectionInfo()
    };
  `,

		// selectAll. Slots: 1=getSelectionInfo.
		vault.SelAll: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    doc.selection.selectAll();

    return {
      selection: 'all',
      method: 'select_all',
      selection_info: getSelectionInfo()
    };
  `,

		// deselect. Slots: 1=getSelectionInfo.
		vault.Deselect: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    doc.selection.deselect();

    return {
      deselected: true,
      method: 'deselect',
      selection_info: getSelectionInfo()
    };
  `,

		// invertSelection. Slots: 1=getSelectionInfo.
		vault.InvertS: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    doc.selection.invert();

    return {
      inverted: true,
      method: 'invert',
      selection_info: getSelectionInfo()
    };
  `,

		// getSelectionState. Slots: 1=getSelectionInfo.
		vault.SelState: `
    %s
    return getSelectionInfo();
  `,

		// selectPolygon — AM setd on Chnl/fsel with a 'Plgn' object carrying a 'Pts '
		// ActionList of 'Pnt ' descriptors (Hrzn/Vrtc #Pxl) + AntA. The emitter loops
		// the caller's vertices into slot 4 (pntN descriptors + ptsList.putObject).
		// Channel-stash combine. Slots: 1=selectionTypeHelpers, 2=getSelectionInfo,
		// 3=selType(jsLit), 4=points block, 5=antiAlias(jsBool), 6=point_count(int),
		// 7=antiAlias(jsBool, result). Ground truth: ScriptListener capture.
		vault.SelPolygon: `
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

      var plgnDesc = new ActionDescriptor();
      var ptsList = new ActionList();
      %s
      plgnDesc.putList(charIDToTypeID('Pts '), ptsList);
      setdDesc.putObject(charIDToTypeID('T   '), charIDToTypeID('Plgn'), plgnDesc);
      setdDesc.putBoolean(charIDToTypeID('AntA'), %s);

      executeAction(charIDToTypeID('setd'), setdDesc, DialogModes.NO);
    } catch (eRun) {
      if (savedCh) { try { savedCh.remove(); } catch (e) {} }
      restoreCompositeChannel(doc);
      throw new Error('Select Polygon failed: ' + eRun.message);
    }
    combineWithSavedSelection(doc, savedCh, selType);

    return {
      selected: true,
      method: 'polygon',
      point_count: %s,
      anti_alias: %s,
      selection_type: selType,
      selection_info: getSelectionInfo()
    };
  `,

		// selectEllipse — AM setd on Chnl/fsel with an 'Elps' object + AntA, plus an
		// optional Fthr that bakes into the SAME setd. Mirrors magicWand's
		// channel-stash selection-type pattern (uses charIDToTypeID directly, no
		// cTID/sTID helpers). Slots: 1=selectionTypeHelpers, 2=getSelectionInfo,
		// 3=selType(jsLit), 4-7=Top,Left,Btom,Rght (nums), 8=feather(num),
		// 9=antiAlias(jsBool), 10-13=left,top,right,bottom (requested_bounds nums),
		// 14=antiAlias(jsBool, result). Ground truth: ScriptListener capture.
		vault.SelEllipse: `
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

      var elpsDesc = new ActionDescriptor();
      elpsDesc.putUnitDouble(charIDToTypeID('Top '), charIDToTypeID('#Pxl'), %s);
      elpsDesc.putUnitDouble(charIDToTypeID('Left'), charIDToTypeID('#Pxl'), %s);
      elpsDesc.putUnitDouble(charIDToTypeID('Btom'), charIDToTypeID('#Pxl'), %s);
      elpsDesc.putUnitDouble(charIDToTypeID('Rght'), charIDToTypeID('#Pxl'), %s);
      setdDesc.putObject(charIDToTypeID('T   '), charIDToTypeID('Elps'), elpsDesc);

      var featherVal = %s;
      if (featherVal > 0) {
        setdDesc.putUnitDouble(charIDToTypeID('Fthr'), charIDToTypeID('#Pxl'), featherVal);
      }
      setdDesc.putBoolean(charIDToTypeID('AntA'), %s);

      executeAction(charIDToTypeID('setd'), setdDesc, DialogModes.NO);
    } catch (eRun) {
      if (savedCh) { try { savedCh.remove(); } catch (e) {} }
      restoreCompositeChannel(doc);
      throw new Error('Select Ellipse failed: ' + eRun.message);
    }
    combineWithSavedSelection(doc, savedCh, selType);

    return {
      selected: true,
      selection: 'ellipse',
      method: 'ellipse',
      selection_type: selType,
      requested_bounds: [%s, %s, %s, %s],
      feather_px: featherVal,
      anti_alias: %s,
      selection_info: getSelectionInfo()
    };
  `,

		// modifySelectionEdge — top-level event on the CURRENT selection: expand
		// (Expn) / contract (Cntc) / border (Brdr) / smooth (Smth). The emitter
		// supplies the event-specific descriptor block (slot 2) and the event charID
		// (slot 3). Slots: 1=getSelectionInfo, 2=descriptor block, 3=event(jsLit),
		// 4=mode(jsLit, result), 5=amount(num, result). Ground truth: a ScriptListener capture.
		// border (Brdr/Wdth) / smooth (Smth/Rds) / expand (Expn/By) /
		// contract (Cntc/By).
		vault.ModifySel: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    // The modify events require an active selection (no-op/throw without one).
    var modSelRef = new ActionReference();
    modSelRef.putProperty(charIDToTypeID('Prpr'), charIDToTypeID('fsel'));
    modSelRef.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    if (!app.executeActionGet(modSelRef).hasKey(charIDToTypeID('fsel'))) {
      throw new Error('No active selection to modify');
    }

    try {
      var modDesc = new ActionDescriptor();
      %s
      executeAction(charIDToTypeID(%s), modDesc, DialogModes.NO);
    } catch (eRun) {
      restoreCompositeChannel(doc);
      throw new Error('Modify Selection failed: ' + eRun.message);
    }

    return {
      modified: true,
      mode: %s,
      amount_px: %s,
      selection_info: getSelectionInfo()
    };
  `,

		// growSelection — AM Grow / Smlr on Chnl/fsel, both carrying Tlrn (integer) +
		// AntA (boolean) directly. Requires an active selection. Slots:
		// 1=getSelectionInfo, 2=tolerance(num), 3=antiAlias(jsBool), 4=event(jsLit),
		// 5=mode(jsLit, result), 6=tolerance(num, result), 7=antiAlias(jsBool,
		// result). Ground truth: ScriptListener captures (Grow, Smlr).
		vault.GrowSel: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var growSelRef = new ActionReference();
    growSelRef.putProperty(charIDToTypeID('Prpr'), charIDToTypeID('fsel'));
    growSelRef.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    if (!app.executeActionGet(growSelRef).hasKey(charIDToTypeID('fsel'))) {
      throw new Error('No active selection to grow');
    }

    try {
      var growDesc = new ActionDescriptor();
      var growFselRef = new ActionReference();
      growFselRef.putProperty(charIDToTypeID('Chnl'), charIDToTypeID('fsel'));
      growDesc.putReference(charIDToTypeID('null'), growFselRef);
      growDesc.putInteger(charIDToTypeID('Tlrn'), %s);
      growDesc.putBoolean(charIDToTypeID('AntA'), %s);
      executeAction(charIDToTypeID(%s), growDesc, DialogModes.NO);
    } catch (eRun) {
      restoreCompositeChannel(doc);
      throw new Error('Grow/Similar Selection failed: ' + eRun.message);
    }

    return {
      selected: true,
      method: %s,
      tolerance: %s,
      anti_alias: %s,
      selection_info: getSelectionInfo()
    };
  `,

		// transformSelection — AM Trnf on Chnl/fsel: transforms the marching ants
		// (not pixels). FTcs=QCSt/Qcsa anchor + relative Ofst (#Pxl), Wdth/Hght
		// (#Prc), Angl (#Ang), bicubic Intr. Requires an active selection. Slots:
		// 1=getSelectionInfo, 2=offsetX, 3=offsetY, 4=scaleX%, 5=scaleY%, 6=angle,
		// then result: 7=scaleX%, 8=scaleY%, 9=angle, 10=offsetX, 11=offsetY. Ground
		// truth: ScriptListener captures (scale+offset, rotate).
		vault.XformSel: `
    %s

    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;

    var xfSelRef = new ActionReference();
    xfSelRef.putProperty(charIDToTypeID('Prpr'), charIDToTypeID('fsel'));
    xfSelRef.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    if (!app.executeActionGet(xfSelRef).hasKey(charIDToTypeID('fsel'))) {
      throw new Error('No active selection to transform');
    }

    try {
      var trnfDesc = new ActionDescriptor();
      var xfFselRef = new ActionReference();
      xfFselRef.putProperty(charIDToTypeID('Chnl'), charIDToTypeID('fsel'));
      trnfDesc.putReference(charIDToTypeID('null'), xfFselRef);
      trnfDesc.putEnumerated(charIDToTypeID('FTcs'), charIDToTypeID('QCSt'), charIDToTypeID('Qcsa'));
      var ofstDesc = new ActionDescriptor();
      ofstDesc.putUnitDouble(charIDToTypeID('Hrzn'), charIDToTypeID('#Pxl'), %s);
      ofstDesc.putUnitDouble(charIDToTypeID('Vrtc'), charIDToTypeID('#Pxl'), %s);
      trnfDesc.putObject(charIDToTypeID('Ofst'), charIDToTypeID('Ofst'), ofstDesc);
      trnfDesc.putUnitDouble(charIDToTypeID('Wdth'), charIDToTypeID('#Prc'), %s);
      trnfDesc.putUnitDouble(charIDToTypeID('Hght'), charIDToTypeID('#Prc'), %s);
      trnfDesc.putUnitDouble(charIDToTypeID('Angl'), charIDToTypeID('#Ang'), %s);
      trnfDesc.putEnumerated(charIDToTypeID('Intr'), charIDToTypeID('Intp'), charIDToTypeID('Bcbc'));
      executeAction(charIDToTypeID('Trnf'), trnfDesc, DialogModes.NO);
    } catch (eRun) {
      restoreCompositeChannel(doc);
      throw new Error('Transform Selection failed: ' + eRun.message);
    }

    return {
      transformed: true,
      scale_x_percent: %s,
      scale_y_percent: %s,
      rotate_degrees: %s,
      offset_x: %s,
      offset_y: %s,
      selection_info: getSelectionInfo()
    };
  `,
	})
}
