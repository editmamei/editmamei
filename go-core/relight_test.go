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
