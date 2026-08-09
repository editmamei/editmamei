package main

import "fmt"

// buildFilters handles the filters.go emitter family (Filter menu snippets:
// blur/sharpen/noise/distort/pixelate/stylize/render/other/denoise/blur-adv).
// Extracted verbatim from build()'s switch (Tier-3 S2 part 2 registry split);
// dispatch behavior is unchanged. handled=false means "not my family".
func buildFilters(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "applyGaussianBlur":
		return applyGaussianBlur(
			numParam(params, "radius", 0),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyUnsharpMask":
		return applyUnsharpMask(
			numParam(params, "amount", 0),
			numParam(params, "radius", 0),
			numParam(params, "threshold", 0),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyAddNoise":
		dist := strParam(params, "distribution", "GAUSSIAN")
		if !noiseDistributionSet[dist] {
			return "", true, fmt.Errorf("applyAddNoise: unsupported distribution %q", dist)
		}
		return applyAddNoise(
			numParam(params, "amount", 0),
			dist,
			boolParam(params, "monochromatic", false),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyMotionBlur":
		return applyMotionBlur(
			numParam(params, "angle", 0),
			numParam(params, "radius", 0),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyLensBlur":
		shape := strParam(params, "irisShape", "")
		if _, ok := lensIrisMap[shape]; !ok {
			return "", true, fmt.Errorf("applyLensBlur: unknown iris_shape %q", shape)
		}
		return applyLensBlur(
			numParam(params, "radius", 15),
			shape,
			numParam(params, "irisBladeCurvature", 0),
			numParam(params, "irisRotation", 0),
			numParam(params, "specularBrightness", 0),
			numParam(params, "specularThreshold", 255),
			numParam(params, "noiseAmount", 0),
			strParam(params, "noiseDistribution", "uniform"),
			boolParam(params, "noiseMonochromatic", false),
			strParam(params, "depthSource", "none"),
			numParam(params, "focalDistance", 0),
			boolParam(params, "invertDepth", false),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applySmartSharpen":
		return applySmartSharpen(
			numParam(params, "amount", 100),
			numParam(params, "radius", 1.5),
			numParam(params, "noiseReduction", 10),
			strParam(params, "removeMode", "gaussianBlur"),
			numParam(params, "motionAngle", 0),
			numParam(params, "shadowFade", 0),
			numParam(params, "shadowTonalWidth", 50),
			numParam(params, "shadowRadius", 30),
			numParam(params, "highlightFade", 0),
			numParam(params, "highlightTonalWidth", 50),
			numParam(params, "highlightRadius", 30),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyReduceNoise":
		return applyReduceNoise(
			numParam(params, "strength", 5),
			numParam(params, "preserveDetails", 50),
			numParam(params, "colorNoise", 45),
			numParam(params, "sharpenDetails", 25),
			boolParam(params, "removeJpegArtifact", false),
			boolParam(params, "perChannel", false),
			numParam(params, "redStrength", 5),
			numParam(params, "redPreserveDetails", 50),
			numParam(params, "greenStrength", 5),
			numParam(params, "greenPreserveDetails", 50),
			numParam(params, "blueStrength", 5),
			numParam(params, "bluePreserveDetails", 50),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyHighPass":
		return applyHighPass(
			numParam(params, "radius", 10),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyDisplace":
		dm := strParam(params, "displacementMap", "stretch_to_fit")
		if _, ok := displaceMapMap[dm]; !ok {
			return "", true, fmt.Errorf("applyDisplace: unknown displacement_map %q", dm)
		}
		ua := strParam(params, "undefinedAreas", "repeat_edge")
		if _, ok := displaceUndefMap[ua]; !ok {
			return "", true, fmt.Errorf("applyDisplace: unknown undefined_areas %q", ua)
		}
		mp := strParam(params, "mapPath", "")
		if mp == "" {
			return "", true, fmt.Errorf("applyDisplace: map_path is required")
		}
		return applyDisplace(
			numParam(params, "horizontalScale", 10),
			numParam(params, "verticalScale", 10),
			dm, ua, mp,
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyOilPaint":
		return applyOilPaint(
			numParam(params, "stylization", 4),
			numParam(params, "cleanliness", 2.3),
			numParam(params, "brushScale", 0.8),
			numParam(params, "bristleDetail", 10),
			numParam(params, "lightDirection", -60),
			numParam(params, "shine", 1.3),
			boolParam(params, "lightingOn", true),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyDistort":
		mode := strParam(params, "mode", "")
		switch mode {
		case "twirl":
		case "pinch", "spherize", "zigzag": // later additions (hardcoded enum defaults)
		case "polar":
			if _, ok := polarConvMap[strParam(params, "conversion", "rect_to_polar")]; !ok {
				return "", true, fmt.Errorf("applyDistort: unknown conversion")
			}
		case "ripple":
			if _, ok := rippleSizeMap[strParam(params, "size", "medium")]; !ok {
				return "", true, fmt.Errorf("applyDistort: unknown ripple size")
			}
		case "wave":
			if _, ok := waveTypeMap[strParam(params, "waveType", "sine")]; !ok {
				return "", true, fmt.Errorf("applyDistort: unknown waveType")
			}
			if _, ok := waveUndefMap[strParam(params, "undefinedAreas", "repeat_edge")]; !ok {
				return "", true, fmt.Errorf("applyDistort: unknown undefinedAreas")
			}
		default:
			return "", true, fmt.Errorf("applyDistort: unknown mode %q", mode)
		}
		return applyDistort(mode, params, boolParam(params, "applyToActiveLayer", false)), true, nil
	case "applyPixelate":
		mode := strParam(params, "mode", "color_halftone")
		switch mode {
		case "color_halftone", "mosaic", "crystallize", "pointillize", "facet", "fragment":
		default:
			return "", true, fmt.Errorf("applyPixelate: unknown mode %q", mode)
		}
		return applyPixelate(
			mode,
			numParam(params, "maxRadius", 8),
			numParam(params, "angle1", 108),
			numParam(params, "angle2", 162),
			numParam(params, "angle3", 90),
			numParam(params, "angle4", 45),
			numParam(params, "cellSize", 10),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	case "applyStylize":
		mode := strParam(params, "mode", "")
		switch mode {
		case "emboss", "find_edges", "solarize", "tiles":
		case "wind":
			if _, ok := windMethodMap[strParam(params, "method", "wind")]; !ok {
				return "", true, fmt.Errorf("applyStylize: unknown wind method")
			}
			if _, ok := windDirMap[strParam(params, "direction", "left")]; !ok {
				return "", true, fmt.Errorf("applyStylize: unknown wind direction")
			}
		case "trace_contour":
			if _, ok := traceEdgeMap[strParam(params, "edge", "lower")]; !ok {
				return "", true, fmt.Errorf("applyStylize: unknown trace_contour edge")
			}
		default:
			return "", true, fmt.Errorf("applyStylize: unknown mode %q", mode)
		}
		return applyStylize(mode, params, boolParam(params, "applyToActiveLayer", false)), true, nil
	case "applyRender":
		mode := strParam(params, "mode", "")
		switch mode {
		case "clouds", "difference_clouds", "fibers":
		default:
			return "", true, fmt.Errorf("applyRender: unknown mode %q", mode)
		}
		return applyRender(mode, params, boolParam(params, "applyToActiveLayer", false)), true, nil
	case "applyOther":
		mode := strParam(params, "mode", "")
		switch mode {
		case "offset":
		case "maximum", "minimum":
			pv := strParam(params, "preserve", "roundness")
			if pv != "roundness" && pv != "squareness" {
				return "", true, fmt.Errorf("applyOther: unknown preserve %q", pv)
			}
		default:
			return "", true, fmt.Errorf("applyOther: unknown mode %q", mode)
		}
		return applyOther(mode, params, boolParam(params, "applyToActiveLayer", false)), true, nil
	case "applyDenoise":
		mode := strParam(params, "mode", "")
		switch mode {
		case "median", "dust_and_scratches", "despeckle":
		default:
			return "", true, fmt.Errorf("applyDenoise: unknown mode %q", mode)
		}
		return applyDenoise(mode, params, boolParam(params, "applyToActiveLayer", false)), true, nil
	case "applyBlurAdv":
		mode := strParam(params, "mode", "")
		switch mode {
		case "surface_blur", "box_blur", "average":
		default:
			return "", true, fmt.Errorf("applyBlurAdv: unknown mode %q", mode)
		}
		return applyBlurAdv(mode, params, boolParam(params, "applyToActiveLayer", false)), true, nil
	case "applyRadialBlur":
		method := strParam(params, "method", "spin")
		if _, ok := radialMethodMap[method]; !ok {
			return "", true, fmt.Errorf("applyRadialBlur: unknown method %q", method)
		}
		quality := strParam(params, "quality", "good")
		if _, ok := radialQualityMap[quality]; !ok {
			return "", true, fmt.Errorf("applyRadialBlur: unknown quality %q", quality)
		}
		return applyRadialBlur(
			numParam(params, "amount", 10),
			method,
			quality,
			numParam(params, "centerX", 0.5),
			numParam(params, "centerY", 0.5),
			boolParam(params, "applyToActiveLayer", false),
		), true, nil
	}
	return "", false, nil
}
