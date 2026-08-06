package main

import "fmt"

// buildPaths handles the paths.go emitter family (path-interchange
// primitives: create-from-selection/points, save/list/delete, load-as-
// selection, stroke/fill, clipping path). Extracted verbatim from build()'s
// switch (Tier-3 S2 part 2 registry split); dispatch behavior is unchanged.
// handled=false means "not my family".
func buildPaths(name string, params map[string]any) (string, bool, error) {
	switch name {
	// ---- path-interchange family (dev-tier; primitive B) ------------------
	case "createPathFromSelection":
		return createPathFromSelection(numParam(params, "tolerance", 2.0)), true, nil
	case "savePath":
		name := strParam(params, "name", "")
		if name == "" {
			return "", true, fmt.Errorf("savePath: missing required field 'name'")
		}
		return savePath(name), true, nil
	case "listPaths":
		return listPaths(), true, nil
	case "deletePath":
		name, hasName := optStrParam(params, "name")
		return deletePath(name, hasName), true, nil
	case "loadPathAsSelection":
		name, hasName := optStrParam(params, "name")
		return loadPathAsSelection(
			name, hasName,
			numParam(params, "feather", 0),
			boolParam(params, "antiAlias", true),
			strParam(params, "operation", "replace"),
		), true, nil
	case "strokePath":
		tool := strParam(params, "tool", "brush")
		if _, ok := brushToolConstMap[tool]; !ok {
			return "", true, fmt.Errorf("strokePath: unsupported tool %q", tool)
		}
		name, hasName := optStrParam(params, "name")
		return strokePath(name, hasName, tool, boolParam(params, "applyToActiveLayer", false)), true, nil
	case "fillPath":
		name, hasName := optStrParam(params, "name")
		return fillPath(
			name, hasName,
			numParam(params, "red", 0),
			numParam(params, "green", 0),
			numParam(params, "blue", 0),
			numParam(params, "opacity", 100),
			strParam(params, "mode", "normal"),
			numParam(params, "feather", 0),
			boolParam(params, "antiAlias", true),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "setClippingPath":
		name := strParam(params, "name", "")
		if name == "" {
			return "", true, fmt.Errorf("setClippingPath: missing required field 'name'")
		}
		flat, hasFlat := optNumParam(params, "flatness")
		return setClippingPath(name, flat, hasFlat), true, nil
	case "createPathFromPoints":
		name := strParam(params, "name", "")
		if name == "" {
			return "", true, fmt.Errorf("createPathFromPoints: missing required field 'name'")
		}
		pts := pointsParam(params, "points")
		if len(pts) < 2 {
			return "", true, fmt.Errorf("createPathFromPoints: need at least 2 points")
		}
		return createPathFromPoints(name, pts, boolParam(params, "closed", false)), true, nil
	}
	return "", false, nil
}
