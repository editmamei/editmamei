package main

import "fmt"

// buildShapes handles the shapes.go emitter family (vector shape/line
// creation). Extracted verbatim from build()'s switch (Tier-3 S2 part 2
// registry split); dispatch behavior is unchanged. handled=false means "not
// my family".
func buildShapes(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "createShape":
		st := strParam(params, "shapeType", "")
		if st != "rectangle" && st != "ellipse" && st != "line" {
			return "", true, fmt.Errorf("createShape: unsupported shapeType %q (use rectangle/ellipse/line)", st)
		}
		return createShape(
			st,
			numParam(params, "top", 0), numParam(params, "left", 0),
			numParam(params, "bottom", 0), numParam(params, "right", 0),
			numParam(params, "cornerRadius", 0),
			numParam(params, "startX", 0), numParam(params, "startY", 0),
			numParam(params, "endX", 0), numParam(params, "endY", 0),
			numParam(params, "weight", 4),
			numParam(params, "fillR", 0), numParam(params, "fillG", 0), numParam(params, "fillB", 0),
			numParam(params, "strokeWidth", 0),
			numParam(params, "strokeR", 0), numParam(params, "strokeG", 0), numParam(params, "strokeB", 0),
			boolParam(params, "into_active_group", false),
		), true, nil
	}
	return "", false, nil
}
