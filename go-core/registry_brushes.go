package main

// buildBrushes handles the brushes.go emitter family (brush stroke
// application). Extracted verbatim from build()'s switch (Tier-3 S2 part 2
// registry split); dispatch behavior is unchanged. handled=false means "not
// my family".
func buildBrushes(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "applyBrushStroke":
		s, err := applyBrushStroke(params)
		return s, true, err
	}
	return "", false, nil
}
