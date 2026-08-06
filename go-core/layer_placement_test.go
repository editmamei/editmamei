package main

import (
	"strings"
	"testing"
)

// Phase 4 (layer-placement bug) coverage. Neither the Vitest harness (which
// only ever sees the {name, params} handed to snippetClient.build(), routed
// through FakeSnippetClient — it never invokes the Go binary) nor the golden
// tests (string-compare against a frozen TS-side snapshot) can observe
// whether a fragment actually emits the hoist/parent-reporting code for a
// given call. This file asserts directly against the Go emitter output,
// which is the one place that IS observable: does the fragment carry the
// hoist call and the parent_path report, and does into_active_group:true
// flip the interpolated boolean (suppressing the hoist)?
//
// Where PS actually PUTS the layer is validated live — see the community
// live-smoke scenario's "group nesting" step, not here.

func TestAddAdjustmentLayerCarriesHoistAndParentPath(t *testing.T) {
	outDefault, err := addAdjustmentLayer("invert", false, "", false, map[string]any{}, true, false, false)
	if err != nil {
		t.Fatalf("addAdjustmentLayer: %v", err)
	}
	wants := []string{
		`var __preMkActive = doc.activeLayer;`,
		`__hoistFromActiveGroupIfNeeded(doc, __preMkActive, newLayer, __intoActiveGroup);`,
		`__parentPathOf(doc, newLayer)`,
		// F8 (2026-07 QA review): __hoisted is computed but must also be
		// RETURNED — a failed hoist (newLayer.move throwing) was previously
		// invisible: the tool reported success while silently violating its
		// documented placement.
		`hoisted: __hoisted,`,
	}
	for _, w := range wants {
		if !strings.Contains(outDefault, w) {
			t.Errorf("addAdjustmentLayer output missing %q", w)
		}
	}
	if !strings.Contains(outDefault, `var __intoActiveGroup = false;`) {
		t.Errorf("addAdjustmentLayer default (into_active_group omitted) should emit __intoActiveGroup = false")
	}
	// hoisted must be returned on BOTH return sites (the clipping-failed
	// early return and the success path).
	if got := strings.Count(outDefault, `hoisted: __hoisted,`); got != 2 {
		t.Errorf("addAdjustmentLayer must return hoisted on both return sites, got %d occurrences", got)
	}

	outIntoGroup, err := addAdjustmentLayer("invert", false, "", false, map[string]any{}, true, false, true)
	if err != nil {
		t.Fatalf("addAdjustmentLayer: %v", err)
	}
	if !strings.Contains(outIntoGroup, `var __intoActiveGroup = true;`) {
		t.Errorf("addAdjustmentLayer(intoActiveGroup=true) should emit __intoActiveGroup = true (suppresses the hoist at runtime)")
	}
}

func TestCreateGroupCarriesHoistAndParentPath(t *testing.T) {
	outDefault := createGroup("edits", nil, false)
	wants := []string{
		`var __preMkActive = doc.activeLayer;`,
		`__hoistFromActiveGroupIfNeeded(doc, __preMkActive, newGroup, __intoActiveGroup);`,
		`__parentPathOf(doc, newGroup)`,
		`var __intoActiveGroup = false;`,
		// F8 (2026-07 QA review): return hoisted so a failed hoist isn't invisible.
		`hoisted: __hoisted,`,
	}
	for _, w := range wants {
		if !strings.Contains(outDefault, w) {
			t.Errorf("createGroup output missing %q", w)
		}
	}

	outIntoGroup := createGroup("edits", nil, true)
	if !strings.Contains(outIntoGroup, `var __intoActiveGroup = true;`) {
		t.Errorf("createGroup(intoActiveGroup=true) should emit __intoActiveGroup = true")
	}
}

func TestAddFillLayerCarriesHoistAndParentPath(t *testing.T) {
	outDefault := addFillLayer(255, 0, 0, false)
	wants := []string{
		`var __preMkActive = doc.activeLayer;`,
		`__hoistFromActiveGroupIfNeeded(doc, __preMkActive, __newLayer, __intoActiveGroup);`,
		`__parentPathOf(doc, __newLayer)`,
		`var __intoActiveGroup = false;`,
		// F8 (2026-07 QA review): return hoisted so a failed hoist isn't invisible.
		`hoisted: __hoisted,`,
	}
	for _, w := range wants {
		if !strings.Contains(outDefault, w) {
			t.Errorf("addFillLayer output missing %q", w)
		}
	}

	outIntoGroup := addFillLayer(255, 0, 0, true)
	if !strings.Contains(outIntoGroup, `var __intoActiveGroup = true;`) {
		t.Errorf("addFillLayer(intoActiveGroup=true) should emit __intoActiveGroup = true")
	}
}

func TestLayerViaCopyCarriesHoistAndParentPath(t *testing.T) {
	outDefault := layerViaCopy(false)
	wants := []string{
		`var __preMkActive = doc.activeLayer;`,
		`__hoistFromActiveGroupIfNeeded(doc, __preMkActive, __newLayer, __intoActiveGroup);`,
		`__parentPathOf(doc, __newLayer)`,
		`var __intoActiveGroup = false;`,
		// F8 (2026-07 QA review): return hoisted so a failed hoist isn't invisible.
		`hoisted: __hoisted,`,
	}
	for _, w := range wants {
		if !strings.Contains(outDefault, w) {
			t.Errorf("layerViaCopy output missing %q", w)
		}
	}

	outIntoGroup := layerViaCopy(true)
	if !strings.Contains(outIntoGroup, `var __intoActiveGroup = true;`) {
		t.Errorf("layerViaCopy(intoActiveGroup=true) should emit __intoActiveGroup = true")
	}
}

// F9 (2026-07 QA review) — copied_to_new_layer used to derive from
// doc.layers.length (top-level only), so with into_active_group:true a
// successful copy that landed INSIDE an existing group reported false (the
// top-level count is unchanged by a nested addition). Fixed to use
// __countLayersRecursive, which is in scope via the interpolated
// getContextInfo helper.
func TestLayerViaCopyUsesRecursiveLayerCount(t *testing.T) {
	out := layerViaCopy(true)
	wants := []string{
		`var beforeLayerCount = __countLayersRecursive(doc.layers);`,
		`var afterLayerCount = __countLayersRecursive(doc.layers);`,
		`copied_to_new_layer: afterLayerCount > beforeLayerCount,`,
		`layer_count_before: beforeLayerCount,`,
		`layer_count_after: afterLayerCount,`,
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("layerViaCopy output missing %q", w)
		}
	}
	if strings.Contains(out, `doc.layers.length > beforeLayerCount`) {
		t.Error("layerViaCopy must not derive copied_to_new_layer from the shallow doc.layers.length comparison anymore")
	}
}

func TestCreateShapeCarriesHoistAndParentPath(t *testing.T) {
	outDefault := createShape("rectangle", 0, 0, 100, 100, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, false)
	wants := []string{
		`var __preMkActive = doc.activeLayer;`,
		`__hoistFromActiveGroupIfNeeded(doc, __preMkActive, __layer, __intoActiveGroup);`,
		`__parentPathOf(doc, __layer)`,
		`var __intoActiveGroup = false;`,
		// F8 (2026-07 QA review): return hoisted so a failed hoist isn't invisible.
		`hoisted: __hoisted,`,
	}
	for _, w := range wants {
		if !strings.Contains(outDefault, w) {
			t.Errorf("createShape output missing %q", w)
		}
	}

	outIntoGroup := createShape("rectangle", 0, 0, 100, 100, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, true)
	if !strings.Contains(outIntoGroup, `var __intoActiveGroup = true;`) {
		t.Errorf("createShape(intoActiveGroup=true) should emit __intoActiveGroup = true")
	}
}

// The DOM-based creators (newLayer, duplicateLayer, createTextLayer) do NOT
// nest inside an active group (newLayer/createTextLayer, measured live) or
// are parent-preserving by DOM semantics (duplicateLayer) — no hoist is
// needed or emitted for them. Only parent_path reporting is required.

func TestNewLayerCarriesParentPathNoHoist(t *testing.T) {
	out := newLayer("Dodge", true)
	if !strings.Contains(out, `__parentPathOf(doc, layer)`) {
		t.Errorf("newLayer output missing parent_path reporting")
	}
	if strings.Contains(out, `__hoistFromActiveGroupIfNeeded`) {
		t.Errorf("newLayer should not emit hoist logic (doc.artLayers.add() does not nest)")
	}
}

func TestDuplicateLayerCarriesParentPathNoHoist(t *testing.T) {
	out := duplicateLayer("Backup", true)
	if !strings.Contains(out, `__parentPathOf(doc, duplicated)`) {
		t.Errorf("duplicateLayer output missing parent_path reporting")
	}
	if strings.Contains(out, `__hoistFromActiveGroupIfNeeded`) {
		t.Errorf("duplicateLayer should not emit hoist logic (layer.duplicate() is parent-preserving)")
	}
}

func TestCreateTextLayerCarriesParentPathNoHoist(t *testing.T) {
	out := createTextLayer("Hello", 100, 100, 24)
	if !strings.Contains(out, `__parentPathOf(doc, textLayer)`) {
		t.Errorf("createTextLayer output missing parent_path reporting")
	}
	if strings.Contains(out, `__hoistFromActiveGroupIfNeeded`) {
		t.Errorf("createTextLayer should not emit hoist logic (doc.artLayers.add() does not nest)")
	}
}

// getContextInfo / getMetadata (4c): layerCount stays as-is (compat); a
// genuine recursive total_layer_count is added alongside it.
func TestContextAndMetadataCarryTotalLayerCount(t *testing.T) {
	ctx := getContextInfo()
	if !strings.Contains(ctx, `function __countLayersRecursive(layers)`) {
		t.Errorf("getContextInfo output missing __countLayersRecursive definition")
	}
	if !strings.Contains(ctx, `layerCount: doc.layers.length,`) {
		t.Errorf("getContextInfo should keep layerCount as-is (compat) — do not rename")
	}
	if !strings.Contains(ctx, `total_layer_count: __countLayersRecursive(doc.layers)`) {
		t.Errorf("getContextInfo output missing total_layer_count")
	}

	meta := getMetadata(true, false, false)
	if !strings.Contains(meta, `layer_count: doc.layers.length,`) {
		t.Errorf("getMetadata should keep layer_count as-is (compat) — do not rename")
	}
	if !strings.Contains(meta, `total_layer_count: __countLayersRecursive(doc.layers)`) {
		t.Errorf("getMetadata output missing total_layer_count")
	}
}
