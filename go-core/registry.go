package main

import "fmt"

// build dispatches a snippet name + params map to its Go builder, returning the
// inner JSX body (the TS wrapper in photoshop-api.ts still wraps it). This is
// the single seam the TS SnippetClient calls into.
//
// The dispatch is split into per-family buildX functions (registry_<family>.go,
// Tier-3 S2 part 2) — each returns (jsx, handled, err); handled=false means
// "not my family", so build() tries the next one in order. Pro-tier snippets
// fall through to proBuild after every community family has passed.
func build(name string, params map[string]any) (string, error) {
	for _, fn := range []func(string, map[string]any) (string, bool, error){
		buildFilters, buildAdjustments, buildLayerProperties, buildText, buildSelections,
		buildDocuments, buildGroups, buildLayers, buildShapes, buildHistory, buildMetadata,
		buildMasks, buildLayerTransform, buildBrushes, buildGuides, buildRetouch, buildPaths,
	} {
		if out, ok, err := fn(name, params); ok {
			return out, err
		}
	}
	// Pro-tier snippets dispatch here. In a Pro/dev build (-tags pro)
	// proBuild handles selectSubject/selectSky/…; in a CE build the
	// stub returns handled=false and we fall through to the error —
	// the edition gate that keeps Pro IP out of the CE binary.
	if s, ok, err := proBuild(name, params); ok || err != nil {
		return s, err
	}
	return "", fmt.Errorf("unknown snippet: %s", name)
}

// JSON numbers unmarshal to float64; pull a typed value with a default.
func numParam(p map[string]any, key string, def float64) float64 {
	if v, ok := p[key]; ok {
		if f, ok := v.(float64); ok {
			return f
		}
	}
	return def
}

func boolParam(p map[string]any, key string, def bool) bool {
	if v, ok := p[key]; ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return def
}

// optNumParam reports whether key was supplied alongside its typed value —
// used for snippets with an optional numeric param (e.g. setTextFont's
// fontSize) whose presence toggles a conditional fragment.
func optNumParam(p map[string]any, key string) (float64, bool) {
	if v, ok := p[key]; ok {
		if f, ok := v.(float64); ok {
			return f, true
		}
	}
	return 0, false
}

// colorParam reads a nested {r,g,b} color object (addLayerStyle's color),
// each component defaulting to 0. Missing key / wrong type → black.
func colorParam(p map[string]any, key string) (float64, float64, float64) {
	if v, ok := p[key]; ok {
		if m, ok := v.(map[string]any); ok {
			return numParam(m, "r", 0), numParam(m, "g", 0), numParam(m, "b", 0)
		}
	}
	return 0, 0, 0
}

// optStrParam reports whether key was supplied as a string — used for
// snippets with an optional name param whose presence toggles a fragment
// (newLayer/deleteLayer/duplicateLayer).
func optStrParam(p map[string]any, key string) (string, bool) {
	if v, ok := p[key]; ok {
		if s, ok := v.(string); ok {
			return s, true
		}
	}
	return "", false
}

// pointsParam reads a JSON array of {x,y} objects (selectPolygon's points).
// Missing key / wrong type → empty slice; non-object elements are skipped.
func pointsParam(p map[string]any, key string) []pointXY {
	v, ok := p[key]
	if !ok {
		return nil
	}
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]pointXY, 0, len(arr))
	for _, e := range arr {
		m, ok := e.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, pointXY{X: numParam(m, "x", 0), Y: numParam(m, "y", 0)})
	}
	return out
}

// strSliceParam reads a JSON array of strings (e.g. createGroup's layerNames).
// Missing key or wrong type → empty slice. Non-string elements are skipped.
func strSliceParam(p map[string]any, key string) []string {
	v, ok := p[key]
	if !ok {
		return nil
	}
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func strParam(p map[string]any, key string, def string) string {
	if v, ok := p[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return def
}
