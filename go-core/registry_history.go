package main

// buildHistory handles the history.go emitter family (undo/redo, history
// states). Extracted verbatim from build()'s switch (Tier-3 S2 part 2
// registry split); dispatch behavior is unchanged. handled=false means "not
// my family".
func buildHistory(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "undo":
		return undo(numParam(params, "steps", 1)), true, nil
	case "redo":
		return redo(numParam(params, "steps", 1)), true, nil
	case "getHistoryStates":
		return getHistoryStates(), true, nil
	}
	return "", false, nil
}
