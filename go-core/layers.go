package main

import (
	"fmt"

	"editmamei-core/internal/vault"
)

// layers family (Phase 1). newLayer/deleteLayer/duplicateLayer change WHAT
// exists so they carry full getContextInfo(); fillLayer is a pure setter
// (no context). selectLayer/rasterizeLayer/getLayerTree live in other
// categories and come in later batches.

func newLayer(name string, hasName bool) string {
	nameAssign := ""
	if hasName {
		nameAssign = "layer.name = " + jsLit(name) + ";"
	}
	return fmt.Sprintf(tpl[vault.NewLayer], parentPathHelper(), getContextInfo(), nameAssign)
}

// deleteLayer — with a name, recurses by normName to find+remove the match;
// without, removes the active layer. The branch is built from a sub-fragment.
func deleteLayer(name string, hasName bool) string {
	var branch string
	if hasName {
		n := jsLit(name)
		branch = fmt.Sprintf(tpl[vault.DelLayerNamed], normNameHelper(), n, n)
	} else {
		branch = tpl[vault.DelLayerActive]
	}
	return fmt.Sprintf(tpl[vault.DeleteLayer], getContextInfo(), branch)
}

func fillLayer(red, green, blue float64) string {
	r, g, b := jsNum(red), jsNum(green), jsNum(blue)
	return fmt.Sprintf(tpl[vault.FillLayer], r, g, b, r, g, b)
}

func duplicateLayer(newName string, hasNewName bool) string {
	nameAssign := ""
	if hasNewName {
		nameAssign = "duplicated.name = " + jsLit(newName) + ";"
	}
	return fmt.Sprintf(tpl[vault.DupLayer], parentPathHelper(), getContextInfo(), nameAssign)
}

func mergeVisibleLayers() string {
	return fmt.Sprintf(tpl[vault.MergeVis], getContextInfo())
}

func stampVisible() string {
	return fmt.Sprintf(tpl[vault.StampVis], getContextInfo())
}

func flattenImage() string {
	return fmt.Sprintf(tpl[vault.FlattenImg], getContextInfo())
}

func convertToSmartObject() string {
	return fmt.Sprintf(tpl[vault.ConvertToSO], getContextInfo())
}

// newSmartObjectViaCopy — "New Smart Object via Copy" (placedLayerMakeCopy): makes
// a new smart object that is an independent copy of the active SO, unlinked from the
// original's shared source. Requires the active layer already be a smart object.
// Ground truth: m4a STEP-02.
func newSmartObjectViaCopy() string {
	return fmt.Sprintf(tpl[vault.SONewViaCopy], getContextInfo())
}

// layerViaCopy — "Layer via Copy" (Ctrl+J): copies the active selection (or the
// whole layer if none) to a new layer. Changes WHAT exists, so it carries full
// getContextInfo(). intoActiveGroup (Phase 4 layer-placement-bug fix)
// suppresses the default hoist-out-of-the-active-group behavior, keeping PS's
// native nesting.
func layerViaCopy(intoActiveGroup bool) string {
	return fmt.Sprintf(
		tpl[vault.LayerViaCopy],
		parentPathHelper(), hoistFromActiveGroupHelper(), getContextInfo(),
		jsBool(intoActiveGroup),
	)
}

// bakeLayer — flatten the active layer + its clipped adjustments + styles into a
// new pixel layer (non-destructive). Changes WHAT exists → full getContextInfo().
func bakeLayer() string {
	return fmt.Sprintf(tpl[vault.BakeLayer], getContextInfo())
}

// addFillLayer — Mk contentLayer / solidColorLayer with an RGBC color. Creates a
// new layer → full getContextInfo(). (Gradient/pattern fill types come later.)
// intoActiveGroup (Phase 4 layer-placement-bug fix) suppresses the default
// hoist-out-of-the-active-group behavior, keeping PS's native nesting.
func addFillLayer(red, green, blue float64, intoActiveGroup bool) string {
	r, g, b := jsNum(red), jsNum(green), jsNum(blue)
	return fmt.Sprintf(
		tpl[vault.AddFillLayer],
		parentPathHelper(), hoistFromActiveGroupHelper(), getContextInfo(),
		r, g, b,
		jsBool(intoActiveGroup),
		r, g, b,
	)
}
