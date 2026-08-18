package main

import (
	"strings"
	"testing"
)

// Enum-rejection guards. The Go core is the
// trust boundary: any slot that interpolates a caller string RAW into a JS
// identifier (BlendMode.<x>, Justification.<x>, NoiseDistribution.<x>, the
// NewDocumentMode.<x> expression) must be allow-listed HERE, not merely by the
// upstream TS schema. These pin the rejection path so a refactor that drops an
// allowlist fails the suite instead of silently reopening an injection break-out.

func TestSetLayerBlendModeRejectsInvalid(t *testing.T) {
	if _, err := setLayerBlendMode(`NORMAL; app.system("calc")`); err == nil {
		t.Fatal("setLayerBlendMode accepted an out-of-enum (break-out) value")
	}
	if _, err := setLayerBlendMode("MULTIPLY"); err != nil {
		t.Fatalf("setLayerBlendMode rejected a valid value: %v", err)
	}
}

func TestSetTextAlignmentRejectsInvalid(t *testing.T) {
	if _, err := setTextAlignment(`LEFT); evil((`); err == nil {
		t.Fatal("setTextAlignment accepted an out-of-enum (break-out) value")
	}
	if _, err := setTextAlignment("CENTER"); err != nil {
		t.Fatalf("setTextAlignment rejected a valid value: %v", err)
	}
}

// Focus Area's two load-bearing behaviours are ExtendScript-side, so the golden
// fixture is the only thing that would catch their removal — and a fixture diff
// does not say WHY it changed. Assert the intent directly.
func TestSelectFocusAreaGuardsTheCallerSelection(t *testing.T) {
	jsx, err := build("selectFocusArea", map[string]any{"selectionType": "add"})
	if err != nil {
		t.Fatalf("build(selectFocusArea) failed: %v", err)
	}
	desel := strings.Index(jsx, "doc.selection.deselect()")
	call := strings.Index(jsx, "executeAction(stringIDToTypeID('focusMask')")
	if desel < 0 || call < 0 {
		t.Fatalf("missing deselect (%d) or focusMask call (%d)", desel, call)
	}
	// focusMask leaves a prior selection untouched when it finds nothing, so the
	// probe would report the caller's OLD selection as this call's result.
	if desel > call {
		t.Fatal("the selection must be cleared BEFORE focusMask, or the post-condition probe can report a stale selection as the result")
	}
	// Having deselected, every failure exit owes the caller their selection back.
	if !strings.Contains(jsx, "__restoreAndDiscard") {
		t.Fatal("no restore-on-failure helper: a thrown Focus Area would leave the document with no selection at all")
	}
	if strings.Contains(jsx, "savedCh.remove()") {
		t.Fatal("a failure path discards the stash without restoring from it first")
	}
}

// replaceSky once interpolated a lighting-mode charID RAW into
// charIDToTypeID('%s'). That slot is GONE — Photoshop ignores the field, so the
// fragment hardcodes the captured value and the emitter takes no such argument
// (2026-08-16). This guards the removal: an unknown param must be inert, never
// reach the snippet, and never reopen a raw sink.
func TestBuildReplaceSkyIgnoresLightingMode(t *testing.T) {
	jsx, err := build("replaceSky", map[string]any{
		"skyPath":      "C:/skies/a.jpg",
		"lightingMode": `screen'); app.system("calc"); charIDToTypeID('Scrn`,
	})
	if err != nil {
		t.Fatalf("build(replaceSky) errored on an ignored param: %v", err)
	}
	if strings.Contains(jsx, "app.system") {
		t.Fatal("replaceSky leaked a caller-supplied lightingMode into the snippet")
	}
	if !strings.Contains(jsx, "charIDToTypeID('Scrn')") {
		t.Fatal("replaceSky no longer emits the captured hardcoded lighting mode")
	}
}

// A Sky Replacement with no sky asset is meaningless, and an empty path would
// reach ExtendScript as File("") and fail opaquely. Reject at the boundary.
func TestBuildReplaceSkyRequiresSkyPath(t *testing.T) {
	if _, err := build("replaceSky", map[string]any{}); err == nil {
		t.Fatal("build(replaceSky) accepted an empty param map")
	}
	if _, err := build("replaceSky", map[string]any{"skyPath": ""}); err == nil {
		t.Fatal("build(replaceSky) accepted an empty skyPath")
	}
}

func TestBuildRejectsInvalidNoiseDistribution(t *testing.T) {
	if _, err := build("applyAddNoise", map[string]any{"distribution": `UNIFORM); evil((`}); err == nil {
		t.Fatal("build(applyAddNoise) accepted an out-of-enum distribution")
	}
	if _, err := build("applyAddNoise", map[string]any{"distribution": "GAUSSIAN", "amount": 5.0}); err != nil {
		t.Fatalf("build(applyAddNoise) rejected a valid distribution: %v", err)
	}
}

func TestBuildRejectsInvalidNewDocumentMode(t *testing.T) {
	if _, err := build("newDocument", map[string]any{"colorMode": `NewDocumentMode.RGB; evil()`}); err == nil {
		t.Fatal("build(newDocument) accepted an out-of-enum colorMode")
	}
	if _, err := build("newDocument", map[string]any{
		"colorMode": "NewDocumentMode.RGB", "width": 100.0, "height": 100.0,
	}); err != nil {
		t.Fatalf("build(newDocument) rejected a valid colorMode: %v", err)
	}
}
