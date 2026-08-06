package main

// buildText handles the text.go emitter family (create text layer, font,
// color, alignment, content update). Extracted verbatim from build()'s
// switch (Tier-3 S2 part 2 registry split); dispatch behavior is unchanged.
// handled=false means "not my family".
func buildText(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "createTextLayer":
		return createTextLayer(
			strParam(params, "text", ""),
			numParam(params, "x", 100),
			numParam(params, "y", 100),
			numParam(params, "fontSize", 24),
		), true, nil
	case "setTextFont":
		fontSize, hasFontSize := optNumParam(params, "fontSize")
		return setTextFont(strParam(params, "fontName", ""), fontSize, hasFontSize), true, nil
	case "setTextColor":
		return setTextColor(
			numParam(params, "red", 0),
			numParam(params, "green", 0),
			numParam(params, "blue", 0),
		), true, nil
	case "setTextAlignment":
		s, err := setTextAlignment(strParam(params, "alignment", ""))
		return s, true, err
	case "updateTextContent":
		return updateTextContent(strParam(params, "newText", "")), true, nil
	}
	return "", false, nil
}
