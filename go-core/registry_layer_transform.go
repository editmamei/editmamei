package main

import "fmt"

// buildLayerTransform handles the layer_transform.go emitter family
// (move-to-position, fit-to-document, scale/flip/rotate/move, matrix
// transform, warp/warp-mesh). Extracted verbatim from build()'s switch
// (Tier-3 S2 part 2 registry split); dispatch behavior is unchanged.
// handled=false means "not my family".
func buildLayerTransform(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "moveLayerToPosition":
		targetName, hasTarget := optStrParam(params, "targetLayerName")
		moveName, hasMove := optStrParam(params, "layerToMoveName")
		return moveLayerToPosition(
			targetName, hasTarget,
			strParam(params, "position", ""),
			moveName, hasMove,
		), true, nil
	case "fitLayerToDocument":
		return fitLayerToDocument(boolParam(params, "fillDocument", false)), true, nil
	case "scaleLayer":
		if _, ok := params["scaleXPercent"]; ok {
			return scaleLayerXY(
				numParam(params, "scaleXPercent", 100),
				numParam(params, "scaleYPercent", 100),
				boolParam(params, "centerAnchor", true),
			), true, nil
		}
		return scaleLayer(
			numParam(params, "scalePercent", 100),
			boolParam(params, "centerAnchor", true),
		), true, nil
	case "flipLayer":
		axis := strParam(params, "axis", "")
		if _, ok := flipAxisMap[axis]; !ok {
			return "", true, fmt.Errorf("flipLayer: unknown axis %q", axis)
		}
		return flipLayer(axis), true, nil
	case "rotateLayer":
		return rotateLayer(numParam(params, "degrees", 0)), true, nil
	case "moveLayer":
		return moveLayer(
			numParam(params, "deltaX", 0),
			numParam(params, "deltaY", 0),
			strParam(params, "mode", "delta"),
			numParam(params, "absoluteX", 0),
			numParam(params, "absoluteY", 0),
			numParam(params, "centerOnX", 0),
			numParam(params, "centerOnY", 0),
		), true, nil
	// ---- M2 transform / warp / canvas / guides (dev-tier) ------------------
	case "transformLayerMatrix":
		mode := strParam(params, "mode", "")
		if mode != "skew" && mode != "free" {
			return "", true, fmt.Errorf("transformLayerMatrix: unknown mode %q", mode)
		}
		return transformLayerMatrix(
			mode,
			numParam(params, "scaleXPercent", 100),
			numParam(params, "scaleYPercent", 100),
			numParam(params, "skewH", 0),
			numParam(params, "skewV", 0),
			numParam(params, "rotateDegrees", 0),
			numParam(params, "offsetX", 0),
			numParam(params, "offsetY", 0),
		), true, nil
	case "warpLayer":
		style := strParam(params, "style", "")
		if !warpStyleMap[style] {
			return "", true, fmt.Errorf("warpLayer: unknown style %q", style)
		}
		orientation := strParam(params, "orientation", "horizontal")
		if _, ok := warpRotateMap[orientation]; !ok {
			return "", true, fmt.Errorf("warpLayer: unknown orientation %q", orientation)
		}
		return warpLayer(
			style,
			numParam(params, "bend", 0),
			numParam(params, "hDistort", 0),
			numParam(params, "vDistort", 0),
			orientation,
		), true, nil
	case "warpMesh":
		pin := strParam(params, "pinEdge", "")
		if !warpPinEdgeMap[pin] {
			return "", true, fmt.Errorf("warpMesh: unknown pin_edge %q", pin)
		}
		ncx := int(numParam(params, "ncx", 6))
		ncy := int(numParam(params, "ncy", 2))
		if ncx < 1 || ncy < 1 {
			return "", true, fmt.Errorf("warpMesh: ncx/ncy must be >= 1 (got %d, %d)", ncx, ncy)
		}
		rawJS := ""
		if raw := pointsParam(params, "meshPoints"); len(raw) > 0 {
			need := (3*ncx + 1) * (3*ncy + 1)
			if len(raw) != need {
				return "", true, fmt.Errorf("warpMesh: mesh_points has %d points, need %d for %dx%d cells", len(raw), need, ncx, ncy)
			}
			rawJS = meshPointsLiteral(raw)
		}
		return warpMesh(
			pin, ncx, ncy,
			numParam(params, "lift", 0),
			numParam(params, "bendAt", 0.6),
			numParam(params, "sharpness", 0.5),
			numParam(params, "taper", 1),
			rawJS,
		), true, nil
	}
	return "", false, nil
}
