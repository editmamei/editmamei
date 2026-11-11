package main

import (
	"strings"
	"testing"
)

func relightParams(lights ...map[string]any) map[string]any {
	arr := make([]any, len(lights))
	for i, l := range lights {
		arr[i] = l
	}
	return map[string]any{"lights": arr, "ambient": 0.8}
}

// The panel allows one to three lights; anything else must fail before a render
// (each render costs the user credits).
func TestBuildRelightLightCount(t *testing.T) {
	if _, err := build("relight", map[string]any{}); err == nil {
		t.Fatal("build(relight) accepted no lights")
	}
	one := map[string]any{"x": 0.5}
	if _, err := build("relight", relightParams(one, one, one, one)); err == nil {
		t.Fatal("build(relight) accepted four lights")
	}
	if _, err := build("relight", relightParams(one, one, one)); err != nil {
		t.Fatalf("build(relight) refused three lights: %v", err)
	}
}

// Every light value lands as a number in the lights literal, clamped to the
// descriptor's range, and the event is the captured lightshop.
func TestBuildRelightEmitsClampedLights(t *testing.T) {
	jsx, err := build("relight", relightParams(map[string]any{
		"x": 0.5, "y": -0.25, "z": 9.0, "r": 1.0, "g": 0.5, "b": 0.25,
		"intensity": 0.3, "radius": 0.9,
	}))
	if err != nil {
		t.Fatalf("build(relight) failed: %v", err)
	}
	if strings.Contains(jsx, "%!") {
		t.Fatal("relight has a slot-arity mismatch (a %! verb in the output)")
	}
	if !strings.Contains(jsx, "var lights = [[0.5, -0.25, 2, 1, 0.5, 0.25, 0.3, 0.7]];") {
		t.Fatal("relight did not emit the clamped lights literal")
	}
	if !strings.Contains(jsx, "stringIDToTypeID('lightshop')") {
		t.Fatal("relight no longer emits the lightshop event")
	}
	if !strings.Contains(jsx, "var ambient = 0.8;") {
		t.Fatal("relight did not emit the original-lighting value")
	}
}

func TestBuildRelightModes(t *testing.T) {
	for _, mode := range []string{"probe", "render", "preview_prepare", "preview_open"} {
		p := relightParams(map[string]any{"x": 0})
		p["mode"] = mode
		jsx, err := build("relight", p)
		if err != nil {
			t.Fatalf("mode %s: %v", mode, err)
		}
		if !strings.Contains(jsx, "var mode = \""+mode+"\";") {
			t.Fatalf("mode %s not emitted", mode)
		}
		if strings.Contains(jsx, "%!") {
			t.Fatalf("mode %s: slot-arity mismatch", mode)
		}
	}
	p := relightParams(map[string]any{"x": 0})
	p["mode"] = "render_twice"
	if _, err := build("relight", p); err == nil {
		t.Fatal("an unknown mode was accepted")
	}
	// Restoring hidden layers needs no lights.
	if _, err := build("relight", map[string]any{"mode": "preview_restore", "hiddenIds": []any{4.0}}); err != nil {
		t.Fatalf("preview_restore without lights: %v", err)
	}
}

// The panel only charges on Done; the preview opens it with DialogModes.ALL and
// the render never does.
func TestBuildRelightDialogModes(t *testing.T) {
	jsx, err := build("relight", relightParams(map[string]any{"x": 0}))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"executeAction(stringIDToTypeID('lightshop'), desc, DialogModes.ALL);",
		"executeAction(stringIDToTypeID('lightshop'), desc, DialogModes.NO);",
		"if (mode === 'preview_open') {",
	} {
		if !strings.Contains(jsx, want) {
			t.Fatalf("missing %q", want)
		}
	}
	// ALL appears only inside the preview_open branch, which returns before the
	// render.
	if strings.Index(jsx, "DialogModes.ALL") > strings.Index(jsx, "desc, DialogModes.NO)") {
		t.Fatal("the paid render must come after the preview branch returns")
	}
}

// Edit in place targets the LAYER; a new Relight layer targets the DOCUMENT.
// newLayer forces the document target even on a Relight layer.
func TestBuildRelightEditReference(t *testing.T) {
	p := relightParams(map[string]any{"x": 0})
	p["newLayer"] = true
	jsx, err := build("relight", p)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"var newLayer = true;",
		"var edit = isRelight && !newLayer;",
		"stringIDToTypeID('LightshopVersion')",
		"targetRef.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));",
		"targetRef.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));",
	} {
		if !strings.Contains(jsx, want) {
			t.Fatalf("missing %q", want)
		}
	}
	jsx, _ = build("relight", relightParams(map[string]any{"x": 0}))
	if !strings.Contains(jsx, "var newLayer = false;") {
		t.Fatal("newLayer should default to false")
	}
}

// Only whole positive layer ids reach the restore list.
func TestBuildRelightHiddenIDs(t *testing.T) {
	jsx, err := build("relight", map[string]any{
		"mode":      "preview_restore",
		"hiddenIds": []any{3.0, 7.0, -1.0, 2.5, "x); app.system('calc'", 12.0},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(jsx, "var hiddenIds = [3, 7, 12];") {
		t.Fatal("hiddenIds were not filtered to layer ids")
	}
}

// A layer name goes through jsLit, so a hostile name can't break out of the
// string literal.
func TestBuildRelightEscapesLayerName(t *testing.T) {
	p := relightParams(map[string]any{"x": 0})
	p["layerName"] = `x'); app.system("calc"); ('`
	jsx, err := build("relight", p)
	if err != nil {
		t.Fatalf("build(relight) failed: %v", err)
	}
	if strings.Contains(jsx, `'); app.system("calc")`) {
		t.Fatal("relight interpolated a layer name without escaping it")
	}
}
