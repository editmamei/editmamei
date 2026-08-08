package main

// buildSmartObject handles the smart_object.go emitter family — the Smart-Object
// filter stack (list / visibility / blend / remove) plus the Smart-Object read.
// handled=false means "not my family".
//
// JSON numbers arrive as float64, so the 1-based filter index is narrowed here;
// the tool layer constrains it to an integer >= 1 and the snippet range-checks it
// against the real filter count.
func buildSmartObject(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "listSmartFilters":
		return listSmartFilters(), true, nil
	case "setSmartFilterVisibility":
		return setSmartFilterVisibility(
			int(numParam(params, "index", 1)),
			boolParam(params, "enabled", true),
		), true, nil
	case "setSmartFilterBlend":
		opacity, hasOpacity := optNumParam(params, "opacity")
		mode, hasMode := optStrParam(params, "blendMode")
		s, err := setSmartFilterBlend(
			int(numParam(params, "index", 1)), opacity, hasOpacity, mode, hasMode,
		)
		return s, true, err
	case "removeSmartFilter":
		return removeSmartFilter(int(numParam(params, "index", 1))), true, nil
	case "getSmartObjectInfo":
		return getSmartObjectInfo(), true, nil
	}
	return "", false, nil
}
