package main

// buildLayers handles the layers.go emitter family (new/delete/duplicate
// layer, fill, merge/stamp/flatten, smart-object conversion, layer-via-copy,
// bake, add-fill-layer). Extracted verbatim from build()'s switch (Tier-3 S2
// part 2 registry split); dispatch behavior is unchanged. handled=false
// means "not my family".
func buildLayers(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "newLayer":
		name, hasName := optStrParam(params, "name")
		return newLayer(name, hasName), true, nil
	case "deleteLayer":
		name, hasName := optStrParam(params, "name")
		return deleteLayer(name, hasName), true, nil
	case "fillLayer":
		return fillLayer(
			numParam(params, "red", 0),
			numParam(params, "green", 0),
			numParam(params, "blue", 0),
		), true, nil
	case "duplicateLayer":
		newName, hasNewName := optStrParam(params, "newName")
		return duplicateLayer(newName, hasNewName), true, nil
	case "mergeVisibleLayers":
		return mergeVisibleLayers(), true, nil
	case "stampVisible":
		return stampVisible(), true, nil
	case "flattenImage":
		return flattenImage(), true, nil
	case "convertToSmartObject":
		return convertToSmartObject(), true, nil
	case "newSmartObjectViaCopy":
		return newSmartObjectViaCopy(), true, nil
	case "layerViaCopy":
		return layerViaCopy(boolParam(params, "into_active_group", false)), true, nil
	case "bakeLayer":
		return bakeLayer(), true, nil
	case "addFillLayer":
		return addFillLayer(
			numParam(params, "red", 0),
			numParam(params, "green", 0),
			numParam(params, "blue", 0),
			boolParam(params, "into_active_group", false),
		), true, nil
	case "addGradientFillLayer":
		s, err := addGradientFillLayer(params)
		return s, true, err
	}
	return "", false, nil
}
