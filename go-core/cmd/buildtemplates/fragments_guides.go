package main

import "editmamei-core/internal/vault"

func init() {
	addFragments(map[string]string{
		// rotateCanvas — AM Rtte targeting the document (Dcmn/Ordn/Frst, NOT a layer
		// ref — that is the discriminator vs layer-rotate). Arbitrary degrees incl.
		// 90/180. STEP-26. Slots: 1=Angl, 2=degrees(result).
		vault.CanvasRot: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var rotDesc = new ActionDescriptor();
    var rotRef = new ActionReference();
    rotRef.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Frst'));
    rotDesc.putReference(charIDToTypeID('null'), rotRef);
    rotDesc.putUnitDouble(charIDToTypeID('Angl'), charIDToTypeID('#Ang'), %s);
    executeAction(charIDToTypeID('Rtte'), rotDesc, DialogModes.NO);

    return { rotated_canvas: true, degrees: %s };
  `,

		// flipCanvas — AM Flip targeting the document (Dcmn/Ordn/Frst). STEP-27.
		// Slots: 1=Axis Ornt charID (Hrzn/Vrtc), 2=axis(jsLit result).
		vault.CanvasFlip: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var flipDesc = new ActionDescriptor();
    var flipRef = new ActionReference();
    flipRef.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Frst'));
    flipDesc.putReference(charIDToTypeID('null'), flipRef);
    flipDesc.putEnumerated(charIDToTypeID('Axis'), charIDToTypeID('Ornt'), charIDToTypeID('%s'));
    executeAction(charIDToTypeID('Flip'), flipDesc, DialogModes.NO);

    return { flipped_canvas: true, axis: %s };
  `,

		// addGuide — DOM doc.guides.add(direction, coordinate). The captured AM Mk
		// path bakes a runtime document id + guide index into the descriptor; the
		// DOM API is the robust coordinate-free equivalent. STEP-32/33.
		// Slots: 1=Direction enum, 2=position px, 3=orientation(jsLit), 4=position(result).
		vault.GuideAdd: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var doc = app.activeDocument;
    doc.guides.add(%s, UnitValue(%s, 'px'));

    return { guide_added: true, orientation: %s, position: %s };
  `,

		// addGuideLayout — AM newGuideLayout with presetKindCustom + a guideLayout
		// obj carrying colCount/rowCount. Guide color fields (GdC*) are omitted — PS
		// defaults them. STEP-34. Slots: 1=colCount, 2=rowCount, 3=columns(result),
		// 4=rows(result).
		vault.GuideLayout: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    var glDesc = new ActionDescriptor();
    glDesc.putEnumerated(stringIDToTypeID('presetKind'), stringIDToTypeID('presetKindType'), stringIDToTypeID('presetKindCustom'));
    var glInner = new ActionDescriptor();
    glInner.putInteger(stringIDToTypeID('colCount'), %s);
    glInner.putInteger(stringIDToTypeID('rowCount'), %s);
    glDesc.putObject(stringIDToTypeID('guideLayout'), stringIDToTypeID('guideLayout'), glInner);
    glDesc.putEnumerated(stringIDToTypeID('guideTarget'), stringIDToTypeID('guideTarget'), stringIDToTypeID('guideTargetCanvas'));
    executeAction(stringIDToTypeID('newGuideLayout'), glDesc, DialogModes.NO);

    return { guide_layout_created: true, columns: %s, rows: %s };
  `,

		// clearGuides — AM clearAllGuides (zero-field event; undefined descriptor).
		// STEP-35.
		vault.GuideClear: `
    if (app.documents.length === 0) {
      throw new Error('No document is open in Photoshop');
    }
    executeAction(stringIDToTypeID('clearAllGuides'), undefined, DialogModes.NO);

    return { guides_cleared: true };
  `,
	})
}
