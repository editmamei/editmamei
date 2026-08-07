package main

import "fmt"

// buildDocuments handles the documents.go emitter family (new/place/close
// document, resize/crop, mode conversion, open/probe pipeline, save/export).
// Extracted verbatim from build()'s switch (Tier-3 S2 part 2 registry split);
// dispatch behavior is unchanged. handled=false means "not my family".
func buildDocuments(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "newDocument":
		colorMode := strParam(params, "colorMode", "NewDocumentMode.RGB")
		if !newDocumentModeSet[colorMode] {
			return "", true, fmt.Errorf("newDocument: unsupported colorMode %q", colorMode)
		}
		return newDocument(
			numParam(params, "width", 0),
			numParam(params, "height", 0),
			numParam(params, "resolution", 72),
			colorMode,
		), true, nil
	case "placeImage":
		wp, hasW := optNumParam(params, "widthPercent")
		hp, hasH := optNumParam(params, "heightPercent")
		return placeImage(
			strParam(params, "filePath", ""),
			numParam(params, "x", 0),
			numParam(params, "y", 0),
			wp, hp, hasW, hasH,
		), true, nil
	case "closeDocument":
		return closeDocument(boolParam(params, "save", false)), true, nil
	case "resizeImage":
		return resizeImage(numParam(params, "width", 0), numParam(params, "height", 0)), true, nil
	case "convertImageMode":
		mode := strParam(params, "mode", "")
		if mode == "bitmap" {
			shape := strParam(params, "shape", "round")
			if _, ok := halftoneShapeMap[shape]; !ok {
				return "", true, fmt.Errorf("convertImageMode: unknown halftone shape %q", shape)
			}
			return convertImageModeBitmap(
				numParam(params, "frequency", 53),
				numParam(params, "angle", 45),
				shape,
			), true, nil
		}
		if _, ok := convertModeMap[mode]; !ok {
			return "", true, fmt.Errorf("convertImageMode: unknown mode %q", mode)
		}
		return convertImageMode(mode), true, nil
	case "cropDocument":
		return cropDocument(
			numParam(params, "left", 0),
			numParam(params, "top", 0),
			numParam(params, "right", 0),
			numParam(params, "bottom", 0),
		), true, nil
	case "openDocumentPipeline":
		return openDocumentPipeline(
			strParam(params, "filePath", ""),
			boolParam(params, "suppressDialogs", true),
		), true, nil
	case "probeOpenDocument":
		return probeOpenDocument(strParam(params, "filePath", "")), true, nil
	case "savePsdAsCopy":
		return savePsdAsCopy(
			strParam(params, "outputPath", ""),
			boolParam(params, "maximizeCompat", true),
		), true, nil
	case "exportJpegPipeline":
		le, hasLE := optNumParam(params, "longEdgePx")
		return exportJpegPipeline(
			strParam(params, "outputPath", ""),
			numParam(params, "quality", 11),
			le, hasLE,
			boolParam(params, "embedProfile", true),
			boolParam(params, "convertSrgb", true),
		), true, nil
	case "exportPngPipeline":
		le, hasLE := optNumParam(params, "longEdgePx")
		return exportPngPipeline(
			strParam(params, "outputPath", ""),
			boolParam(params, "transparentBg", false),
			le, hasLE,
			numParam(params, "compression", 6),
		), true, nil
	}
	return "", false, nil
}
