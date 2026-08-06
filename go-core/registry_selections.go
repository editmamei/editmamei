package main

import "fmt"

// buildSelections handles the selections.go + channel_compose.go emitter
// family (marquee/lasso-equivalent selection primitives, Sensei subject/sky,
// color/luminance range, channel save/load, apply-image/calculations).
// Extracted verbatim from build()'s switch (Tier-3 S2 part 2 registry split);
// dispatch behavior is unchanged. handled=false means "not my family".
func buildSelections(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "selectRectangle":
		return selectRectangle(
			numParam(params, "left", 0),
			numParam(params, "top", 0),
			numParam(params, "right", 0),
			numParam(params, "bottom", 0),
			numParam(params, "featherPx", 0),
			strParam(params, "selectionType", "replace"),
		), true, nil
	case "featherSelection":
		return featherSelection(numParam(params, "radiusPx", 0)), true, nil
	case "selectEllipse":
		return selectEllipse(
			numParam(params, "left", 0),
			numParam(params, "top", 0),
			numParam(params, "right", 0),
			numParam(params, "bottom", 0),
			numParam(params, "featherPx", 0),
			boolParam(params, "antiAlias", true),
			strParam(params, "selectionType", "replace"),
		), true, nil
	case "modifySelectionEdge":
		mode := strParam(params, "mode", "")
		if mode != "expand" && mode != "contract" && mode != "border" && mode != "smooth" {
			return "", true, fmt.Errorf("modifySelectionEdge: unknown mode %q", mode)
		}
		return modifySelectionEdge(
			mode,
			numParam(params, "amount", 0),
			boolParam(params, "atCanvasBounds", false),
		), true, nil
	case "growSelection":
		mode := strParam(params, "mode", "grow")
		if mode != "grow" && mode != "similar" {
			return "", true, fmt.Errorf("growSelection: unknown mode %q", mode)
		}
		return growSelection(
			mode,
			numParam(params, "tolerance", 32),
			boolParam(params, "antiAlias", true),
		), true, nil
	case "transformSelection":
		return transformSelection(
			numParam(params, "scaleXPercent", 100),
			numParam(params, "scaleYPercent", 100),
			numParam(params, "rotateDegrees", 0),
			numParam(params, "offsetX", 0),
			numParam(params, "offsetY", 0),
		), true, nil
	case "selectAll":
		return selectAll(), true, nil
	case "deselect":
		return deselect(), true, nil
	case "invertSelection":
		return invertSelection(), true, nil
	case "getSelectionState":
		return getSelectionState(), true, nil
	case "selectSubject":
		return selectSubject(
			boolParam(params, "sampleAllLayers", true),
			strParam(params, "selectionType", "replace"),
		), true, nil
	case "selectSky":
		return selectSky(
			boolParam(params, "sampleAllLayers", true),
			strParam(params, "selectionType", "replace"),
		), true, nil
	case "selectColorRange":
		return selectColorRange(
			numParam(params, "red", 0),
			numParam(params, "green", 0),
			numParam(params, "blue", 0),
			numParam(params, "fuzziness", 40),
			strParam(params, "selectionType", "replace"),
		), true, nil
	case "selectColorPreset":
		preset := strParam(params, "preset", "")
		if preset != "skin_tones" && preset != "out_of_gamut" {
			return "", true, fmt.Errorf("selectColorPreset: unknown preset %q", preset)
		}
		return selectColorPreset(
			preset,
			numParam(params, "fuzziness", 40),
			boolParam(params, "useFaces", false),
			strParam(params, "selectionType", "replace"),
		), true, nil
	case "selectPolygon":
		pts := pointsParam(params, "points")
		if len(pts) < 3 {
			return "", true, fmt.Errorf("selectPolygon: need at least 3 points, got %d", len(pts))
		}
		return selectPolygon(
			pts,
			boolParam(params, "antiAlias", true),
			strParam(params, "selectionType", "replace"),
		), true, nil
	case "selectLuminanceRange":
		mode := strParam(params, "mode", "")
		if mode != "highlights" && mode != "shadows" && mode != "midtones" {
			return "", true, fmt.Errorf("selectLuminanceRange: unknown mode %q", mode)
		}
		// Mode-specific limit defaults (sentinel -1 = caller omitted it).
		lower := numParam(params, "lowerLimit", -1)
		if lower < 0 {
			if mode == "midtones" {
				lower = 105
			} else {
				lower = 190
			}
		}
		upper := numParam(params, "upperLimit", -1)
		if upper < 0 {
			if mode == "midtones" {
				upper = 150
			} else {
				upper = 65
			}
		}
		return selectLuminanceRange(
			mode,
			numParam(params, "fuzziness", 40),
			lower,
			upper,
			strParam(params, "selectionType", "replace"),
		), true, nil
	case "refineEdge":
		return refineEdge(
			numParam(params, "radius", 0),
			numParam(params, "smooth", 0),
			numParam(params, "feather", 0),
			numParam(params, "contrast", 0),
			numParam(params, "shiftEdge", 0),
			boolParam(params, "decontaminate", false),
		), true, nil
	case "magicWand":
		return magicWand(
			numParam(params, "x", 0),
			numParam(params, "y", 0),
			numParam(params, "tolerance", 32),
			boolParam(params, "contiguous", true),
			boolParam(params, "antiAlias", true),
			boolParam(params, "sampleAllLayers", false),
			strParam(params, "selectionType", "replace"),
		), true, nil
	case "getSelectionPreview":
		return getSelectionPreview(
			strParam(params, "overlayPath", ""),
			strParam(params, "maskPath", ""),
			numParam(params, "maxDim", 800),
		), true, nil
	case "saveSelectionToChannel":
		return saveSelectionToChannel(strParam(params, "channelName", "")), true, nil
	case "loadSelectionFromChannel":
		return loadSelectionFromChannel(
			strParam(params, "channelName", ""),
			strParam(params, "operation", "replace"),
		), true, nil
	case "duplicateChannel":
		newName, hasNewName := params["newName"].(string)
		return duplicateChannel(strParam(params, "channelName", ""), newName, hasNewName && newName != ""), true, nil
	case "deleteChannel":
		return deleteChannel(strParam(params, "channelName", "")), true, nil
	case "applyImage":
		blend, ok := clcnBlendMap[strParam(params, "blend", "")]
		if !ok {
			return "", true, fmt.Errorf("applyImage: unsupported blend %q", strParam(params, "blend", ""))
		}
		chanID, alphaName, err := resolveSrcChannel(
			strParam(params, "sourceChannel", "rgb"),
			strParam(params, "sourceAlphaName", ""),
			true,
		)
		if err != nil {
			return "", true, fmt.Errorf("applyImage: %w", err)
		}
		return applyImage(
			chanID, alphaName, resolveSrcLayer(strParam(params, "sourceLayer", "merged")),
			blend, numParam(params, "opacity", 100), boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "calculations":
		blend, ok := clcnBlendMap[strParam(params, "blend", "")]
		if !ok {
			return "", true, fmt.Errorf("calculations: unsupported blend %q", strParam(params, "blend", ""))
		}
		s1c, s1a, err := resolveSrcChannel(
			strParam(params, "source1Channel", "red"),
			strParam(params, "source1AlphaName", ""),
			false,
		)
		if err != nil {
			return "", true, fmt.Errorf("calculations source1: %w", err)
		}
		s2c, s2a, err := resolveSrcChannel(
			strParam(params, "source2Channel", "red"),
			strParam(params, "source2AlphaName", ""),
			false,
		)
		if err != nil {
			return "", true, fmt.Errorf("calculations source2: %w", err)
		}
		return calculations(
			s1c, s1a, resolveSrcLayer(strParam(params, "source1Layer", "merged")),
			s2c, s2a, resolveSrcLayer(strParam(params, "source2Layer", "merged")),
			blend, numParam(params, "opacity", 100),
		), true, nil
	}
	return "", false, nil
}
