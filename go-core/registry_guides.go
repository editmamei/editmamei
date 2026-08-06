package main

import "fmt"

// buildGuides handles the guides.go emitter family (canvas rotate/flip,
// guide add/layout/clear). Extracted verbatim from build()'s switch (Tier-3
// S2 part 2 registry split); dispatch behavior is unchanged. handled=false
// means "not my family".
func buildGuides(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "rotateCanvas":
		return rotateCanvas(numParam(params, "degrees", 0)), true, nil
	case "flipCanvas":
		orientation := strParam(params, "orientation", "")
		if _, ok := canvasFlipMap[orientation]; !ok {
			return "", true, fmt.Errorf("flipCanvas: unknown orientation %q", orientation)
		}
		return flipCanvas(orientation), true, nil
	case "addGuide":
		orientation := strParam(params, "orientation", "")
		if _, ok := guideDirectionMap[orientation]; !ok {
			return "", true, fmt.Errorf("addGuide: unknown orientation %q", orientation)
		}
		return addGuide(orientation, numParam(params, "position", 0)), true, nil
	case "addGuideLayout":
		return addGuideLayout(
			numParam(params, "columns", 0),
			numParam(params, "rows", 0),
		), true, nil
	case "clearGuides":
		return clearGuides(), true, nil
	}
	return "", false, nil
}
