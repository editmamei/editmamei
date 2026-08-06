package main

// buildLayerProperties handles the layer_properties.go emitter family
// (opacity/blend-mode/visibility/lock/rename, select_layer, rasterize, layer
// styles). Extracted verbatim from build()'s switch (Tier-3 S2 part 2
// registry split); dispatch behavior is unchanged. handled=false means "not
// my family".
func buildLayerProperties(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "setLayerOpacity":
		if _, ok := params["fillOpacity"]; ok {
			op, hasOp := optNumParam(params, "opacity")
			return setLayerOpacityFull(op, hasOp, numParam(params, "fillOpacity", 100)), true, nil
		}
		return setLayerOpacity(numParam(params, "opacity", 100)), true, nil
	case "setLayerBlendMode":
		s, err := setLayerBlendMode(strParam(params, "blendMode", "NORMAL"))
		return s, true, err
	case "setLayerVisibility":
		return setLayerVisibility(boolParam(params, "visible", true)), true, nil
	case "setLayerLocked":
		return setLayerLocked(boolParam(params, "locked", false)), true, nil
	case "renameLayer":
		return renameLayer(strParam(params, "newName", "")), true, nil
	case "selectLayer":
		return selectLayer(strParam(params, "name", "")), true, nil
	case "rasterizeLayer":
		return rasterizeLayer(), true, nil
	case "addLayerStyle":
		cr, cg, cb := colorParam(params, "color")
		return addLayerStyle(
			strParam(params, "styleType", ""),
			cr, cg, cb,
			numParam(params, "opacity", 50),
			numParam(params, "angle", 90),
			numParam(params, "distance", 8),
			numParam(params, "spread", 0),
			numParam(params, "size", 12),
			numParam(params, "stroke_size", 3),
			strParam(params, "stroke_position", "outside"),
			numParam(params, "glow_size", 12),
			numParam(params, "glow_spread", 0),
		), true, nil
	}
	return "", false, nil
}
