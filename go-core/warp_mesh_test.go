package main

import (
	"strings"
	"testing"
)

// warpMesh is a new go-direct snippet (no TS twin → no golden entry). These
// assertions pin the load-bearing descriptor tokens + the two drive modes; the
// geometry itself is validated live against real Photoshop (the weld check) at
// tier-promotion time.

func TestWarpMeshEmitterHighLevel(t *testing.T) {
	out := warpMesh("left", 6, 2, -1700, 0.7, 0.85, 0.4, "")

	wants := []string{
		`var PIN = "left";`,      // jsLit-escaped (injection guard)
		`var NCX = 6, NCY = 2;`,  // cell counts injected as ints
		`var LIFT = -1700`,       // shape params via jsNum
		`var RAW = null;`,        // high-level path → no raw grid
		`charIDToTypeID('Trnf')`, // the transform event
		`stringIDToTypeID('warpCustom')`,
		`stringIDToTypeID('quiltWarp')`,
		`stringIDToTypeID('customEnvelopeWarp')`,
		`stringIDToTypeID('meshPoints')`,
		`stringIDToTypeID('rationalPoint')`,
		`stringIDToTypeID('quiltSliceX')`,
		`stringIDToTypeID('quiltSliceY')`,
		`stringIDToTypeID('deformNumCols')`,
		`pinned_edge_held`, // weld self-check returned to the caller
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("high-level warpMesh output missing %q", w)
		}
	}

	// The quilt carries the deformation; the sibling warp obj is warpNone — that
	// pairing is the quilt-vs-simple discriminator (ground truth).
	if !strings.Contains(out, `stringIDToTypeID('warpNone')`) {
		t.Error("warpMesh should emit warpNone on the (non-quilt) warp object")
	}
}

func TestWarpMeshEmitterRawPath(t *testing.T) {
	raw := warpMesh("top", 1, 1, 0, 0, 0, 1, "[[0,0],[1,2]]")
	if !strings.Contains(raw, `var RAW = [[0,0],[1,2]];`) {
		t.Error("raw warpMesh should inject the supplied mesh literal verbatim into RAW")
	}
	if !strings.Contains(raw, `var PIN = "top";`) {
		t.Error("raw warpMesh missing pin_edge 'top'")
	}
}

func TestMeshPointsLiteral(t *testing.T) {
	got := meshPointsLiteral([]pointXY{{X: 0, Y: 0}, {X: 10.5, Y: -3}})
	want := "[[0,0],[10.5,-3]]"
	if got != want {
		t.Errorf("meshPointsLiteral = %q, want %q", got, want)
	}
}
