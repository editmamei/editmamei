package main

// buildMetadata handles the metadata.go emitter family (ping state, layer
// tree, document/IPTC/EXIF metadata, histogram, history-state preview
// render). Extracted verbatim from build()'s switch (Tier-3 S2 part 2
// registry split); dispatch behavior is unchanged. handled=false means "not
// my family".
func buildMetadata(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "pingState":
		return pingState(), true, nil
	case "getLayerTree":
		return getLayerTree(), true, nil
	case "getMetadata":
		return getMetadata(
			boolParam(params, "document", true),
			boolParam(params, "iptc", true),
			boolParam(params, "dom_exif", true),
		), true, nil
	case "getHistogram":
		return getHistogram(strParam(params, "channel", "")), true, nil
	case "renderHistoryStatePreview":
		return renderHistoryStatePreview(
			numParam(params, "historyIndex", 0),
			numParam(params, "maxDimension", 1500),
			numParam(params, "quality", 8),
			strParam(params, "outputPath", ""),
		), true, nil
	}
	return "", false, nil
}
