package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// selection family (Phase 1, batch 2a: simple DOM selections). The AM-heavy
// selectColorRange / magicWand / getSelectionPreview come in a later batch.
// All carry selection_info via getSelectionInfo() (which embeds
// restoreCompositeChannel in its finally), so no separate context return.
//
// selectSubject / selectSky (Adobe Sensei) are community tier. Their emitters
// moved here from the deleted selections_pro.go and their
// fragment bodies to fragments_sensei.go, so the CE binary now emits them. Slot
// order (both): selectionTypeHelpers, getSelectionInfo, selType, sampleAll.

func selectSubject(sampleAllLayers bool, selectionType string) string {
	return fmt.Sprintf(
		tpl[vault.SelSubject],
		selectionTypeHelpers(),
		getSelectionInfo(),
		jsLit(selectionType),
		jsBool(sampleAllLayers),
	)
}

func selectSky(sampleAllLayers bool, selectionType string) string {
	return fmt.Sprintf(
		tpl[vault.SelSky],
		selectionTypeHelpers(),
		getSelectionInfo(),
		jsLit(selectionType),
		jsBool(sampleAllLayers),
	)
}

func selectRectangle(left, top, right, bottom, featherPx float64, selectionType string) string {
	st := jsLit(selectionType)
	l, t, r, b := jsNum(left), jsNum(top), jsNum(right), jsNum(bottom)
	return fmt.Sprintf(
		tpl[vault.SelRect],
		selectionTypeHelpers(),
		getSelectionInfo(),
		st,
		l, t, r, t, r, b, l, b, // bounds quad
		jsNum(featherPx),
		st,
		l, t, r, b, // requested_bounds
	)
}

func featherSelection(radiusPx float64) string {
	return fmt.Sprintf(tpl[vault.Feather], getSelectionInfo(), jsNum(radiusPx))
}

// selectEllipse — AM setd on Chnl/fsel with an Elps object (Top/Left/Btom/Rght
// #Pxl) + AntA, and an optional Fthr that bakes into the SAME setd. Mirrors
// magicWand's channel-stash selection-type pattern. Ground truth confirmed
// via ScriptListener capture (including the feather case).
func selectEllipse(left, top, right, bottom, featherPx float64, antiAlias bool, selectionType string) string {
	l, t, r, b := jsNum(left), jsNum(top), jsNum(right), jsNum(bottom)
	f := jsNum(featherPx)
	aa := jsBool(antiAlias)
	return fmt.Sprintf(
		tpl[vault.SelEllipse],
		selectionTypeHelpers(),
		getSelectionInfo(),
		jsLit(selectionType),
		t, l, b, r, // Elps descriptor: Top, Left, Btom, Rght
		f,          // featherVal
		aa,         // AntA
		l, t, r, b, // requested_bounds [L,T,R,B]
		aa, // anti_alias (result)
	)
}

// pointXY is one absolute document-pixel vertex for selectPolygon.
type pointXY struct{ X, Y float64 }

// selectPolygon — AM setd on Chnl/fsel with a 'Plgn' object carrying a 'Pts '
// ActionList of 'Pnt ' descriptors (Hrzn/Vrtc #Pxl) + AntA. One emitter covers
// the polygonal/freehand/magnetic lasso families (they bake to the identical
// Plgn point list). Auto-closes the ring (first vertex repeated as last) to
// match the captured Polygonal Lasso. Mirrors the channel-stash selection-type
// pattern. Ground truth: ScriptListener capture.
func selectPolygon(points []pointXY, antiAlias bool, selectionType string) string {
	// Close the ring if the caller didn't repeat the first vertex.
	pts := points
	if len(pts) >= 1 {
		first, last := pts[0], pts[len(pts)-1]
		if first.X != last.X || first.Y != last.Y {
			pts = append(append([]pointXY{}, pts...), first)
		}
	}
	block := ""
	for i, p := range pts {
		v := fmt.Sprintf("pnt%d", i)
		block += "var " + v + " = new ActionDescriptor();\n" +
			"      " + v + ".putUnitDouble(charIDToTypeID('Hrzn'), charIDToTypeID('#Pxl'), " + jsNum(p.X) + ");\n" +
			"      " + v + ".putUnitDouble(charIDToTypeID('Vrtc'), charIDToTypeID('#Pxl'), " + jsNum(p.Y) + ");\n" +
			"      ptsList.putObject(charIDToTypeID('Pnt '), " + v + ");\n"
	}
	return fmt.Sprintf(
		tpl[vault.SelPolygon],
		selectionTypeHelpers(),
		getSelectionInfo(),
		jsLit(selectionType),
		block,
		jsBool(antiAlias),
		fmt.Sprintf("%d", len(points)), // point_count (caller-provided vertex count)
		jsBool(antiAlias),
	)
}

// modifySelectionEdge — top-level event acting on the current selection:
// expand (Expn) / contract (Cntc — NOT Cntr) / border (Brdr) / smooth (Smth).
// Expn/Cntc carry By #Pxl + selectionModifyEffectAtCanvasBounds; Smth carries
// Rds #Pxl + the same bool; Brdr carries only Wdth #Pxl. The emitter builds the
// event-specific descriptor block (mirrors selectLuminanceRange). Ground
// truth confirmed via ScriptListener capture.
func modifySelectionEdge(mode string, amountPx float64, atCanvasBounds bool) string {
	amt := jsNum(amountPx)
	cb := jsBool(atCanvasBounds)
	var event, block string
	switch mode {
	case "expand":
		event = "Expn"
		block = "modDesc.putUnitDouble(charIDToTypeID('By  '), charIDToTypeID('#Pxl'), " + amt + ");\n" +
			"      modDesc.putBoolean(stringIDToTypeID('selectionModifyEffectAtCanvasBounds'), " + cb + ");"
	case "contract":
		event = "Cntc"
		block = "modDesc.putUnitDouble(charIDToTypeID('By  '), charIDToTypeID('#Pxl'), " + amt + ");\n" +
			"      modDesc.putBoolean(stringIDToTypeID('selectionModifyEffectAtCanvasBounds'), " + cb + ");"
	case "smooth":
		event = "Smth"
		block = "modDesc.putUnitDouble(charIDToTypeID('Rds '), charIDToTypeID('#Pxl'), " + amt + ");\n" +
			"      modDesc.putBoolean(stringIDToTypeID('selectionModifyEffectAtCanvasBounds'), " + cb + ");"
	case "border":
		event = "Brdr"
		block = "modDesc.putUnitDouble(charIDToTypeID('Wdth'), charIDToTypeID('#Pxl'), " + amt + ");"
	}
	return fmt.Sprintf(
		tpl[vault.ModifySel],
		getSelectionInfo(),
		block,        // descriptor puts (text-order: before executeAction)
		jsLit(event), // charID for executeAction
		jsLit(mode),  // result
		amt,          // result
	)
}

// transformSelection — AM Trnf on Chnl/fsel: transforms the marching ants only
// (not pixels). Relative scale (Wdth/Hght #Prc), rotation (Angl #Ang) and
// translation (Ofst #Pxl) about the selection's own anchor (FTcs=QCSt/Qcsa),
// bicubic interpolation (Intr=Intp/Bcbc). Requires an active selection. Ground
// truth: ScriptListener captures (scale+offset, rotate).
func transformSelection(scaleXPct, scaleYPct, rotateDeg, offsetX, offsetY float64) string {
	sx, sy := jsNum(scaleXPct), jsNum(scaleYPct)
	rot := jsNum(rotateDeg)
	ox, oy := jsNum(offsetX), jsNum(offsetY)
	return fmt.Sprintf(
		tpl[vault.XformSel],
		getSelectionInfo(),
		ox, oy, // Ofst Hrzn/Vrtc
		sx,                  // Wdth
		sy,                  // Hght
		rot,                 // Angl
		sx, sy, rot, ox, oy, // result
	)
}

// growSelection — AM Grow / Smlr on Chnl/fsel. Both carry Tlrn (integer) + AntA
// (boolean) directly in the descriptor, so we parameterize tolerance/anti-alias
// rather than relying on the wand's hidden current state. Ground truth
// confirmed via ScriptListener capture (both grow and similar).
func growSelection(mode string, tolerance float64, antiAlias bool) string {
	var event string
	if mode == "similar" {
		event = "Smlr"
	} else {
		event = "Grow"
	}
	tol := jsNum(tolerance)
	aa := jsBool(antiAlias)
	return fmt.Sprintf(
		tpl[vault.GrowSel],
		getSelectionInfo(),
		tol,          // Tlrn
		aa,           // AntA
		jsLit(event), // charID for executeAction
		jsLit(mode),  // result
		tol,          // result
		aa,           // result
	)
}

func selectAll() string {
	return fmt.Sprintf(tpl[vault.SelAll], getSelectionInfo())
}

func deselect() string {
	return fmt.Sprintf(tpl[vault.Deselect], getSelectionInfo())
}

func invertSelection() string {
	return fmt.Sprintf(tpl[vault.InvertS], getSelectionInfo())
}

func getSelectionState() string {
	return fmt.Sprintf(tpl[vault.SelState], getSelectionInfo())
}

// selectColorRange — AM ClrR with an sRGB→Lab_D50 conversion. Uses the
// channel-stash pattern for non-replace selection types.
func selectColorRange(red, green, blue, fuzziness float64, selectionType string) string {
	r, g, b := jsNum(red), jsNum(green), jsNum(blue)
	fz := jsNum(fuzziness)
	return fmt.Sprintf(
		tpl[vault.ColorRange],
		selectionTypeHelpers(),
		getSelectionInfo(),
		jsLit(selectionType),
		r, g, b, // rgbToLab
		fz,
		r, g, b, // result target_color
		fz, // result fuzziness
	)
}

// selectColorPreset — AM ClrR preset modes driven by the Clrs enum:
// skin_tones (Fzns + Clrs/skinTone + UseFacesKey + colorModel) and out_of_gamut
// (Clrs/OtOf + colorModel, no Fzns). Mirrors selectColorRange's channel-stash
// selection-type pattern; the preset-specific descriptor block is built here.
// Ground truth confirmed via ScriptListener capture (skinTone emits the
// first ClrR event, OtOf the second).
func selectColorPreset(preset string, fuzziness float64, useFaces bool, selectionType string) string {
	var block string
	switch preset {
	case "skin_tones":
		block = "clrRDesc.putInteger(charIDToTypeID('Fzns'), " + jsNum(fuzziness) + ");\n" +
			"      clrRDesc.putEnumerated(charIDToTypeID('Clrs'), charIDToTypeID('Clrs'), stringIDToTypeID('skinTone'));\n" +
			"      clrRDesc.putBoolean(stringIDToTypeID('UseFacesKey'), " + jsBool(useFaces) + ");\n" +
			"      clrRDesc.putInteger(stringIDToTypeID('colorModel'), 0);"
	case "out_of_gamut":
		block = "clrRDesc.putEnumerated(charIDToTypeID('Clrs'), charIDToTypeID('Clrs'), charIDToTypeID('OtOf'));\n" +
			"      clrRDesc.putInteger(stringIDToTypeID('colorModel'), 0);"
	}
	return fmt.Sprintf(
		tpl[vault.SelClrPre],
		selectionTypeHelpers(),
		getSelectionInfo(),
		jsLit(selectionType),
		block,
		jsLit(preset),
	)
}

// selectLuminanceRange — AM ClrR luminance modes. The mode-specific descriptor
// (Hghl uses lowerLimit, Shdw uses upperLimit, Mdtn uses both) + result fields
// are built here, mirroring how applyDistort builds mode-specific blocks. Uses
// charIDToTypeID/stringIDToTypeID directly (no cTID helper) like selectColorRange.
func selectLuminanceRange(mode string, fuzziness, lowerLimit, upperLimit float64, selectionType string) string {
	fz, lo, up := jsNum(fuzziness), jsNum(lowerLimit), jsNum(upperLimit)
	var block, resultFields string
	switch mode {
	case "highlights":
		block = "clrRDesc.putEnumerated(charIDToTypeID('Clrs'), charIDToTypeID('Clrs'), charIDToTypeID('Hghl'));\n" +
			"      clrRDesc.putInteger(stringIDToTypeID('highlightsFuzziness'), " + fz + ");\n" +
			"      clrRDesc.putInteger(stringIDToTypeID('highlightsLowerLimit'), " + lo + ");\n" +
			"      clrRDesc.putInteger(stringIDToTypeID('colorModel'), 0);"
		resultFields = "fuzziness: " + fz + ", lower_limit: " + lo + ","
	case "shadows":
		block = "clrRDesc.putEnumerated(charIDToTypeID('Clrs'), charIDToTypeID('Clrs'), charIDToTypeID('Shdw'));\n" +
			"      clrRDesc.putInteger(stringIDToTypeID('shadowsFuzziness'), " + fz + ");\n" +
			"      clrRDesc.putInteger(stringIDToTypeID('shadowsUpperLimit'), " + up + ");\n" +
			"      clrRDesc.putInteger(stringIDToTypeID('colorModel'), 0);"
		resultFields = "fuzziness: " + fz + ", upper_limit: " + up + ","
	case "midtones":
		block = "clrRDesc.putEnumerated(charIDToTypeID('Clrs'), charIDToTypeID('Clrs'), charIDToTypeID('Mdtn'));\n" +
			"      clrRDesc.putInteger(stringIDToTypeID('midtonesFuzziness'), " + fz + ");\n" +
			"      clrRDesc.putInteger(stringIDToTypeID('midtonesLowerLimit'), " + lo + ");\n" +
			"      clrRDesc.putInteger(stringIDToTypeID('midtonesUpperLimit'), " + up + ");\n" +
			"      clrRDesc.putInteger(stringIDToTypeID('colorModel'), 0);"
		resultFields = "fuzziness: " + fz + ", lower_limit: " + lo + ", upper_limit: " + up + ","
	}
	return fmt.Sprintf(
		tpl[vault.LumRange],
		selectionTypeHelpers(),
		getSelectionInfo(),
		jsLit(selectionType),
		block,
		jsLit(mode),
		resultFields,
	)
}

// refineEdge — AM smartBrushWorkspace (Select-and-Mask sliders, output to
// selection). Refines the current selection headlessly (no modal UI). Uses
// sTID/cTID via helperFunctions; getSelectionInfo for the result.
func refineEdge(radius, smooth, feather, contrast, shiftEdge float64, decontaminate bool) string {
	r, sm, fe := jsNum(radius), jsNum(smooth), jsNum(feather)
	ct, se := jsNum(contrast), jsNum(shiftEdge)
	dc := jsBool(decontaminate)
	return fmt.Sprintf(
		tpl[vault.RefineEdge],
		getSelectionInfo(),
		helperFunctions(),
		r, sm, fe, ct, se, dc,
		r, sm, fe, ct, se, dc,
	)
}

// magicWand — AM setd on Chnl/fsel with a Pnt target + tolerance/flags.
func magicWand(x, y, tolerance float64, contiguous, antiAlias, sampleAllLayers bool, selectionType string) string {
	xs, ys := jsNum(x), jsNum(y)
	tol := jsNum(tolerance)
	ct, aa, sa := jsBool(contiguous), jsBool(antiAlias), jsBool(sampleAllLayers)
	return fmt.Sprintf(
		tpl[vault.MagicWand],
		selectionTypeHelpers(),
		getSelectionInfo(),
		jsLit(selectionType),
		xs, ys, tol, aa, ct, sa, // descriptor
		xs, ys, tol, ct, aa, sa, // result
	)
}

// getSelectionPreview — renders overlay + mask JPEGs from the current
// selection. Interpolates getSelectionInfo() (which embeds RCC) AND a
// standalone restoreCompositeChannel(), matching the TS source.
func getSelectionPreview(overlayPath, maskPath string, maxDim float64) string {
	return fmt.Sprintf(
		tpl[vault.SelPreview],
		getSelectionInfo(),
		restoreCompositeChannel(),
		jsNum(maxDim),
		jsLit(overlayPath),
		jsLit(maskPath),
		jsLit(overlayPath),
		jsLit(maskPath),
	)
}

// saveSelectionToChannel — saves the current active selection to a named Alpha
// channel. Creates the channel if it doesn't exist; overwrites if it does.
func saveSelectionToChannel(channelName string) string {
	return fmt.Sprintf(tpl[vault.SaveSelCh], getSelectionInfo(), jsLit(channelName))
}

// loadSelectionFromChannel — restores a previously saved Alpha channel as the
// active selection. operation maps to PS SelectionType: "replace", "add",
// "subtract", "intersect".
func loadSelectionFromChannel(channelName, operation string) string {
	return fmt.Sprintf(tpl[vault.LoadSelCh], getSelectionInfo(), jsLit(channelName), jsLit(operation))
}

// duplicateChannel — DOM duplicate of a named alpha/spot channel within the same
// document. Optional new name (PS auto-names "<src> copy" when omitted). Skips
// component channels. Ground truth: ScriptListener capture.
func duplicateChannel(channelName, newName string, hasNewName bool) string {
	newNameLit := "null"
	if hasNewName {
		newNameLit = jsLit(newName)
	}
	return fmt.Sprintf(tpl[vault.ChanDup], getMinimalContextInfo(), jsLit(channelName), newNameLit, jsBool(hasNewName))
}

// deleteChannel — DOM remove of a named alpha/spot channel. Refuses to delete
// component (RGB/CMYK/Lab) channels. Ground truth: ScriptListener capture.
func deleteChannel(channelName string) string {
	return fmt.Sprintf(tpl[vault.ChanDel], getMinimalContextInfo(), jsLit(channelName))
}
