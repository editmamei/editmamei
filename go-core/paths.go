package main

import (
	"fmt"
	"strings"

	"editmamei-core/internal/vault"
)

// Path-interchange family. The connective tissue: a selection / a generated
// shape / a CV contour → a real editable PS path → stroke / convert to
// selection / clip.
//
// All but savePath are backed by documented DOM PathItem methods (makeWorkPath /
// makeSelection / strokePath / fillPath / makeClippingPath / pathItems.remove);
// savePath uses the "make named path from the work path" AM idiom. The whole
// surface was verified live against PS 27.2.0 on 2026-06-24 (full round-trip:
// create → save → list → load → stroke → fill → set_clipping → delete). Held at
// dev tier per the slice's hold-at-dev decision; the live run is the promotion
// evidence.
//
// Non-destructive ops (create/save/list/delete/load/clip) carry path_info via
// getPathInfo(); load also carries selection_info. The two destructive ops that
// bake pixels (stroke/fill) follow the auto-duplicate-first pattern.

// createPathFromSelection — DOM doc.selection.makeWorkPath(tolerance). Tolerance
// is the crude↔detailed dial (0.5–10 px). NOTE: makeWorkPath CLEARS the active
// selection (the selection becomes the path); surfaced in the return.
func createPathFromSelection(tolerance float64) string {
	return fmt.Sprintf(tpl[vault.PathCreate], getPathInfo(), jsNum(tolerance), jsNum(tolerance))
}

// savePath — AM "make a named path from the current work path". Verified live
// 2026-06-24 (PS 27.2.0): the work path converts to a named saved path.
func savePath(name string) string {
	return fmt.Sprintf(tpl[vault.PathSave], getPathInfo(), jsLit(name))
}

// listPaths — DOM iteration over doc.pathItems. Read-only; returns path_info.
func listPaths() string {
	return fmt.Sprintf(tpl[vault.PathList], getPathInfo())
}

// deletePath — DOM pathItem.remove(). No name → removes the current work path;
// a name → removes that saved path.
func deletePath(name string, hasName bool) string {
	target := "null"
	if hasName {
		target = jsLit(name)
	}
	return fmt.Sprintf(tpl[vault.PathDelete], getPathInfo(), target)
}

// loadPathAsSelection — DOM pathItem.makeSelection(feather, antiAlias, type).
// No name → the current work path; a name → that saved path. operation maps to
// the SelectionType combine mode (replace/add/subtract/intersect).
func loadPathAsSelection(name string, hasName bool, feather float64, antiAlias bool, operation string) string {
	target := "null"
	if hasName {
		target = jsLit(name)
	}
	return fmt.Sprintf(
		tpl[vault.PathLoadSel],
		getSelectionInfo(),
		target,
		jsLit(operation),
		jsNum(feather),
		jsBool(antiAlias),
	)
}

// strokePath — DOM PathItem.strokePath(ToolType). Bakes pixels onto the active
// layer, so it follows the auto-duplicate-first pattern. tool is one of
// the brush-family ToolType constants (validated by the registry).
func strokePath(name string, hasName bool, tool string, applyToActive bool) string {
	target := "null"
	if hasName {
		target = jsLit(name)
	}
	toolConst := brushToolConstMap[tool]
	return fmt.Sprintf(
		tpl[vault.PathStroke],
		getMinimalContextInfo(),
		target,
		duplicateForOp("Stroke Path", applyToActive),
		toolConst,
		jsLit(tool),
		toolConst,
	)
}

// fillPath — DOM PathItem.fillPath(color, mode, opacity, preserveTransparency,
// feather, wholePath, antiAlias). Bakes pixels → auto-duplicate-first. The blend
// mode string maps to a ColorBlendMode inside the snippet.
func fillPath(name string, hasName bool, red, green, blue, opacity float64, mode string, feather float64, antiAlias, applyToActive bool) string {
	target := "null"
	if hasName {
		target = jsLit(name)
	}
	return fmt.Sprintf(
		tpl[vault.PathFill],
		getMinimalContextInfo(),
		target,
		duplicateForOp("Fill Path", applyToActive),
		jsNum(red), jsNum(green), jsNum(blue),
		jsLit(mode),
		jsNum(opacity),
		jsNum(feather),
		jsBool(antiAlias),
	)
}

// setClippingPath — DOM PathItem.makeClippingPath(flatness). Requires a SAVED
// (named) path. flatness is optional (device-pixel smoothing 0.2–100); when the
// caller omits it the snippet calls makeClippingPath() with no argument.
func setClippingPath(name string, flatness float64, hasFlatness bool) string {
	flatExpr := ""
	if hasFlatness {
		flatExpr = jsNum(flatness)
	}
	return fmt.Sprintf(tpl[vault.PathClip], getPathInfo(), jsLit(name), flatExpr)
}

// createPathFromPoints — the grounded pen: build a NAMED editable vector path
// directly from a resolved polyline curve (ps_path create_from_placement, backed
// by the spatial-grounding resolver). Each point becomes a CORNER PathPointInfo
// (the resolved curve is a polyline; left/right direction handles coincide with
// the anchor), assembled into one SubPathInfo and added via doc.pathItems.add(name,
// [sub]) — the same idiom applyBrushStroke uses for its temp stroke path, but SAVED
// under `name`. Reuses the shared BrushPoint fragment (its __bw_pN vars) for each
// point's construction.
func createPathFromPoints(name string, points []pointXY, closed bool) string {
	pointParts := make([]string, 0, len(points))
	arrayItems := make([]string, 0, len(points))
	for idx, p := range points {
		iStr := fmt.Sprintf("%d", idx)
		x, y := jsNum(p.X), jsNum(p.Y)
		pointParts = append(pointParts, fmt.Sprintf(tpl[vault.BrushPoint],
			iStr, iStr, "CORNERPOINT",
			iStr, x, y,
			iStr, x, y,
			iStr, x, y,
		))
		arrayItems = append(arrayItems, fmt.Sprintf("__bw_p%d", idx))
	}
	return fmt.Sprintf(
		tpl[vault.PathFromPts],
		getPathInfo(),
		strings.Join(pointParts, "\n"),
		jsBool(closed),
		strings.Join(arrayItems, ", "),
		jsLit(name),
		fmt.Sprintf("%d", len(points)),
		jsBool(closed),
	)
}
