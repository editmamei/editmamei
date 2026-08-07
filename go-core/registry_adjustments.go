package main

import "fmt"

// buildAdjustments handles the adjustments.go emitter family (Shadows/
// Highlights, Color Lookup, Equalize, and the addAdjustmentLayer primitive).
// Extracted verbatim from build()'s switch (Tier-3 S2 part 2 registry split);
// dispatch behavior is unchanged. handled=false means "not my family".
func buildAdjustments(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "applyShadowsHighlights":
		return applyShadowsHighlights(
			numParam(params, "shadowAmount", 35),
			numParam(params, "shadowWidth", 50),
			numParam(params, "shadowRadius", 30),
			numParam(params, "highlightAmount", 0),
			numParam(params, "highlightWidth", 50),
			numParam(params, "highlightRadius", 30),
			numParam(params, "colorCorrection", 20),
			numParam(params, "midtoneContrast", 0),
			numParam(params, "blackClip", 0.01),
			numParam(params, "whiteClip", 0.01),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyColorLookup":
		return applyColorLookup(
			strParam(params, "lutName", ""),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyEqualize":
		return applyEqualize(boolParam(params, "applyToActiveLayer", false)), true, nil
	case "addAdjustmentLayer":
		adjType := strParam(params, "type", "")
		if adjType == "" {
			return "", true, fmt.Errorf("addAdjustmentLayer: missing required field 'type'")
		}
		layerName, hasLayerName := optStrParam(params, "name")
		s, err := addAdjustmentLayer(
			adjType,
			boolParam(params, "clip_to_below", false),
			layerName, hasLayerName,
			params,
			boolParam(params, "mask_from_selection", true),
			boolParam(params, "mask_inverted", false),
			boolParam(params, "into_active_group", false),
		)
		return s, true, err
	}
	return "", false, nil
}
