package main

import "fmt"

// buildMasks handles the masks.go + vector_masks.go emitter family (pixel
// layer mask create/delete/apply, vector mask create/delete/link/enable).
// Extracted verbatim from build()'s switch (Tier-3 S2 part 2 registry
// split); dispatch behavior is unchanged. handled=false means "not my
// family".
func buildMasks(name string, params map[string]any) (string, bool, error) {
	switch name {
	case "createLayerMask":
		return createLayerMask(), true, nil
	case "deleteLayerMask":
		return deleteLayerMask(), true, nil
	case "applyLayerMask":
		return applyLayerMask(), true, nil
	case "maskGradient":
		s, err := maskGradient(params)
		return s, true, err
	// ---- vector-mask family (dev-tier; canonical AM, UNVERIFIED) -----------
	case "addVectorMask":
		src := strParam(params, "source", "from_current_path")
		// from_current_path (2026-06-24) + reveal_all/hide_all (m4a STEP-23/24
		// capture, 2026-06-29) are all live-verified.
		if src != "from_current_path" {
			if _, ok := vmFillMap[src]; !ok {
				return "", true, fmt.Errorf(
					"addVectorMask: source %q not supported (use from_current_path, reveal_all, or hide_all)", src,
				)
			}
		}
		return addVectorMask(src), true, nil
	case "deleteVectorMask":
		return deleteVectorMask(), true, nil
	case "setVectorMaskLink":
		return setVectorMaskLink(boolParam(params, "linked", true)), true, nil
	case "setVectorMaskEnabled":
		return setVectorMaskEnabled(boolParam(params, "enabled", true)), true, nil
	}
	return "", false, nil
}
