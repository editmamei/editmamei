package main

import (
	"strings"
	"testing"
)

// bakeLayer is a go-direct snippet (no TS twin → no golden entry). It has two
// flatten paths and a single emitted body must carry both: the multi-layer clip
// group stamps via Merge Visible (MrgV+Dplc), while a single-layer clip group
// (the active layer has nothing clipped to it) can't use MrgV — PS rejects it on
// <2 visible layers — so it duplicates + rasterizes instead. The single-layer
// fallback is the 2026-06-26 fix; this pins it so a refactor can't silently drop
// it and reintroduce the "Merge Visible is not currently available" failure. The
// geometry/appearance result is validated live against real Photoshop at the
// community live-smoke sweep (the bake-stamp step).
func TestBakeLayerEmitterCarriesBothFlattenPaths(t *testing.T) {
	out := bakeLayer()

	wants := []string{
		// Multi-layer path: stamp the visible clip group.
		`charIDToTypeID('MrgV')`,
		`charIDToTypeID('Dplc')`,
		// Single-layer fallback: branch + duplicate + rasterize, and the
		// LayerSet sub-case merges instead of rasterizing.
		`if (group.length === 1)`,
		`base.duplicate()`,
		`RasterizeType.ENTIRE`,
		`baked = baked.merge()`,
		// Shared: the baked layer is named, the clipped-count is derived (0 in
		// the single-layer case), and context is returned.
		`' (baked)'`,
		`clipped_layers_baked: group.length - 1`,
		`getContextInfo()`,
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("bakeLayer output missing %q", w)
		}
	}
}
