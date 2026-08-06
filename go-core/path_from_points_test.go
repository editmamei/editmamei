package main

import (
	"strings"
	"testing"
)

// createPathFromPoints — the grounded pen (ps_path create_from_placement). A new
// go-direct snippet (no TS twin → no golden entry). These assertions pin the
// load-bearing DOM path-construction tokens; the path actually landing is
// validated live against real Photoshop (the tier process requires it, since a
// unit test can only string-match — it can't catch a silent-no-op pathItems.add).

func TestCreatePathFromPointsEmitter(t *testing.T) {
	out := createPathFromPoints("Jawline", []pointXY{{X: 10, Y: 20}, {X: 100, Y: 200}, {X: 300, Y: 120}}, false)

	wants := []string{
		`var __cp_name = "Jawline";`,         // jsLit-escaped name (injection guard)
		`new PathPointInfo()`,                // per-anchor construction
		`PointKind.CORNERPOINT`,              // resolved curve is a polyline → corner points (no handles)
		`__bw_p0.anchor = [10, 20];`,         // first anchor
		`__bw_p0.leftDirection = [10, 20];`,  // handles coincide with the anchor
		`__bw_p0.rightDirection = [10, 20];`, // (a faithful polyline vertex)
		`__bw_p2.anchor = [300, 120];`,       // last anchor
		`var __cp_sub = new SubPathInfo();`,
		`__cp_sub.closed = false;`,
		`__cp_sub.operation = ShapeOperation.SHAPEADD;`,
		`__cp_sub.entireSubPath = [__bw_p0, __bw_p1, __bw_p2];`,
		`doc.pathItems.add(__cp_name, [__cp_sub])`, // the saved-path creation
		`created: true`,
		`anchors: 3`, // point count returned so the caller can verify the path landed
		`path_info: getPathInfo()`,
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("createPathFromPoints output missing %q", w)
		}
	}
}

func TestCreatePathFromPointsClosedAndEscape(t *testing.T) {
	// A closed loop + a name containing a quote: sub.closed flips true, and the name
	// MUST be jsLit-escaped (injection guard) — never interpolated raw.
	out := createPathFromPoints(`a"b`, []pointXY{{X: 0, Y: 0}, {X: 1, Y: 1}}, true)
	if !strings.Contains(out, `__cp_sub.closed = true;`) {
		t.Error("closed path should set sub.closed = true")
	}
	if strings.Contains(out, `var __cp_name = "a"b";`) {
		t.Error("path name must be jsLit-escaped, not interpolated raw (injection guard)")
	}
}
