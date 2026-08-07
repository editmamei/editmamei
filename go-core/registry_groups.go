package main

// buildGroups handles the groups.go emitter family (group/ungroup, clipping
// mask, move-to-group, group blend mode). Extracted verbatim from build()'s
// switch (Tier-3 S2 part 2 registry split); dispatch behavior is unchanged.
// handled=false means "not my family".
func buildGroups(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "deleteGroup":
		return deleteGroup(strParam(params, "name", "")), true, nil
	case "createClippingMask":
		return createClippingMask(), true, nil
	case "releaseClippingMask":
		return releaseClippingMask(), true, nil
	case "createGroup":
		return createGroup(
			strParam(params, "name", ""),
			strSliceParam(params, "layerNames"),
			boolParam(params, "into_active_group", false),
		), true, nil
	case "moveLayerToGroup":
		return moveLayerToGroup(
			strParam(params, "layerName", ""),
			strParam(params, "groupName", ""),
		), true, nil
	case "setGroupBlendMode":
		return setGroupBlendMode(
			strParam(params, "groupName", ""),
			strParam(params, "blendMode", ""),
		), true, nil
	case "ungroup":
		return ungroup(strParam(params, "groupName", "")), true, nil
	}
	return "", false, nil
}
