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
	// The four failure exits ahead of combineWithSavedSelection (the AM call
	// itself, the post-condition probe, "selected nothing", and the rawInfo
	// measurement) must EACH restore, so a new early throw without one goes
	// uncaught by a mere Contains check. Count the CALL form, not the bare
	// name: the bare name also matches __restoreAndDiscard's own function
	// definition, so it under-counts a deleted call site by one and never
	// drops below the definition's floor of 1.
	if n := strings.Count(jsx, "__restoreAndDiscard(savedCh)"); n < 4 {
		t.Fatalf("expected at least 4 __restoreAndDiscard(savedCh) calls — the AM call failure, the post-condition probe failure, the \"selected nothing\" exit, and the rawInfo measurement failure — got %d", n)
	}
	// rawInfo (whole_canvas_selected's source) must be measured BEFORE
	// combineWithSavedSelection folds in the caller's prior selection, or the
	// flag stops describing Focus Area's raw detection and starts describing
	// whatever selection_type left behind instead.
	rawInfoIdx := strings.Index(jsx, "rawInfo = getSelectionInfo();")
	combineIdx := strings.Index(jsx, "combineWithSavedSelection(doc, savedCh, selType);")
	if rawInfoIdx < 0 || combineIdx < 0 {
		t.Fatalf("missing rawInfo measurement (%d) or combine call (%d)", rawInfoIdx, combineIdx)
	}
	if rawInfoIdx > combineIdx {
		t.Fatal("rawInfo must be measured BEFORE combineWithSavedSelection, or whole_canvas_selected reports the post-combine selection instead of the raw detection")
	}
	// whole_canvas_selected must derive from that same rawInfo measurement,
	// not a second post-combine getSelectionInfo() call — which would
	// reintroduce the exact contamination the ordering check above guards
	// against.
	if !strings.Contains(jsx, "var wholeCanvas = !!(rawInfo && rawInfo.area_percent >= 99.5);") {
		t.Fatal("whole_canvas_selected must be derived from rawInfo, not from a separate post-combine measurement")
	}
	// The reuse branch skips getSelectionInfo, and with it the
	// restoreCompositeChannel in that helper's finally. combineWithSavedSelection
	// removes the stash channel on this path, and a channel remove() does not
	// reliably leave the composite active, so the branch must restore it itself
	// or the NEXT tool call inherits a non-composite channel.
	if !strings.Contains(jsx, "if (selType === 'replace' || !savedCh) {\n      restoreCompositeChannel(doc);\n      finalInfo = rawInfo;") {
		t.Fatal("the selection_info reuse branch must restore the composite channel, since it skips getSelectionInfo's own restore")
	}
	// The reuse condition mirrors combineWithSavedSelection's early return. The
	// invariant is duplicated across two files, so pin it here: if the helper
	// ever stops no-opping under this condition, reusing rawInfo would report a
	// selection that is no longer on the document.
	// combineWithSavedSelection is inlined into this same script, so both halves
	// of the mirrored condition are pinned from one string.
	if !strings.Contains(jsx, "if (selection_type === 'replace' || !savedChannel) {") {
		t.Fatal("combineWithSavedSelection's early-return condition changed; selectFocusArea's finalInfo reuse mirrors it and must be revisited")
	}
	// The deselect must stay gated on savedCh: PS 2024+ raises an uncatchable
	// error 1302 from empty-selection access, which an unconditional deselect
	// would hit whenever the caller had nothing selected to begin with.
	if !strings.Contains(jsx, "if (savedCh) {\n      try { doc.selection.deselect(); } catch (eDesel) {}\n    }") {
		t.Fatal("the deselect must be gated on savedCh, or a caller with no prior selection hits PS's uncatchable error 1302")
	}
	// The stash is UNCONDITIONAL — taken even in replace mode, unlike the
	// sibling selectSubject/selectSky fragments, which skip it when
	// selectionType is 'replace'. Guard against "aligning" this fragment with
	// those two.
	if !strings.Contains(jsx, "var savedCh = saveSelectionToTempChannel(doc);") {
		t.Fatal("selectFocusArea must stash the caller's selection unconditionally, not mode-gated like selectSubject/selectSky")
	}
	if strings.Contains(jsx, "(selType === 'replace') ? null : saveSelectionToTempChannel(doc)") {
		t.Fatal("the stash regressed to the mode-gated form used by selectSubject/selectSky")
	}

	jsxReplace, err := build("selectFocusArea", map[string]any{"selectionType": "replace"})
	if err != nil {
		t.Fatalf("build(selectFocusArea, replace) failed: %v", err)
	}
	if !strings.Contains(jsxReplace, "var savedCh = saveSelectionToTempChannel(doc);") {
		t.Fatal("selectFocusArea must stash the caller's selection even in replace mode")
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
