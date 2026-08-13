package main

import (
	"fmt"
	"strconv"
	"strings"

	"editmamei-core/internal/vault"
)

// layer-transform family. All community-tier as of the 2026-06-16 tier
// rollout — move/rotate/scale/fit were promoted from Pro and their emitters
// moved here from the (now deleted) layer_transform_pro.go.

// moveLayerToPosition — TOP/BOTTOM use the doc container; ABOVE/BELOW need a
// target. layerToMoveName and targetLayerName are optional; the emitter builds
// the lookup-vs-default blocks accordingly.
func moveLayerToPosition(targetLayerName string, hasTarget bool, position, layerToMoveName string, hasLayerToMove bool) string {
	moveBlock := "layerToMove = doc.activeLayer;"
	if hasLayerToMove {
		ln := jsLit(layerToMoveName)
		moveBlock = "layerToMove = findLayerByName(doc.layers, normName(" + ln + "));\n" +
			"    if (!layerToMove) {\n" +
			"      throw new Error(__notFoundMessage('layer_to_move', " + ln + ", false));\n" +
			"    }"
	}

	targetBlock := "throw new Error('ABOVE/BELOW require target_layer_name');"
	relativeTo := "null"
	if hasTarget {
		tn := jsLit(targetLayerName)
		targetBlock = "var targetLayer = findLayerByName(doc.layers, normName(" + tn + "));\n" +
			"    if (!targetLayer) {\n" +
			"      throw new Error(__notFoundMessage('target_layer_name', " + tn + ", false));\n" +
			"    }"
		relativeTo = "targetLayer.name"
	}

	// Only the by-name branches can miss, and this snippet's common shape is
	// TOP/BOTTOM on the active layer — don't ship the helper body when nothing
	// can call it.
	notFound := ""
	if hasLayerToMove || hasTarget {
		notFound = notFoundMessageHelper()
	}

	return fmt.Sprintf(
		tpl[vault.MoveToPos],
		getContextInfo(),
		jsLit(position),
		normNameHelper(),
		notFound,
		moveBlock,
		targetBlock,
		relativeTo,
	)
}

// layer-transform emitters (move / rotate / scale / fit). Ported verbatim from
// src/api/extendscript/layer-transform.ts. The TS tool handler resolves the
// moveLayer positioning mode + mutual-exclusivity BEFORE calling the snippet,
// so moveLayer here just receives the resolved mode + values.

func fitLayerToDocument(fillDocument bool) string {
	fd := jsBool(fillDocument)
	// slots: getContextInfo, fillDocument (if), fillDocument (mode label)
	return fmt.Sprintf(tpl[vault.LtFit], getContextInfo(), fd, fd)
}

func scaleLayer(scalePercent float64, centerAnchor bool) string {
	anchor := "AnchorPosition.TOPLEFT"
	if centerAnchor {
		anchor = "AnchorPosition.MIDDLECENTER"
	}
	sp := jsNum(scalePercent)
	// slots: anchor, resize x, resize y, result percent
	return fmt.Sprintf(tpl[vault.LtScale], anchor, sp, sp, sp)
}

// scaleLayerXY — non-uniform scale (independent x/y). Parallel to scaleLayer so
// the golden-pinned uniform path stays untouched.
func scaleLayerXY(scaleX, scaleY float64, centerAnchor bool) string {
	anchor := "AnchorPosition.TOPLEFT"
	if centerAnchor {
		anchor = "AnchorPosition.MIDDLECENTER"
	}
	sx, sy := jsNum(scaleX), jsNum(scaleY)
	return fmt.Sprintf(tpl[vault.LtScaleXY], anchor, sx, sy, sx, sy)
}

// flipAxisMap maps the user-facing axis to the PS Flip Axis/Ornt charID
// (captured 2026-06-20). The registry validates the key.
var flipAxisMap = map[string]string{"horizontal": "Hrzn", "vertical": "Vrtc"}

// flipLayer — AM Flip on the active layer (auto-promotes background).
func flipLayer(axis string) string {
	return fmt.Sprintf(tpl[vault.LtFlip], flipAxisMap[axis], jsLit(axis))
}

func rotateLayer(degrees float64) string {
	d := jsNum(degrees)
	// slots: rotate degrees, result degrees
	return fmt.Sprintf(tpl[vault.LtRot], d, d)
}

// ---- M2 raw-AM transforms (dev-tier, 2026-06-21) ---------------------------
// Unlike scale/rotate/move above (DOM-based), skew/free-numeric/warp have no
// DOM equivalent — they build raw Trnf descriptors mirroring the M1 raw-AM
// pattern (selections.go). Ground truth confirmed via ScriptListener capture.

// transformLayerMatrix — AM Trnf on the active layer. mode "skew" includes the
// Skew Pnt sub-object (Hrzn/Vrtc #Ang); mode "free" omits it (numeric free
// transform). Auto-promotes the background.
func transformLayerMatrix(mode string, scaleXPct, scaleYPct, skewH, skewV, rotateDeg, offsetX, offsetY float64) string {
	sx, sy := jsNum(scaleXPct), jsNum(scaleYPct)
	rot := jsNum(rotateDeg)
	ox, oy := jsNum(offsetX), jsNum(offsetY)
	sh, sv := jsNum(skewH), jsNum(skewV)
	skewBlock := ""
	if mode == "skew" {
		skewBlock = "var mSkew = new ActionDescriptor();\n" +
			"    mSkew.putUnitDouble(charIDToTypeID('Hrzn'), charIDToTypeID('#Ang'), " + sh + ");\n" +
			"    mSkew.putUnitDouble(charIDToTypeID('Vrtc'), charIDToTypeID('#Ang'), " + sv + ");\n" +
			"    trnfDesc.putObject(charIDToTypeID('Skew'), charIDToTypeID('Pnt '), mSkew);"
	}
	return fmt.Sprintf(
		tpl[vault.LtMatrix],
		ox, oy, // Ofst Hrzn/Vrtc
		sx, sy, // Wdth/Hght #Prc
		skewBlock,
		rot,         // Angl
		jsLit(mode), // result mode
		sx, sy, rot, // result scale + rotate
		sh, sv, // result skew
	)
}

// warpStyleMap is the warpStyle enum allowlist (injection guard — only these
// reach the descriptor). Six values are capture-confirmed
// (warpArc/warpFlag/warpWave/warpFisheye/warpInflate/warpTwist) plus the
// Adobe-documented remainder; warpArch is documented but NOT captured —
// confirm at live-verify.
var warpStyleMap = map[string]bool{
	"warpArc": true, "warpArcUpper": true, "warpArcLower": true,
	"warpArch": true, "warpBulge": true, "warpShellLower": true,
	"warpShellUpper": true, "warpFlag": true, "warpWave": true,
	"warpFisheye": true, "warpInflate": true, "warpSqueeze": true,
	"warpTwist": true, "warpRise": true,
}

// warpRotateMap maps the user-facing orientation to the warpRotate Ornt charID.
var warpRotateMap = map[string]string{"horizontal": "Hrzn", "vertical": "Vrtc"}

// warpLayer — AM Trnf → nested warp obj (preset envelope warp). bounds computed
// in-JSX from the live layer.bounds; uOrder=4/vOrder=2 constants emitted
// verbatim. Auto-promotes the background. Ground truth: ScriptListener capture.
func warpLayer(style string, bend, hDistort, vDistort float64, orientation string) string {
	return fmt.Sprintf(
		tpl[vault.WarpPreset],
		style,                      // warpStyle (registry-allowlisted)
		jsNum(bend),                // warpValue
		jsNum(hDistort),            // warpPerspective
		jsNum(vDistort),            // warpPerspectiveOther
		warpRotateMap[orientation], // warpRotate charID
		jsLit(style),               // result
		jsNum(bend), jsNum(hDistort), jsNum(vDistort),
		jsLit(orientation),
	)
}

// warpPinEdgeMap is the pin_edge allowlist (injection guard — only these reach
// the snippet) for the custom-mesh warp. The pinned edge's control column/row is
// held at the home grid, so the warp is welded to it by construction.
var warpPinEdgeMap = map[string]bool{"left": true, "right": true, "top": true, "bottom": true}

// meshPointsLiteral formats raw control points as a JS row-major array literal
// ([[x,y],[x,y],...]) for the warpMesh raw-mesh path. Numbers go through jsNum
// (the same numeric escaper every emitter uses), so a non-finite value can't
// inject arbitrary JS.
func meshPointsLiteral(pts []pointXY) string {
	var sb strings.Builder
	sb.WriteString("[")
	for i, p := range pts {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString("[")
		sb.WriteString(jsNum(p.X))
		sb.WriteString(",")
		sb.WriteString(jsNum(p.Y))
		sb.WriteString("]")
	}
	sb.WriteString("]")
	return sb.String()
}

// warpMesh — AM Trnf → quiltWarp custom mesh. The grid geometry is computed
// IN-JSX from the live layer.bounds (the home grid spans the layer bbox), so Go
// only injects the scalar shape params (or, for the raw path, the verbatim mesh
// literal). ncx/ncy are CELL counts → the quilt carries (3*ncx+1)*(3*ncy+1)
// control points. rawPointsJS is "" for the high-level path. Ground truth:
// Ground truth: ScriptListener capture. Slots match vault.WarpMesh.
func warpMesh(pinEdge string, ncx, ncy int, lift, bendAt, sharpness, taper float64, rawPointsJS string) string {
	raw := "null"
	if rawPointsJS != "" {
		raw = rawPointsJS
	}
	return fmt.Sprintf(
		tpl[vault.WarpMesh],
		jsLit(pinEdge),    // PIN
		strconv.Itoa(ncx), // NCX
		strconv.Itoa(ncy), // NCY
		jsNum(lift),       // LIFT
		jsNum(bendAt),     // BEND_AT
		jsNum(sharpness),  // SHARP
		jsNum(taper),      // TAPER
		raw,               // RAW
	)
}

func moveLayer(deltaX, deltaY float64, mode string, absoluteX, absoluteY, centerOnX, centerOnY float64) string {
	// computeDeltaBlock — picks the bounds math for the chosen mode. Inline
	// like moveLayerToPosition's blocks (the bulk body lives in the sealed
	// LtMove fragment; this is pure-DOM glue).
	var deltaBlock string
	switch mode {
	case "absolute":
		deltaBlock = "\n    var b = layer.boundsNoEffects !== undefined ? layer.boundsNoEffects : layer.bounds;" +
			"\n    var curL = b[0].as('px'), curT = b[1].as('px');" +
			"\n    var tx = " + jsNum(absoluteX) + " - curL;" +
			"\n    var ty = " + jsNum(absoluteY) + " - curT;"
	case "center":
		deltaBlock = "\n    var b = layer.boundsNoEffects !== undefined ? layer.boundsNoEffects : layer.bounds;" +
			"\n    var curCx = (b[0].as('px') + b[2].as('px')) / 2;" +
			"\n    var curCy = (b[1].as('px') + b[3].as('px')) / 2;" +
			"\n    var tx = " + jsNum(centerOnX) + " - curCx;" +
			"\n    var ty = " + jsNum(centerOnY) + " - curCy;"
	default: // delta
		deltaBlock = "\n    var tx = " + jsNum(deltaX) + ";" +
			"\n    var ty = " + jsNum(deltaY) + ";"
	}

	// requested_* fields are the input value in their own mode, else literal
	// `null` (matches the TS `mode === 'x' ? jsNum(v) : 'null'`).
	nullOr := func(active bool, v float64) string {
		if active {
			return jsNum(v)
		}
		return "null"
	}
	isDelta := mode == "delta"
	isAbs := mode == "absolute"
	isCenter := mode == "center"

	// slots: deltaBlock, mode, requested d_x/d_y/abs_x/abs_y/ctr_x/ctr_y
	return fmt.Sprintf(
		tpl[vault.LtMove],
		deltaBlock,
		jsLit(mode),
		nullOr(isDelta, deltaX),
		nullOr(isDelta, deltaY),
		nullOr(isAbs, absoluteX),
		nullOr(isAbs, absoluteY),
		nullOr(isCenter, centerOnX),
		nullOr(isCenter, centerOnY),
	)
}
