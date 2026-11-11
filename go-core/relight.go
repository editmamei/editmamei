package main

import (
	"fmt"
	"strings"

	"editmamei-core/internal/vault"
)

// relightLight is one light in the descriptor's own units. The TS tool converts
// the Relight panel's percentages into these; the fragment documents the axes.
type relightLight struct {
	X, Y, Z           float64
	R, G, B           float64
	Intensity, Radius float64
}

// maxRelightLights is the Relight panel's own limit.
const maxRelightLights = 3

// relightModes are the fragment's modes (see fragments_relight.go). render is
// the paid one; the others never render.
var relightModes = map[string]bool{
	"probe": true, "render": true,
	"preview_prepare": true, "preview_open": true, "preview_restore": true,
}

// relight builds Photoshop 28's Relight (AM lightshop). Every value goes in as a
// jsNum/jsLit/jsBool literal, so nothing caller-supplied reaches the JSX
// unescaped. Slot order: getContextInfo, normNameHelper, notFoundMessageHelper,
// layerName, lights, ambient, mode, newLayer, hiddenIds, expect, expectLayerId,
// expectDocId, layerName.
func relight(layerName string, lights []relightLight, ambient float64, mode string, newLayer bool, hiddenIDs []int, expect string, expectLayerID, expectDocID int) string {
	rows := make([]string, 0, len(lights))
	for _, l := range lights {
		rows = append(rows, "["+strings.Join([]string{
			jsNum(l.X), jsNum(l.Y), jsNum(l.Z),
			jsNum(l.R), jsNum(l.G), jsNum(l.B),
			jsNum(l.Intensity), jsNum(l.Radius),
		}, ", ")+"]")
	}
	ids := make([]string, 0, len(hiddenIDs))
	for _, id := range hiddenIDs {
		ids = append(ids, jsInt(id))
	}
	return fmt.Sprintf(
		tpl[vault.Relight],
		getContextInfo(),
		normNameHelper(),
		notFoundMessageHelper(),
		jsLit(layerName),
		"["+strings.Join(rows, ", ")+"]",
		jsNum(ambient),
		jsLit(mode),
		jsBool(newLayer),
		"["+strings.Join(ids, ", ")+"]",
		jsLit(expect),
		jsInt(expectLayerID),
		jsInt(expectDocID),
		jsLit(layerName),
	)
}

// clampRange keeps a value inside [lo, hi]. The TS schema already bounds every
// input, so this only guards a direct go-core caller.
func clampRange(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// relightLightsParam reads the lights array: objects with x, y, z, r, g, b,
// intensity and radius in descriptor units. Non-object elements are skipped.
func relightLightsParam(p map[string]any) []relightLight {
	arr, ok := p["lights"].([]any)
	if !ok {
		return nil
	}
	out := make([]relightLight, 0, len(arr))
	for _, e := range arr {
		m, ok := e.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, relightLight{
			X:         clampRange(numParam(m, "x", 0), -1, 1),
			Y:         clampRange(numParam(m, "y", 0), -1, 1),
			Z:         clampRange(numParam(m, "z", 1), 0.1, 2),
			R:         clampRange(numParam(m, "r", 1), 0, 1),
			G:         clampRange(numParam(m, "g", 1), 0, 1),
			B:         clampRange(numParam(m, "b", 1), 0, 1),
			Intensity: clampRange(numParam(m, "intensity", 0.33), 0, 1),
			Radius:    clampRange(numParam(m, "radius", 0.28), 0, 0.7),
		})
	}
	return out
}

// relightHiddenIDsParam reads the layer ids preview_prepare hid. Only positive
// whole numbers are kept: they are Photoshop layer ids.
func relightHiddenIDsParam(p map[string]any) []int {
	arr, ok := p["hiddenIds"].([]any)
	if !ok {
		return nil
	}
	out := make([]int, 0, len(arr))
	for _, e := range arr {
		if f, ok := e.(float64); ok && f >= 1 && f == float64(int(f)) {
			out = append(out, int(f))
		}
	}
	return out
}

// buildRelight is the registry entry: validates the mode and light count, then
// emits. preview_restore needs no lights.
func buildRelight(params map[string]any) (string, error) {
	mode := strParam(params, "mode", "render")
	if !relightModes[mode] {
		return "", fmt.Errorf("relight: unknown mode %q", mode)
	}
	expect := strParam(params, "expect", "")
	if expect != "" && expect != "edit" && expect != "new" {
		return "", fmt.Errorf("relight: expect must be edit, new or empty, got %q", expect)
	}
	expectLayerID := positiveIntParam(params, "expectLayerId")
	expectDocID := positiveIntParam(params, "expectDocId")
	lights := relightLightsParam(params)
	if mode != "preview_restore" && len(lights) == 0 {
		return "", fmt.Errorf("relight: at least one light is required")
	}
	if len(lights) > maxRelightLights {
		return "", fmt.Errorf("relight: at most %d lights, got %d", maxRelightLights, len(lights))
	}
	return relight(
		strParam(params, "layerName", ""),
		lights,
		clampRange(numParam(params, "ambient", 0.8), 0, 1),
		mode,
		boolParam(params, "newLayer", false),
		relightHiddenIDsParam(params),
		expect,
		expectLayerID,
		expectDocID,
	), nil
}

// positiveIntParam reads a Photoshop id; anything but a whole number >= 1 is 0
// (no check).
func positiveIntParam(p map[string]any, key string) int {
	if f := numParam(p, key, 0); f >= 1 && f <= 1<<31-1 && f == float64(int(f)) {
		return int(f)
	}
	return 0
}
