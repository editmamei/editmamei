package main

// buildRetouch handles the retouch.go emitter family (content-aware fill,
// patch tool, content-aware move). Extracted verbatim from build()'s switch
// (Tier-3 S2 part 2 registry split); dispatch behavior is unchanged.
// handled=false means "not my family".
func buildRetouch(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "applyContentAwareFill":
		return applyContentAwareFill(
			boolParam(params, "colorAdaptation", true),
			boolParam(params, "rotate", false),
			boolParam(params, "scale", false),
			boolParam(params, "mirror", false),
			numParam(params, "opacity", 100),
			strParam(params, "blendMode", "normal"),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyPatch":
		return applyPatch(
			numParam(params, "offsetX", 0),
			numParam(params, "offsetY", 0),
			numParam(params, "patchStructure", 5),
			numParam(params, "patchColor", 5),
			numParam(params, "healSmoothFactor", 5),
			boolParam(params, "sampleAllLayers", false),
			boolParam(params, "transparent", false),
			boolParam(params, "useSource", true),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyContentAwareMove":
		return applyContentAwareMove(
			numParam(params, "offsetX", 0),
			numParam(params, "offsetY", 0),
			numParam(params, "patchStructure", 4),
			numParam(params, "patchColor", 5),
			numParam(params, "healSmoothFactor", 5),
			boolParam(params, "sampleAllLayers", false),
			boolParam(params, "transparent", false),
			boolParam(params, "reshuffle", true),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	}
	return "", false, nil
}
